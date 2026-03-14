# File Server API Reference

The usemyclaw.com PWA includes a workspace file browser that connects to a file server sidecar running on your machine. This document covers everything needed to set up a compatible file server.

## Overview

The file server is a simple HTTP API that serves workspace files. It runs alongside the OpenClaw gateway and provides read/write access to the workspace directory (`~/.openclaw/workspace` by default).

**Reference implementation:** [`file-server.js`](./file-server.js) (zero-dependency Node.js server)

## Connection

### How the PWA finds your file server

The PWA auto-derives the file server URL from your gateway URL by changing the port to **18795**:

| Gateway URL | File server URL (auto-derived) |
|---|---|
| `wss://my-server.ts.net` | `https://my-server.ts.net:18795` |
| `wss://my-server.ts.net:443` | `https://my-server.ts.net:18795` |
| `ws://192.168.1.50:18789` | `http://192.168.1.50:18795` |

The file server itself can run on any port locally. Use Tailscale Serve to expose it on port 18795:

```bash
# Example: file server runs locally on port 18790
tailscale serve --bg --https 18795 http://127.0.0.1:18790
```

### Connection sequence

1. PWA extracts gateway hostname from your saved connection
2. Replaces port with `18795`
3. Calls `GET /health` to verify connectivity
4. If healthy, loads the file tree via `GET /api/files/`
5. Starts polling open files for changes every ~4 seconds

## API Endpoints

### Health Check

```
GET /health
```

**Response:** `200 OK`
```json
{
  "ok": true,
  "workspace": "/home/user/.openclaw/workspace",
  "port": 18790
}
```

The `workspace` and `port` fields are informational. The PWA only checks that `ok` is `true`.

---

### List Directory Tree

```
GET /api/files/
GET /api/files/{directory-path}
```

Returns a recursive tree of the workspace (or a subdirectory).

**Response:** `200 OK`
```json
[
  {
    "name": "Memos",
    "path": "Memos",
    "type": "dir",
    "children": [
      {
        "name": "note.md",
        "path": "Memos/note.md",
        "type": "file",
        "size": 1234,
        "mtime": 1710000000000
      }
    ]
  },
  {
    "name": "README.md",
    "path": "README.md",
    "type": "file",
    "size": 567,
    "mtime": 1710000000000
  }
]
```

**Rules:**
- `path` is relative to workspace root
- `mtime` is milliseconds since epoch (e.g., `Date.now()`)
- `size` is bytes
- Sort: directories first, then alphabetical (case-insensitive)
- Exclude: `.git`, `node_modules`, `.DS_Store`, `.obsidian`, `__pycache__`

---

### Read File

```
GET /api/files/{path}
```

Returns the file content as text.

**Response:** `200 OK`
```
Content-Type: text/markdown
X-File-Mtime: 1710000000000
Last-Modified: Sat, 14 Mar 2026 09:00:00 GMT

# File content here...
```

**Required response headers:**
| Header | Description |
|---|---|
| `Content-Type` | MIME type (see table below) |
| `X-File-Mtime` | Millisecond timestamp of last modification |
| `Last-Modified` | HTTP date of last modification |

**MIME types by extension:**
| Extension | MIME Type |
|---|---|
| `.md` | `text/markdown` |
| `.txt` | `text/plain` |
| `.json` | `application/json` |
| `.js` | `text/javascript` |
| `.ts` | `text/typescript` |
| `.py` | `text/x-python` |
| `.html` | `text/html` |
| `.css` | `text/css` |
| `.yaml` / `.yml` | `text/yaml` |
| `.sh` | `text/x-sh` |
| `.xml` | `text/xml` |
| `.csv` | `text/csv` |
| `.log` / `.ini` | `text/plain` |
| (other) | `text/plain` |

**Error:** `404` if file not found
```json
{ "error": "Not found" }
```

---

### Check File (Head Request)

```
HEAD /api/files/{path}
```

Same as GET but without the body. Used for polling file changes (~every 4 seconds for open tabs).

**Response:** `200 OK` with the same headers as GET (`X-File-Mtime`, `Content-Type`, etc.)

