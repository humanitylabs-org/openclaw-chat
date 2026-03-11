#!/usr/bin/env node
// OpenClaw File Server Sidecar
// Zero dependencies - uses only Node built-in modules
// Serves workspace files over HTTP + WebSocket for change notifications
// Usage: node file-server.js [--port 18790] [--workspace /path/to/workspace]

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

// Parse CLI args
const args = process.argv.slice(2);
let PORT = 18790;
let WORKSPACE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  ".openclaw",
  "workspace"
);

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) PORT = parseInt(args[i + 1], 10);
  if (args[i] === "--workspace" && args[i + 1])
    WORKSPACE = path.resolve(args[i + 1]);
}

if (!fs.existsSync(WORKSPACE)) {
  console.error(`Workspace not found: ${WORKSPACE}`);
  process.exit(1);
}

console.log(`File server starting on port ${PORT}`);
console.log(`Workspace: ${WORKSPACE}`);

// ─── WebSocket clients ──────────────────────────────────────────────
const wsClients = new Set();

// ─── File watcher ───────────────────────────────────────────────────
const watchers = new Map();
const IGNORE = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  ".obsidian",
  "__pycache__",
]);

function watchDir(dirPath) {
  if (watchers.has(dirPath)) return;
  try {
    const watcher = fs.watch(dirPath, (eventType, filename) => {
      if (!filename || IGNORE.has(filename)) return;
      const fullPath = path.join(dirPath, filename);
      const relPath = path.relative(WORKSPACE, fullPath);
      try {
        const stat = fs.statSync(fullPath);
        broadcast({
          type: "change",
          path: relPath,
          mtime: stat.mtimeMs,
          isDir: stat.isDirectory(),
        });
        // Watch new directories
        if (stat.isDirectory()) watchRecursive(fullPath);
      } catch {
        // File was deleted
        broadcast({ type: "delete", path: relPath });
      }
    });
    watchers.set(dirPath, watcher);
  } catch {
    // Permission denied or path gone
  }
}

function watchRecursive(dirPath) {
  watchDir(dirPath);
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      if (entry.isDirectory()) {
        watchRecursive(path.join(dirPath, entry.name));
      }
    }
  } catch {
    // ignore
  }
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    try {
      wsSend(ws, data);
    } catch {
      wsClients.delete(ws);
    }
  }
}

// ─── Directory tree builder ─────────────────────────────────────────
function buildTree(dirPath, relativeTo) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (IGNORE.has(entry.name) || entry.name.startsWith(".")) continue;
    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(relativeTo, fullPath);
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: relPath,
        type: "dir",
        children: buildTree(fullPath, relativeTo),
      });
    } else {
      try {
        const stat = fs.statSync(fullPath);
        result.push({
          name: entry.name,
          path: relPath,
          type: "file",
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      } catch {
        // skip
      }
    }
  }
  // Sort: dirs first, then alphabetical
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return result;
}

// ─── Minimal WebSocket implementation (RFC 6455) ────────────────────
function wsSend(socket, data) {
  const payload = Buffer.from(data, "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // text frame, FIN
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function parseWSFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    const mask = buf.slice(offset, offset + 4);
    offset += 4;
    const data = buf.slice(offset, offset + payloadLen);
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    return { opcode, data, totalLen: offset + payloadLen };
  }
  if (buf.length < offset + payloadLen) return null;
  return {
    opcode,
    data: buf.slice(offset, offset + payloadLen),
    totalLen: offset + payloadLen,
  };
}

// ─── HTTP Server ────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, PUT, POST, DELETE, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-File-Mtime, Last-Modified"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(parsed.pathname);

  // Strip /files prefix when proxied through Tailscale Serve (e.g. /files/health -> /health)
  if (pathname.startsWith("/files")) {
    pathname = pathname.slice(6) || "/";
  }

  // API routes
  if (pathname.startsWith("/api/files")) {
    const relPath = pathname.replace(/^\/api\/files\/?/, "");
    const fullPath = path.join(WORKSPACE, relPath);

    // Security: prevent directory traversal
    if (!fullPath.startsWith(WORKSPACE)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Access denied" }));
    }

    if (req.method === "GET" || req.method === "HEAD") {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          // Return tree for this directory
          const tree =
            relPath === "" ? buildTree(WORKSPACE, WORKSPACE) : buildTree(fullPath, WORKSPACE);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(tree));
        }
        // Return file content
        const content = fs.readFileSync(fullPath, "utf8");
        res.writeHead(200, {
          "Content-Type": getMimeType(fullPath),
          "Last-Modified": stat.mtime.toUTCString(),
          "X-File-Mtime": String(stat.mtimeMs),
        });
        return res.end(content);
      } catch (e) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Not found" }));
      }
    }

    if (req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          // Create parent dirs if needed
          const dir = path.dirname(fullPath);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fullPath, body, "utf8");
          const stat = fs.statSync(fullPath);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "X-File-Mtime": String(stat.mtimeMs),
          });
          res.end(JSON.stringify({ ok: true, mtime: stat.mtimeMs }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  // Health check
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({ ok: true, workspace: WORKSPACE, port: PORT })
    );
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// ─── WebSocket Upgrade ──────────────────────────────────────────────
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-5AB5DC525C11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n"
  );

  wsClients.add(socket);
  console.log(`WS client connected (${wsClients.size} total)`);

  let buffer = Buffer.alloc(0);

  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (true) {
      const frame = parseWSFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.totalLen);
      if (frame.opcode === 0x08) {
        // Close
        wsClients.delete(socket);
        socket.end();
        return;
      }
      if (frame.opcode === 0x09) {
        // Ping -> Pong
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a;
        pong[1] = 0;
        socket.write(pong);
      }
    }
  });

  socket.on("close", () => {
    wsClients.delete(socket);
    console.log(`WS client disconnected (${wsClients.size} total)`);
  });

  socket.on("error", () => {
    wsClients.delete(socket);
  });
});

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".py": "text/x-python",
    ".html": "text/html",
    ".css": "text/css",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".toml": "text/toml",
    ".sh": "text/x-sh",
    ".xml": "text/xml",
    ".csv": "text/csv",
    ".log": "text/plain",
    ".ini": "text/plain",
  };
  return types[ext] || "text/plain";
}

// Start
watchRecursive(WORKSPACE);
const BIND = "127.0.0.1";
server.listen(PORT, BIND, () => {
  console.log(`File server running at http://${BIND}:${PORT} (loopback only)`);
  console.log(`Access via Tailscale Serve HTTPS proxy`);
  console.log(
    `Watching ${watchers.size} directories for changes`
  );
});