The PWA compares `X-File-Mtime` against its cached value. If the server's mtime is >2 seconds newer than what the PWA has, it shows an "externally changed" banner.

---

### Save File

```
PUT /api/files/{path}
Content-Type: text/plain

Raw file content here...
```

**Response:** `200 OK`
```json
{
  "ok": true,
  "mtime": 1710000000000
}
```

**Required headers in response:**
| Header | Description |
|---|---|
| `X-File-Mtime` | Millisecond timestamp after save |

**Behavior:**
- Creates parent directories if they don't exist
- Overwrites existing files
- Returns the new `mtime` so the PWA can track changes

**Error:** `500`
```json
{ "error": "Permission denied" }
```

---

### Preflight (CORS)

```
OPTIONS /any-path
```

**Response:** `204 No Content` with CORS headers.

---

## CORS Headers (Required)

Every response must include these headers:

```
Access-Control-Allow-Origin: <request-origin>
Access-Control-Allow-Methods: GET, PUT, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Expose-Headers: X-File-Mtime, Last-Modified
Access-Control-Allow-Private-Network: true
```

### Private Network Access (Chrome)

When the PWA runs on `https://usemyclaw.com` (public origin) and reaches your file server on a private/Tailscale IP, Chrome enforces [Private Network Access](https://developer.chrome.com/blog/private-network-access-update) rules.

Required headers for PNA:
```
Access-Control-Allow-Private-Network: true
Private-Network-Access-Name: OpenClaw File Server
Private-Network-Access-ID: 4F:43:46:53:52:56
```

The user may also need to allow local network access in Chrome's address bar settings for the site.

### Origin Echoing

For Chrome PNA compatibility, echo the specific request `Origin` header back in `Access-Control-Allow-Origin` rather than using `*`:

```javascript
const origin = req.headers["origin"];
res.setHeader("Access-Control-Allow-Origin", origin || "*");
```

## Security

### Directory Traversal Prevention

Always validate that resolved file paths stay within the workspace root:

```javascript
const fullPath = path.join(WORKSPACE, relPath);
if (!fullPath.startsWith(WORKSPACE)) {
  return res.status(403).json({ error: "Access denied" });
}
```

### Binding

The reference server binds to `127.0.0.1` (loopback only). External access should go through Tailscale Serve, which handles authentication via Tailscale's identity system.

## WebSocket (Optional)

The reference server includes a WebSocket endpoint at `/ws` for real-time file change notifications, but **the PWA does not use it**. It relies on HTTP polling instead, because Tailscale Serve doesn't reliably proxy WebSocket connections on subpaths.

You can skip WebSocket support entirely.

## Quick Start

### Option 1: Use the reference server (recommended)

```bash
# Clone the repo
git clone https://github.com/humanitylabs-org/openclaw-chat.git
cd openclaw-chat

# Run the file server
node file-server.js --port 18790 --workspace ~/.openclaw/workspace

# Expose via Tailscale Serve on port 18795
tailscale serve --bg --https 18795 http://127.0.0.1:18790
```

### Option 2: Build your own

Implement these 5 endpoints:
1. `GET /health` → `{ "ok": true }`
2. `GET /api/files/` → directory tree JSON
3. `GET /api/files/{path}` → file content + `X-File-Mtime` header
4. `HEAD /api/files/{path}` → same headers, no body
5. `PUT /api/files/{path}` → save file, return `{ "ok": true, "mtime": ... }`

Add CORS + PNA headers to every response. Bind to loopback. Expose via Tailscale Serve on port 18795.

## Troubleshooting

| Problem | Solution |
|---|---|
| PWA can't find file server | Verify it's accessible on port 18795 of the same hostname as your gateway |
| CORS errors in console | Check that `Access-Control-Allow-Origin` echoes the request origin |
| Chrome blocks "local network" | Click ⚙ in address bar → Allow "Access other devices on your local network" |
| File tree empty | Check that `/api/files/` returns valid JSON array |
| Changes not detected | Ensure `X-File-Mtime` header returns millisecond timestamps |
| Status dot yellow ("Chat only") | File server not reachable — check Tailscale Serve config |
