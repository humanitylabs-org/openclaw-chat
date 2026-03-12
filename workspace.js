// ─── Workspace Panels: File Tree + Markdown Editor ──────────────────
// Integrates with file-server.js sidecar via HTTP + WebSocket
// Zero dependencies, pure vanilla JS

const workspace = {
  fileServerUrl: "",
  fileServerWs: null,
  tree: [],
  openTabs: [],       // [{path, name, content, mtime, dirty}]
  activeTabIdx: -1,
  editMode: false,
  currentPanel: 2,     // 0=tree, 1=editor, 2=chat (mobile default)
  touchStartX: 0,
  touchStartY: 0,
  panelOffset: 0,
  isMobile: window.innerWidth <= 1024,
  connected: false,
  chatConnected: false,
  expandedDirs: new Set(),
};

// ─── Derive File Server URL from Gateway ────────────────────────────

function deriveFileServerUrl() {
  // Try to get the gateway URL from the chat connection state
  const connData = localStorage.getItem("connection");
  if (!connData) return;
  try {
    const { gatewayUrl } = JSON.parse(connData);
    if (!gatewayUrl) return;
    // Convert ws(s):// to http(s):// and append /files
    let httpUrl = gatewayUrl
      .replace(/^wss:\/\//, "https://")
      .replace(/^ws:\/\//, "http://")
      .replace(/\/+$/, "");
    // Use HTTPS directly on port 18795 (file server with proper CORS/PNA headers)
    try {
      const u = new URL(httpUrl);
      u.port = "18795";
      workspace.fileServerUrl = u.toString().replace(/\/+$/, "");
    } catch {
      workspace.fileServerUrl = httpUrl.replace(/:(\d+)(\/|$)/, ":18795$2").replace(/\/+$/, "");
    }
    console.log("[files] Derived file server URL:", workspace.fileServerUrl);
  } catch {}
}

// Called by app.js after successful chat connection
function onChatConnected() {
  workspace.chatConnected = true;
  deriveFileServerUrl();
  if (workspace.fileServerUrl && !workspace.connected) {
    connectFileServer();
  }
  checkAutoOpenSettings();
}

// ─── Init ───────────────────────────────────────────────────────────

function initWorkspace() {
  // Auto-derive file server URL from gateway connection (same host + /files path)
  deriveFileServerUrl();

  buildWorkspaceDOM();
  setupSwipeGestures();
  setupResizer();

  window.addEventListener("resize", () => {
    const wasMobile = workspace.isMobile;
    workspace.isMobile = window.innerWidth <= 1024;
    if (wasMobile !== workspace.isMobile) updateLayout();
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveCurrentFile();
    }
    // Cmd/Ctrl+O for quick file search
    if ((e.metaKey || e.ctrlKey) && e.key === "o" && workspace.connected) {
      e.preventDefault();
      toggleSearch();
      if (workspace.isMobile) switchPanel(0);
    }
  });

  // Load theme
  const savedTheme = localStorage.getItem("theme") || "dark";
  document.body.setAttribute("data-theme", savedTheme);

  if (workspace.fileServerUrl) connectFileServer();
  updateLayout();

  // Auto-open settings if not connected after a short delay
  setTimeout(() => checkAutoOpenSettings(), 2000);
}

// ─── DOM Construction ───────────────────────────────────────────────

function buildWorkspaceDOM() {
  const app = document.querySelector(".app");
  const onboarding = document.getElementById("onboarding");
  const chatContainer = document.getElementById("chat-container");

  // Wrap everything in panels
  const panelContainer = document.createElement("div");
  panelContainer.id = "panel-container";
  panelContainer.className = "panel-container";

  // Left: File tree
  const treePanel = document.createElement("div");
  treePanel.id = "tree-panel";
  treePanel.className = "panel tree-panel";
  treePanel.innerHTML = `
    <div class="tree-search" id="tree-search">
      <input type="text" id="tree-search-input" placeholder="Search files..." oninput="filterFileTree(this.value)">
    </div>
    <div class="tree-content" id="tree-content"></div>
  `;

  // Resizer
  const resizer = document.createElement("div");
  resizer.id = "panel-resizer-left";
  resizer.className = "panel-resizer";

  // Middle: Editor
  const editorPanel = document.createElement("div");
  editorPanel.id = "editor-panel";
  editorPanel.className = "panel editor-panel";
  editorPanel.innerHTML = `
    <div class="editor-tab-bar" id="editor-tab-bar">
      <div class="editor-tabs" id="editor-tabs"></div>
    </div>
    <div class="editor-banner oc-hidden" id="editor-banner">
      <span id="editor-banner-text"></span>
      <button onclick="reloadCurrentFile()">Reload</button>
      <button onclick="dismissBanner()">✕</button>
    </div>
    <div class="editor-area" id="editor-area">
      <div class="editor-empty">Open a file from the file tree</div>
    </div>
  `;

  // Another resizer
  const resizer2 = document.createElement("div");
  resizer2.id = "panel-resizer-right";
  resizer2.className = "panel-resizer";

  // Right: Chat (existing)
  const chatPanel = document.createElement("div");
  chatPanel.id = "chat-panel";
  chatPanel.className = "panel chat-panel";

  // Move chat container into chat panel
  chatPanel.appendChild(chatContainer);

  panelContainer.appendChild(treePanel);
  panelContainer.appendChild(resizer);
  panelContainer.appendChild(editorPanel);
  panelContainer.appendChild(resizer2);
  panelContainer.appendChild(chatPanel);

  // Insert after onboarding
  app.appendChild(panelContainer);

  // Mobile dots
  const dots = document.createElement("div");
  dots.id = "panel-dots";
  dots.className = "panel-dots";
  dots.innerHTML = `
    <span class="dot" data-panel="0"></span>
    <span class="dot" data-panel="1"></span>
    <span class="dot active" data-panel="2"></span>
  `;
  app.appendChild(dots);

  // Bottom bar: branding + cogwheel + status dot
  const settingsEl = document.createElement("div");
  settingsEl.className = "tree-settings";
  settingsEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <img src="/logo-64.png" width="18" height="18" style="border-radius:4px;opacity:0.6;flex-shrink:0;" alt="">
      <span style="font-size:11px;color:var(--text-faint);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">usemyclaw</span>
      <button class="tree-settings-cogwheel" id="hard-refresh-btn" title="Reload app" onclick="location.reload(true)" style="opacity:0.4;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0115-6.7L21 8"/>
          <path d="M3 22v-6h6"/><path d="M21 12a9 9 0 01-15 6.7L3 16"/>
        </svg>
      </button>
      <button class="tree-settings-cogwheel" id="tree-settings-btn" title="Settings" onclick="toggleSettingsPopup()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
      </button>
      <span id="tree-status-dot" class="fs-dot" style="width:7px;height:7px;flex-shrink:0;"></span>
    </div>
  `;
  treePanel.appendChild(settingsEl);

  // Settings popup — appended to body so nothing clips it
  const popup = document.createElement("div");
  popup.id = "tree-settings-popup";
  popup.className = "tree-settings-popup oc-hidden";
  document.body.appendChild(popup);

  // Onboarding overlay — appended to body
  const onboardOverlay = document.createElement("div");
  onboardOverlay.id = "onboard-overlay";
  onboardOverlay.className = "onboard-overlay oc-hidden";
  document.body.appendChild(onboardOverlay);
}

// ─── File Server Connection ─────────────────────────────────────────

function connectFileServer() {
  if (!workspace.fileServerUrl) return;
  const baseUrl = workspace.fileServerUrl.replace(/\/+$/, "");

  // Test connection
  const healthUrl = `${baseUrl}/health`;
  console.log("[files] Connecting to file server:", healthUrl);
  fetch(healthUrl, { targetAddressSpace: "local" })
    .then(r => {
      console.log("[files] Response status:", r.status);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      if (data.ok) {
        console.log("[files] Connected successfully");
        workspace.connected = true;
        updateFsStatus(true);
        loadFileTree();
        startFilePolling();
        checkAutoOpenSettings();
      }
    })
    .catch((err) => {
      console.error("[files] Connection failed:", err.message || err);
      workspace.connected = false;
      workspace._lastFileError = err.message || String(err);
      updateFsStatus(false);
      checkAutoOpenSettings();

      // Detect Chrome Private Network Access denial
      const msg = (err.message || String(err)).toLowerCase();
      if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("cors")) {
        showPnaBanner();
      }
    });
}

// Poll for file changes instead of WebSocket (Tailscale Serve doesn't proxy WS on subpaths)
function startFilePolling() {
  if (workspace.pollTimer) clearInterval(workspace.pollTimer);
  workspace.pollTimer = setInterval(() => {
    if (!workspace.connected) return;
    checkOpenTabsForChanges();
  }, 4000);
}

async function checkOpenTabsForChanges() {
  const baseUrl = workspace.fileServerUrl.replace(/\/+$/, "");
  for (const tab of workspace.openTabs) {
    if (tab.externalChange || tab.deleted) continue;
    try {
      const r = await fetch(`${baseUrl}/api/files/${tab.path.split("/").map(encodeURIComponent).join("/")}`, { method: "HEAD", targetAddressSpace: "local" });
      if (!r.ok) { tab.deleted = true; continue; }
      const mtime = parseFloat(r.headers.get("X-File-Mtime") || "0");
      if (mtime > tab.mtime + 100) {
        tab.externalChange = true;
        if (workspace.openTabs[workspace.activeTabIdx] === tab) {
          showBanner(`"${tab.name}" changed externally.`);
        }
      }
    } catch {}
  }
  // Also refresh tree periodically (every 3rd poll = ~12s)
  workspace._pollCount = (workspace._pollCount || 0) + 1;
  if (workspace._pollCount % 3 === 0) loadFileTree();
}

function handleFileChange(msg) {
  // Refresh tree on any change
  loadFileTree();

  // Check if any open tab is affected
  if (msg.type === "change" && msg.path) {
    const tab = workspace.openTabs.find(t => t.path === msg.path);
    if (tab && msg.mtime > tab.mtime) {
      tab.externalChange = true;
      if (workspace.openTabs[workspace.activeTabIdx] === tab) {
        showBanner(`"${tab.name}" changed externally.`);
      }
    }
  }
  if (msg.type === "delete" && msg.path) {
    const tab = workspace.openTabs.find(t => t.path === msg.path);
    if (tab) {
      tab.deleted = true;
      if (workspace.openTabs[workspace.activeTabIdx] === tab) {
        showBanner(`"${tab.name}" was deleted.`);
      }
    }
  }
}

function updateFsStatus(connected) {
  updateTreeStatusDot();
}

function updateTreeStatusDot() {
  const dot = document.getElementById("tree-status-dot");
  if (!dot) return;
  const allUp = workspace.connected && workspace.chatConnected;
  const partial = workspace.connected || workspace.chatConnected;
  dot.classList.toggle("connected", allUp);
  dot.style.background = allUp ? "" : partial ? "#ffc107" : "";
  dot.style.boxShadow = allUp ? "" : partial ? "0 0 4px rgba(255,193,7,0.3)" : "";
  dot.title = allUp ? "Connected" : partial ? (workspace.chatConnected ? "Chat only" : "Files only") : "Not connected";
}

// ─── Private Network Access Banner ──────────────────────────────────

function showPnaBanner() {
  if (workspace._pnaBannerShown) return;
  workspace._pnaBannerShown = true;

  // Remove existing banner if any
  document.getElementById("pna-banner")?.remove();

  const banner = document.createElement("div");
  banner.id = "pna-banner";
  banner.innerHTML = `
    <div style="
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      z-index: 10000; max-width: 420px; width: calc(100% - 2rem);
      background: #1a1a1e; border: 1px solid rgba(255,193,7,0.3);
      border-radius: 12px; padding: 1rem 1.2rem;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5); color: #eee;
      font-size: 0.88em; line-height: 1.5;
    ">
      <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.5rem;">
        <strong style="color: #ffc107;">🔒 Allow local network access</strong>
        <span id="pna-dismiss" style="cursor: pointer; color: #888; font-size: 1.2em; line-height: 1; padding: 0 0.2rem;">&times;</span>
      </div>
      <p style="margin: 0 0 0.6rem; color: #ccc;">
        Chrome blocked access to your local network. The file browser needs this to connect to your server.
      </p>
      <p style="margin: 0 0 0.6rem; color: #ccc;">
        Click the <strong style="color: #eee;">⚙ icon in the address bar</strong>, find <strong style="color: #eee;">"Access other devices on your local network"</strong>, switch it to <strong style="color: #eee;">Allow</strong>, then hit Retry below.
      </p>
      <p style="margin: 0; color: #999; font-size: 0.85em;">
        This only reaches your private Tailscale network — no one else can access it. Completely safe.
      </p>
      <button id="pna-retry" style="
        margin-top: 0.75rem; width: 100%; padding: 0.5rem;
        background: rgba(255,193,7,0.15); border: 1px solid rgba(255,193,7,0.3);
        border-radius: 8px; color: #ffc107; font-size: 0.85em;
        cursor: pointer; transition: background 0.2s;
      ">Retry connection</button>
    </div>
  `;

  document.body.appendChild(banner);

  document.getElementById("pna-dismiss").addEventListener("click", () => banner.remove());
  document.getElementById("pna-retry").addEventListener("click", () => {
    banner.remove();
    workspace._pnaBannerShown = false;
    connectFileServer();
  });
}

// ─── File Tree ──────────────────────────────────────────────────────

async function loadFileTree() {
  if (!workspace.fileServerUrl) return;
  try {
    const r = await fetch(`${workspace.fileServerUrl.replace(/\/+$/, "")}/api/files/`, { targetAddressSpace: "local" });
    workspace.tree = await r.json();
    renderFileTree();
  } catch (e) {
    console.error("Failed to load file tree:", e);
  }
}

function refreshFileTree() {
  loadFileTree();
}

function toggleSearch() {
  // Search bar is always visible now - just focus it
  const input = document.getElementById("tree-search-input");
  if (input) {
    input.focus();
    input.select();
  }
}

function filterFileTree(query) {
  if (!query.trim()) { renderFileTree(); return; }
  const q = query.toLowerCase();
  const results = flattenTree(workspace.tree).filter(f => isObsidianVisible(f.name) && (f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)));
  const container = document.getElementById("tree-content");
  if (!container) return;
  container.innerHTML = "";
  if (results.length === 0) {
    container.innerHTML = '<div style="padding:16px;color:var(--text-faint);font-size:12px;text-align:center">No results</div>';
    return;
  }
  for (const item of results.slice(0, 50)) {
    const row = document.createElement("div");
    row.className = "tree-item tree-file";
    row.style.paddingLeft = "14px";
    const isActive = workspace.openTabs[workspace.activeTabIdx]?.path === item.path;
    if (isActive) row.classList.add("active");
    row.innerHTML = `<span class="tree-icon">${getFileIcon(item.name)}</span><span class="tree-name">${highlightMatch(item.path, q)}</span>`;
    row.addEventListener("click", () => openFile(item.path, item.name));
    container.appendChild(row);
  }
}

function flattenTree(items, results = []) {
  for (const item of items) {
    if (item.type === "file") results.push(item);
    if (item.type === "dir" && item.children) flattenTree(item.children, results);
  }
  return results;
}

function highlightMatch(text, query) {
  const idx = text.toLowerCase().indexOf(query);
  if (idx < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) + '<span class="search-match">' + escapeHtml(text.slice(idx, idx + query.length)) + '</span>' + escapeHtml(text.slice(idx + query.length));
}

function renderFileTree() {
  const container = document.getElementById("tree-content");
  if (!container) return;
  container.innerHTML = "";
  container.appendChild(buildTreeNodes(workspace.tree, 0));
}

// File extensions Obsidian shows in its file explorer
const OBSIDIAN_VISIBLE_EXTENSIONS = new Set([
  // Documents
  'md', 'txt', 'pdf', 'canvas',
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico',
  // Audio
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'webm', '3gp', 'aac',
  // Video
  'mp4', 'ogv', 'mov',
]);

function isObsidianVisible(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  return OBSIDIAN_VISIBLE_EXTENSIONS.has(ext);
}

function hasVisibleChildren(items) {
  for (const item of items) {
    if (item.type === "file" && isObsidianVisible(item.name)) return true;
    if (item.type === "dir" && item.children && hasVisibleChildren(item.children)) return true;
  }
  return false;
}

function buildTreeNodes(items, depth) {
  const frag = document.createDocumentFragment();
  for (const item of items) {
    // Filter out code/config files that Obsidian wouldn't show
    if (item.type === "file" && !isObsidianVisible(item.name)) continue;
    // Skip directories that have no visible children
    if (item.type === "dir" && item.children && !hasVisibleChildren(item.children)) continue;
    const row = document.createElement("div");
    row.className = `tree-item ${item.type === "dir" ? "tree-dir" : "tree-file"}`;
    row.style.paddingLeft = `${12 + depth * 16}px`;

    if (item.type === "dir") {
      const expanded = workspace.expandedDirs.has(item.path);
      const folderSvg = expanded
        ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="rgba(242,242,242,0.5)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v6.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5z"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="rgba(242,242,242,0.25)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v6.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5z"/></svg>';
      const arrowSvg = expanded
        ? '<svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><path d="M2 3.5L5 7l3-3.5H2z"/></svg>'
        : '<svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><path d="M3.5 2L7 5l-3.5 3V2z"/></svg>';
      row.innerHTML = `<span class="tree-arrow ${expanded ? "open" : ""}">${arrowSvg}</span><span class="tree-icon">${folderSvg}</span><span class="tree-name">${escapeHtml(item.name)}</span>`;
      row.addEventListener("click", () => toggleDir(item.path));
      frag.appendChild(row);

      if (expanded && item.children) {
        const children = buildTreeNodes(item.children, depth + 1);
        frag.appendChild(children);
      }
    } else {
      const isActive = workspace.openTabs[workspace.activeTabIdx]?.path === item.path;
      const nameBase = item.name.replace(/\.[^.]+$/, '');
      const ext = item.name.includes('.') ? '.' + item.name.split('.').pop() : '';
      row.innerHTML = `<span class="tree-icon">${getFileIcon(item.name)}</span><span class="tree-name">${escapeHtml(nameBase)}<span style="color:rgba(242,242,242,0.15)">${ext}</span></span>`;
      if (isActive) row.classList.add("active");
      row.addEventListener("click", () => openFile(item.path, item.name));
      frag.appendChild(row);
    }
  }
  return frag;
}

function toggleDir(dirPath) {
  if (workspace.expandedDirs.has(dirPath)) {
    workspace.expandedDirs.delete(dirPath);
  } else {
    workspace.expandedDirs.add(dirPath);
  }
  renderFileTree();
}

function getFileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  // Clean SVG icons - minimal line style
  const svgIcon = (paths, color = "currentColor") =>
    `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

  // Monochrome icon palette — subtle differentiation
  const c1 = 'rgba(242,242,242,0.45)';  // default file
  const c2 = 'rgba(242,242,242,0.55)';  // code/markup
  const c3 = 'rgba(242,242,242,0.35)';  // data/config
  const c4 = 'rgba(242,242,242,0.4)';   // media
  const icons = {
    md: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M5 9l1.5-2L8 9l1.5-2L11 9"/>', c2),
    txt: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M5 7h6M5 9.5h4"/>', c1),
    json: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M6 7v2c0 1-1 1-1 2M10 7v2c0 1 1 1 1 2"/>', c3),
    js: svgIcon('<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 10V7M9 7v2a1 1 0 001 1h0a1 1 0 001-1V7"/>', c2),
    ts: svgIcon('<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 7v4M4.5 7h3M10 7v4"/>', c2),
    py: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><circle cx="7" cy="8" r="1.5"/>', c2),
    html: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M5.5 7L8 10l2.5-3"/>', c2),
    css: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M6 8h4M6 10h3"/>', c2),
    yaml: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M5 7l2 2 2-2M7 9v3"/>', c3),
    yml: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M5 7l2 2 2-2M7 9v3"/>', c3),
    sh: svgIcon('<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 7l2 2-2 2M9 11h2"/>', c2),
    jpg: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><circle cx="6" cy="7" r="1.5"/><path d="M4 13l3-4 2 2 3-4"/>', c4),
    png: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><circle cx="6" cy="7" r="1.5"/><path d="M4 13l3-4 2 2 3-4"/>', c4),
    gif: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><circle cx="6" cy="7" r="1.5"/><path d="M4 13l3-4 2 2 3-4"/>', c4),
    svg: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><circle cx="8" cy="9" r="2.5"/>', c4),
    pdf: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M5 8h6M5 10.5h4"/>', c1),
    csv: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M5 7h6M5 9.5h6M8 7v5"/>', c3),
    log: svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M5 7h6M5 9.5h4M5 12h2"/>', c3),
  };
  return icons[ext] || svgIcon('<path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M10 2v3h3"/>', c1);
}

// ─── File Opening / Tabs ────────────────────────────────────────────

async function openFile(filePath, fileName) {
  // Check if already open
  const existingIdx = workspace.openTabs.findIndex(t => t.path === filePath);
  if (existingIdx >= 0) {
    workspace.activeTabIdx = existingIdx;
    renderEditorTabs();
    renderEditorContent();
    if (workspace.isMobile) switchPanel(1);
    return;
  }

  // Fetch content
  try {
    const baseUrl = workspace.fileServerUrl.replace(/\/+$/, "");
    const r = await fetch(`${baseUrl}/api/files/${filePath.split("/").map(encodeURIComponent).join("/")}`, { targetAddressSpace: "local" });
    if (!r.ok) throw new Error("Failed to fetch file");
    const content = await r.text();
    const mtime = parseFloat(r.headers.get("X-File-Mtime") || "0");

    workspace.openTabs.push({
      path: filePath,
      name: fileName,
      content,
      savedContent: content,
      mtime,
      dirty: false,
      externalChange: false,
      deleted: false,
    });
    workspace.activeTabIdx = workspace.openTabs.length - 1;
    workspace.editMode = false;
    renderEditorTabs();
    renderEditorContent();
    renderFileTree(); // Update active highlight
    if (workspace.isMobile) switchPanel(1);
  } catch (e) {
    console.error("Failed to open file:", e);
  }
}

function closeEditorTab(idx, e) {
  if (e) e.stopPropagation();
  const tab = workspace.openTabs[idx];
  if (tab.dirty && !confirm(`"${tab.name}" has unsaved changes. Close anyway?`)) return;

  workspace.openTabs.splice(idx, 1);
  if (workspace.activeTabIdx >= workspace.openTabs.length) {
    workspace.activeTabIdx = workspace.openTabs.length - 1;
  } else if (workspace.activeTabIdx > idx) {
    workspace.activeTabIdx--;
  }
  workspace.editMode = false;
  renderEditorTabs();
  renderEditorContent();
  renderFileTree();
}

function selectTab(idx) {
  workspace.activeTabIdx = idx;
  workspace.editMode = false;
  renderEditorTabs();
  renderEditorContent();
  renderFileTree();
}

// ─── Editor Rendering ───────────────────────────────────────────────

function renderEditorTabs() {
  const container = document.getElementById("editor-tabs");
  if (!container) return;
  container.innerHTML = "";

  workspace.openTabs.forEach((tab, i) => {
    const el = document.createElement("div");
    el.className = `editor-tab ${i === workspace.activeTabIdx ? "active" : ""}`;
    el.innerHTML = `
      <span class="editor-tab-name">${escapeHtml(tab.name)}${tab.dirty ? " •" : ""}</span>
      <span class="editor-tab-close" onclick="closeEditorTab(${i}, event)">×</span>
    `;
    el.addEventListener("click", () => selectTab(i));
    container.appendChild(el);
  });
}

// Split markdown content into logical blocks for inline editing
function splitIntoBlocks(text) {
  if (!text) return [""];
  // Split on double newlines, preserving code blocks as single blocks
  const blocks = [];
  let current = "";
  let inCodeBlock = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        current += line + "\n";
        blocks.push(current.replace(/\n$/, ""));
        current = "";
        inCodeBlock = false;
        continue;
      } else {
        if (current.trim()) { blocks.push(current.replace(/\n$/, "")); current = ""; }
        current = line + "\n";
        inCodeBlock = true;
        continue;
      }
    }
    if (inCodeBlock) {
      current += line + "\n";
      continue;
    }
    if (line.trim() === "" && current.trim()) {
      blocks.push(current.replace(/\n$/, ""));
      current = "";
    } else {
      current += line + "\n";
    }
  }
  if (current.trim()) blocks.push(current.replace(/\n$/, ""));
  return blocks.length > 0 ? blocks : [""];
}

// Rejoin blocks back into full content
function joinBlocks(blocks) {
  return blocks.join("\n\n");
}

function renderEditorContent() {
  const area = document.getElementById("editor-area");
  if (!area) return;

  if (workspace.activeTabIdx < 0 || !workspace.openTabs[workspace.activeTabIdx]) {
    area.innerHTML = '<div class="editor-empty">Open a file from the file tree</div>';
    return;
  }

  const tab = workspace.openTabs[workspace.activeTabIdx];
  const prevScrollTop = workspace._editorScrollTop || 0;

  // Split into blocks and render each as a clickable unit
  const blocks = splitIntoBlocks(tab.content);
  // Store blocks on tab for inline editing
  tab._blocks = blocks;

  const preview = document.createElement("div");
  preview.className = "editor-preview";
  preview.id = "editor-preview-content";

  blocks.forEach((block, idx) => {
    const blockWrapper = document.createElement("div");
    blockWrapper.className = "editor-block";
    blockWrapper.setAttribute("data-block-idx", String(idx));
    blockWrapper.innerHTML = renderMarkdown(block);

    // Click to edit this block
    blockWrapper.addEventListener("click", (e) => {
      // Don't trigger on links or checkboxes
      if (e.target.tagName === "A" || e.target.tagName === "INPUT") return;
      // Don't trigger if already editing this block
      if (blockWrapper.querySelector(".editor-block-textarea")) return;
      startBlockEdit(blockWrapper, tab, idx);
    });

    preview.appendChild(blockWrapper);
  });

  area.innerHTML = "";
  area.appendChild(preview);

  // Restore scroll
  preview.scrollTop = prevScrollTop;
  preview.addEventListener("scroll", () => {
    workspace._editorScrollTop = preview.scrollTop;
  });
}

function startBlockEdit(blockWrapper, tab, blockIdx) {
  const blocks = tab._blocks || splitIntoBlocks(tab.content);
  const blockText = blocks[blockIdx] || "";

  // Replace rendered content with textarea
  blockWrapper.innerHTML = "";
  blockWrapper.classList.add("editing");

  const textarea = document.createElement("textarea");
  textarea.className = "editor-block-textarea";
  textarea.value = blockText;
  textarea.spellcheck = false;
  blockWrapper.appendChild(textarea);

  // Auto-resize textarea to fit content
  const autoResize = () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.max(40, textarea.scrollHeight) + "px";
  };
  autoResize();

  let autosaveTimer = null;

  const finishEdit = (save) => {
    if (save) {
      const newText = textarea.value;
      blocks[blockIdx] = newText;
      tab._blocks = blocks;
      tab.content = joinBlocks(blocks);
      tab.dirty = tab.content !== tab.savedContent;
      renderEditorTabs();
      if (tab.dirty) {
        if (autosaveTimer) clearTimeout(autosaveTimer);
        saveCurrentFile();
      }
    }
    // Re-render just this block
    blockWrapper.classList.remove("editing");
    blockWrapper.innerHTML = renderMarkdown(blocks[blockIdx] || "");
    // Re-attach click handler
    blockWrapper.addEventListener("click", (e) => {
      if (e.target.tagName === "A" || e.target.tagName === "INPUT") return;
      if (blockWrapper.querySelector(".editor-block-textarea")) return;
      startBlockEdit(blockWrapper, tab, blockIdx);
    });
  };

  textarea.addEventListener("input", () => {
    autoResize();
    // Live update the block content
    blocks[blockIdx] = textarea.value;
    tab._blocks = blocks;
    tab.content = joinBlocks(blocks);
    tab.dirty = tab.content !== tab.savedContent;
    renderEditorTabs();
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      if (tab.dirty) saveCurrentFile();
    }, 1000);
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); finishEdit(true); }
    if (e.key === "Tab") {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + "  " + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      textarea.dispatchEvent(new Event("input"));
    }
  });

  textarea.addEventListener("blur", () => {
    // Small delay to allow click on another block
    setTimeout(() => finishEdit(true), 150);
  });

  textarea.focus();
}

function toggleEditMode() {
  // Legacy — no longer used but kept for compatibility
  renderEditorContent();
}

// ─── Save ───────────────────────────────────────────────────────────

async function saveCurrentFile() {
  const tab = workspace.openTabs[workspace.activeTabIdx];
  if (!tab) return;

  try {
    const baseUrl = workspace.fileServerUrl.replace(/\/+$/, "");
    const r = await fetch(`${baseUrl}/api/files/${tab.path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: tab.content,
      targetAddressSpace: "local",
    });
    const data = await r.json();
    if (data.ok) {
      tab.savedContent = tab.content;
      tab.dirty = false;
      tab.mtime = data.mtime;
      tab.externalChange = false;
      renderEditorTabs();
      renderEditorContent();
    }
  } catch (e) {
    console.error("Save failed:", e);
    alert("Failed to save file: " + e.message);
  }
}

// ─── Reload ─────────────────────────────────────────────────────────

async function reloadCurrentFile() {
  const tab = workspace.openTabs[workspace.activeTabIdx];
  if (!tab) return;

  try {
    const baseUrl = workspace.fileServerUrl.replace(/\/+$/, "");
    const r = await fetch(`${baseUrl}/api/files/${tab.path.split("/").map(encodeURIComponent).join("/")}`, { targetAddressSpace: "local" });
    if (!r.ok) throw new Error("File not found");
    tab.content = await r.text();
    tab.savedContent = tab.content;
    tab.mtime = parseFloat(r.headers.get("X-File-Mtime") || "0");
    tab.dirty = false;
    tab.externalChange = false;
    tab.deleted = false;
    dismissBanner();
    renderEditorTabs();
    renderEditorContent();
  } catch (e) {
    console.error("Reload failed:", e);
  }
}

// ─── Banner ─────────────────────────────────────────────────────────

function showBanner(text) {
  const banner = document.getElementById("editor-banner");
  const bannerText = document.getElementById("editor-banner-text");
  if (banner && bannerText) {
    bannerText.textContent = text;
    banner.classList.remove("oc-hidden");
  }
}

function dismissBanner() {
  const banner = document.getElementById("editor-banner");
  if (banner) banner.classList.add("oc-hidden");
}

// ─── Markdown Renderer (simple) ─────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return "";

  // Extract code blocks first to protect them from other transformations
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="code-block"><div class="code-lang">${lang || ''}</div><code>${escapeHtml(code)}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Extract inline code
  const inlineCodes = [];
  processed = processed.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Now escape the rest
  let html = escapeHtml(processed);

  // Restore code blocks and inline code
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[i]);
  html = html.replace(/\x00INLINE(\d+)\x00/g, (_, i) => inlineCodes[i]);

  // Tables
  html = html.replace(/^(\|.+\|)\n(\|[\s\-:|]+\|)\n((?:\|.+\|\n?)+)/gm, (_, header, align, body) => {
    const parseAligns = (row) => row.split('|').filter(c => c.trim()).map(c => {
      c = c.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    const aligns = parseAligns(align);
    const headerCells = header.split('|').filter(c => c.trim()).map((c, i) =>
      `<th style="text-align:${aligns[i] || 'left'}">${c.trim()}</th>`
    ).join('');
    const bodyRows = body.trim().split('\n').map(row => {
      const cells = row.split('|').filter(c => c.trim()).map((c, i) =>
        `<td style="text-align:${aligns[i] || 'left'}">${c.trim()}</td>`
      ).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
  });

  // Callouts / Admonitions  (> [!TYPE] title)
  html = html.replace(/^&gt;\s*\[!(\w+)\]\s*(.*)\n((?:&gt;\s?.*\n?)*)/gm, (_, type, title, body) => {
    const t = type.toLowerCase();
    const bodyText = body.replace(/^&gt;\s?/gm, '').trim();
    const icons = { note: 'ℹ️', tip: '💡', warning: '⚠️', danger: '🔴', info: 'ℹ️', important: '❗', caution: '⚠️', example: '📝', quote: '💬', abstract: '📋', success: '✅', question: '❓', bug: '🐛' };
    const icon = icons[t] || '📌';
    return `<div class="callout callout-${t}"><div class="callout-title">${icon} ${title || type}</div><div class="callout-body">${bodyText}</div></div>`;
  });

  // Blockquotes (must come after callouts)
  html = html.replace(/^(&gt;\s?.+\n?)+/gm, (match) => {
    const inner = match.replace(/^&gt;\s?/gm, '').trim();
    return `<blockquote>${inner}</blockquote>`;
  });

  // Headers
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Horizontal rules
  html = html.replace(/^---+$/gm, "<hr>");
  html = html.replace(/^\*\*\*+$/gm, "<hr>");

  // Checkboxes (must come before bold/italic)
  // First, collapse blank lines between consecutive checkbox items so they group properly
  html = html.replace(/(^- \[[ x]\]\s+.+$)\n\n(?=- \[[ x]\])/gm, '$1\n');
  html = html.replace(/^- \[x\]\s+(.+)$/gm, '<li class="task task-done"><input type="checkbox" checked disabled> $1</li>');
  html = html.replace(/^- \[ \]\s+(.+)$/gm, '<li class="task"><input type="checkbox" disabled> $1</li>');

  // Bold & italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<em>$1</em>");

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Highlight
  html = html.replace(/==(.+?)==/g, "<mark>$1</mark>");

  // Images (before links)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Internal links [[filename]] - make clickable
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_, link) => {
    const display = link.includes('|') ? link.split('|')[1] : link.split('/').pop();
    const target = link.includes('|') ? link.split('|')[0] : link;
    return `<a class="internal-link" href="#" onclick="openInternalLink('${escapeAttr(target)}');return false;">${escapeHtml(display)}</a>`;
  });

  // Unordered lists (not checkboxes)
  html = html.replace(/^[\-\*]\s+(?!\[[ x]\])(.+)$/gm, "<li>$1</li>");

  // Ordered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li class="ol-item">$1</li>');

  // Wrap consecutive li items in ul/ol
  html = html.replace(/((?:<li(?:\s[^>]*)?>.*?<\/li>\s*)+)/g, (match) => {
    if (match.includes('class="ol-item"')) {
      return '<ol>' + match.replace(/ class="ol-item"/g, '') + '</ol>';
    }
    if (match.includes('class="task')) {
      return '<ul class="task-list">' + match + '</ul>';
    }
    return '<ul>' + match + '</ul>';
  });

  // Before paragraph conversion, remove blank lines between consecutive list items
  // This prevents </p><p> and <br> from appearing inside <ul>/<ol>
  html = html.replace(/(<\/li>)\s*\n\s*\n\s*(<li)/g, '$1\n$2');

  // Paragraphs
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  html = "<p>" + html + "</p>";

  // Clean up <br> between list items inside ul/ol
  html = html.replace(/<\/li>\s*<br>\s*<li/g, '</li><li');

  // Clean up: remove <p> wrapping around block elements
  const blocks = ['h[1-6]', 'pre', 'ul', 'ol', 'table', 'blockquote', 'hr', 'div'];
  for (const tag of blocks) {
    html = html.replace(new RegExp(`<p>\\s*(<${tag}[\\s>])`, 'g'), '$1');
    html = html.replace(new RegExp(`(</${tag}>)\\s*</p>`, 'g'), '$1');
    if (tag === 'hr') {
      html = html.replace(/<p>\s*(<hr>)/g, '$1');
      html = html.replace(/(<hr>)\s*<\/p>/g, '$1');
    }
  }
  html = html.replace(/<p>\s*<\/p>/g, "");

  return html;
}

function escapeAttr(s) {
  return s.replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// Internal link handler - find and open matching file
function openInternalLink(target) {
  // Search the tree for a matching file
  const normalizedTarget = target.toLowerCase().replace(/\.md$/, '');
  const found = findFileInTree(workspace.tree, normalizedTarget);
  if (found) {
    openFile(found.path, found.name);
  } else {
    console.warn("Internal link target not found:", target);
  }
}

function findFileInTree(items, target) {
  for (const item of items) {
    if (item.type === "file") {
      const nameNoExt = item.name.replace(/\.[^.]+$/, '').toLowerCase();
      const pathNoExt = item.path.replace(/\.[^.]+$/, '').toLowerCase();
      if (nameNoExt === target || pathNoExt === target || pathNoExt.endsWith('/' + target)) {
        return item;
      }
    }
    if (item.type === "dir" && item.children) {
      const found = findFileInTree(item.children, target);
      if (found) return found;
    }
  }
  return null;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ─── Settings Helpers ───────────────────────────────────────────────

function toggleCloseConfirm(disabled) {
  localStorage.setItem("openclaw-confirm-close-disabled", disabled ? "true" : "false");
}

function saveVoiceSettings() {
  const urlInput = document.getElementById("settings-stt-url");
  const keyInput = document.getElementById("settings-stt-key");
  const modelInput = document.getElementById("settings-stt-model");
  if (!urlInput || !keyInput || !modelInput) return;

  localStorage.setItem("openclaw-stt-url", urlInput.value.trim());
  localStorage.setItem("openclaw-stt-key", keyInput.value.trim());
  localStorage.setItem("openclaw-stt-model", modelInput.value.trim());

  // Update send button state in app.js
  if (typeof updateSendButton === "function") updateSendButton();

  // Show brief confirmation
  const popup = document.getElementById("tree-settings-popup");
  if (popup) {
    const oldHtml = popup.innerHTML;
    popup.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--interactive-accent);font-size:12px;">✓ Saved</div>';
    setTimeout(() => { popup.innerHTML = oldHtml; renderSettingsPopup(); }, 800);
  }
}

// ─── Theme Toggle ───────────────────────────────────────────────────

function toggleTheme() {
  const current = document.body.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.body.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  // Refresh popup if open
  const popup = document.getElementById("tree-settings-popup");
  if (popup && !popup.classList.contains("oc-hidden")) renderSettingsPopup();
}

function toggleSettingsPopup() {
  const popup = document.getElementById("tree-settings-popup");
  if (!popup) return;
  if (popup.classList.contains("oc-hidden")) {
    openSettingsPopup();
  } else {
    popup.classList.add("oc-hidden");
    workspace._settingsCloseHandler && document.removeEventListener("mousedown", workspace._settingsCloseHandler);
  }
}

function openSettingsPopup() {
  const popup = document.getElementById("tree-settings-popup");
  const btn = document.getElementById("tree-settings-btn");
  if (!popup || !btn) return;

  renderSettingsPopup();

  // Position fixed relative to the cogwheel button
  const rect = btn.getBoundingClientRect();
  popup.style.bottom = (window.innerHeight - rect.top + 8) + "px";
  popup.style.left = Math.max(8, rect.left) + "px";
  popup.classList.remove("oc-hidden");

  // Close only when clicking OUTSIDE the popup and the cogwheel button
  workspace._settingsCloseHandler && document.removeEventListener("mousedown", workspace._settingsCloseHandler);
  workspace._settingsCloseHandler = (e) => {
    const popup = document.getElementById("tree-settings-popup");
    const btn = document.getElementById("tree-settings-btn");
    if (!popup || !btn) return;
    if (popup.contains(e.target) || btn.contains(e.target) || e.target === btn) return;
    popup.classList.add("oc-hidden");
    document.removeEventListener("mousedown", workspace._settingsCloseHandler);
  };
  setTimeout(() => document.addEventListener("mousedown", workspace._settingsCloseHandler), 50);
}

// Auto-open onboarding if no credentials, auto-close when connected
function checkAutoOpenSettings() {
  let gatewayUrl = '', token = '';
  try {
    const d = JSON.parse(localStorage.getItem("connection") || '{}');
    gatewayUrl = d.gatewayUrl || '';
    token = d.token || '';
  } catch {}
  const hasCredentials = !!(gatewayUrl && token);
  const allConnected = workspace.connected && workspace.chatConnected;

  // No credentials → show onboarding overlay
  if (!hasCredentials) {
    const overlay = document.getElementById("onboard-overlay");
    if (overlay && overlay.classList.contains("oc-hidden")) {
      openOnboarding();
    }
    return;
  }

  // Connected → close onboarding if open
  if (allConnected) {
    closeOnboarding();
    updateTreeStatusDot();
  }
}

function renderSettingsPopup() {
  const popup = document.getElementById("tree-settings-popup");
  if (!popup) return;

  // Get state
  let gatewayUrl = '', token = '';
  try {
    const d = JSON.parse(localStorage.getItem("connection") || '{}');
    gatewayUrl = d.gatewayUrl || '';
    token = d.token || '';
  } catch {}
  const allUp = workspace.connected && workspace.chatConnected;
  const partial = workspace.connected || workspace.chatConnected;
  const connColor = allUp ? '#4caf50' : partial ? '#ffc107' : 'var(--text-faint)';
  const connLabel = allUp ? 'Connected' : partial ? (workspace.chatConnected ? 'Chat only' : 'Files only') : 'Not connected';
  const currentTheme = document.body.getAttribute("data-theme") || "dark";
  const showVoice = workspace._settingsShowVoice;
  const sttKey = localStorage.getItem("openclaw-stt-key") || "";
  const sttUrl = localStorage.getItem("openclaw-stt-url") || "https://api.openai.com/v1/audio/transcriptions";
  const sttModel = localStorage.getItem("openclaw-stt-model") || "whisper-1";
  const confirmDisabled = localStorage.getItem("openclaw-confirm-close-disabled") === "true";

  // Try to extract hostname for display
  let gwHost = '';
  try { gwHost = new URL(gatewayUrl.replace(/^ws/, 'http')).hostname; } catch {}

  popup.innerHTML = `
    <!-- Branding header -->
    <div style="display:flex;align-items:center;gap:8px;padding:10px 12px 8px;">
      <img src="/logo-64.png" width="22" height="22" style="border-radius:5px;flex-shrink:0;" alt="">
      <div style="flex:1;">
        <div style="font-size:12px;font-weight:500;color:var(--text-normal);line-height:1.2;">usemyclaw.com</div>
      </div>
    </div>

    <!-- Connection status -->
    <div style="display:flex;align-items:center;gap:8px;padding:4px 12px 10px;">
      <span class="fs-dot ${allUp ? 'connected' : ''}" style="width:7px;height:7px;flex-shrink:0;${!allUp && partial ? 'background:#ffc107;box-shadow:0 0 4px rgba(255,193,7,0.3);' : ''}"></span>
      <span style="font-size:11px;color:${connColor};flex:1;">${connLabel}${gwHost && allUp ? ' · ' + gwHost : ''}</span>
    </div>

    <div class="settings-divider"></div>

    <!-- Settings -->
    <div style="padding:6px 0;">
      <div class="settings-toggle-row">
        <span>Light mode</span>
        <label class="settings-toggle">
          <input type="checkbox" ${currentTheme === "light" ? "checked" : ""} onchange="toggleTheme()">
          <span class="slider"></span>
          <span class="knob"></span>
        </label>
      </div>
      <div class="settings-toggle-row">
        <span>Confirm tab close</span>
        <label class="settings-toggle">
          <input type="checkbox" ${!confirmDisabled ? "checked" : ""} onchange="toggleCloseConfirm(!this.checked)">
          <span class="slider"></span>
          <span class="knob"></span>
        </label>
      </div>
    </div>

    <div class="settings-divider"></div>

    <!-- Accent color -->
    <div style="padding:6px 12px 8px;">
      <span style="font-size:11px;color:var(--text-muted);">Accent color</span>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;" id="accent-presets">
        ${['#4a9eff','#a855f7','#22c55e','#f59e0b','#ef4444','#ec4899'].map(c =>
          `<button class="accent-swatch${(localStorage.getItem('accentColor')||'#4a9eff')===c?' active':''}" data-color="${c}" style="
            width:22px;height:22px;border-radius:50%;border:2px solid ${(localStorage.getItem('accentColor')||'#4a9eff')===c?'var(--text-normal)':'transparent'};
            background:${c};cursor:pointer;padding:0;transition:border-color 0.15s;
          " onclick="setAccentColor('${c}')"></button>`
        ).join('')}
      </div>
    </div>

    <div class="settings-divider"></div>

    <!-- Voice input (collapsible) -->
    <div>
      <button onclick="toggleVoiceSettings()" style="
        width:100%;padding:7px 12px;background:none;border:none;
        color:var(--text-muted);font-size:11px;cursor:pointer;text-align:left;
        display:flex;align-items:center;justify-content:space-between;
      ">
        <span>🎙️ Voice input${sttKey ? ' · configured' : ''}</span>
        <span style="font-size:9px;opacity:0.5;">${showVoice ? '▴' : '▾'}</span>
      </button>
      ${showVoice ? `
      <div style="padding:0 12px 10px;display:flex;flex-direction:column;gap:5px;">
        <div>
          <label style="font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;display:block;">Provider URL</label>
          <input id="settings-stt-url" type="text" value="${escapeHtml(sttUrl)}"
            style="width:100%;padding:5px 8px;font-size:11px;border-radius:4px;
              background:rgba(128,128,128,0.06);border:1px solid var(--background-modifier-border);
              color:var(--text-normal);font-family:var(--font-mono,monospace);outline:none;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;display:block;">API Key</label>
          <input id="settings-stt-key" type="password" value="${escapeHtml(sttKey)}" placeholder="sk-..."
            style="width:100%;padding:5px 8px;font-size:11px;border-radius:4px;
              background:rgba(128,128,128,0.06);border:1px solid var(--background-modifier-border);
              color:var(--text-normal);font-family:var(--font-mono,monospace);outline:none;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;display:block;">Model</label>
          <input id="settings-stt-model" type="text" value="${escapeHtml(sttModel)}"
            style="width:100%;padding:5px 8px;font-size:11px;border-radius:4px;
              background:rgba(128,128,128,0.06);border:1px solid var(--background-modifier-border);
              color:var(--text-normal);outline:none;box-sizing:border-box;">
        </div>
        <button onclick="saveVoiceSettings()" style="
          width:100%;padding:6px;font-size:11px;border-radius:4px;
          background:rgba(128,128,128,0.06);color:var(--text-muted);
          border:1px solid var(--background-modifier-border);cursor:pointer;">Save</button>
      </div>` : ''}
    </div>

    <div class="settings-divider"></div>

    <!-- Actions -->
    <div style="padding:6px 12px 10px;">
      <button onclick="openOnboarding()" style="
        width:100%;padding:7px;font-size:11px;border-radius:4px;
        background:none;color:var(--text-faint);
        border:1px solid var(--background-modifier-border);cursor:pointer;
        transition:all 0.15s;
      ">🔄 Reconnect / Setup wizard</button>
    </div>
  `;
}

function setAccentColor(color) {
  localStorage.setItem("accentColor", color);
  document.documentElement.style.setProperty("--accent-color", color);
  renderSettingsPopup();
}

function toggleVoiceSettings() {
  workspace._settingsShowVoice = !workspace._settingsShowVoice;
  renderSettingsPopup();
  repositionPopup();
}

function repositionPopup() {
  const popup = document.getElementById("tree-settings-popup");
  const btn = document.getElementById("tree-settings-btn");
  if (popup && btn) {
    const rect = btn.getBoundingClientRect();
    popup.style.bottom = (window.innerHeight - rect.top + 8) + "px";
    popup.style.left = Math.max(8, rect.left) + "px";
  }
}

function toggleSettingsEditing() {
  workspace._settingsEditing = !workspace._settingsEditing;
  renderSettingsPopup();
}

// ─── Onboarding Overlay ─────────────────────────────────────────────

function openOnboarding() {
  // Close settings popup
  const popup = document.getElementById("tree-settings-popup");
  if (popup) popup.classList.add("oc-hidden");

  const overlay = document.getElementById("onboard-overlay");
  if (!overlay) return;
  renderOnboarding();
  overlay.classList.remove("oc-hidden");
}

function closeOnboarding() {
  const overlay = document.getElementById("onboard-overlay");
  if (overlay) overlay.classList.add("oc-hidden");
}

function renderOnboarding() {
  const overlay = document.getElementById("onboard-overlay");
  if (!overlay) return;

  // Pre-fill existing values
  let gatewayUrl = '', token = '';
  try {
    const d = JSON.parse(localStorage.getItem("connection") || '{}');
    gatewayUrl = d.gatewayUrl || '';
    token = d.token || '';
  } catch {}

  overlay.innerHTML = `
    <div class="onboard-card">
      <button onclick="closeOnboarding()" style="
        position:absolute;top:12px;right:12px;background:none;border:none;
        color:var(--text-faint);font-size:18px;cursor:pointer;padding:4px 8px;
        border-radius:4px;line-height:1;
      ">✕</button>
      <div style="text-align:center;margin-bottom:20px;">
        <img src="/logo-64.png" width="40" height="40" style="border-radius:8px;margin-bottom:8px;" alt="">
        <div style="font-size:16px;font-weight:600;color:var(--text-normal);">Connect to OpenClaw</div>
        <div style="font-size:12px;color:var(--text-faint);margin-top:4px;">Enter your gateway details to get started.</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="font-size:11px;color:var(--text-muted);margin-bottom:4px;display:flex;align-items:center;gap:6px;">
            <span class="onboard-step-num">1</span>
            Gateway URL
          </label>
          <input id="onboard-gateway-url" type="text" value="${escapeHtml(gatewayUrl)}"
            placeholder="https://your-server.tail1234.ts.net"
            style="width:100%;padding:10px 12px;font-size:13px;border-radius:8px;
              background:rgba(128,128,128,0.06);border:1px solid var(--background-modifier-border);
              color:var(--text-normal);font-family:var(--font-mono,monospace);outline:none;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);margin-bottom:4px;display:flex;align-items:center;gap:6px;">
            <span class="onboard-step-num">2</span>
            Auth Token
          </label>
          <input id="onboard-token" type="password" value="${escapeHtml(token)}"
            placeholder="Paste your token"
            style="width:100%;padding:10px 12px;font-size:13px;border-radius:8px;
              background:rgba(128,128,128,0.06);border:1px solid var(--background-modifier-border);
              color:var(--text-normal);font-family:var(--font-mono,monospace);outline:none;box-sizing:border-box;">
        </div>
        <button onclick="submitOnboarding()" style="
          width:100%;padding:12px;font-size:14px;border-radius:8px;
          background:var(--interactive-accent);color:var(--text-on-accent);
          border:none;cursor:pointer;font-weight:600;transition:opacity 0.15s;
          display:flex;align-items:center;justify-content:center;gap:8px;
        ">
          <span class="onboard-step-num" style="background:rgba(255,255,255,0.2);">3</span>
          Connect
        </button>
      </div>
      <div style="font-size:10px;color:var(--text-faint);margin-top:14px;text-align:center;">
        🔒 Stored locally. Never sent to our servers.
      </div>
    </div>
  `;
}

function submitOnboarding() {
  const urlInput = document.getElementById("onboard-gateway-url");
  const tokenInput = document.getElementById("onboard-token");
  if (!urlInput || !tokenInput) return;
  const newUrl = urlInput.value.trim();
  const newToken = tokenInput.value.trim();
  if (!newUrl || !newToken) return;

  // Save and reconnect (reuse existing logic)
  localStorage.setItem("connection", JSON.stringify({ gatewayUrl: newUrl, token: newToken }));

  // Reconnect file server
  workspace.connected = false;
  updateTreeStatusDot();
  deriveFileServerUrl();
  if (workspace.fileServerUrl) connectFileServer();

  // Reconnect chat
  if (typeof state !== 'undefined') {
    state.gatewayUrl = newUrl;
    state.token = newToken;
    if (state.gateway) state.gateway.stop();
    connectToGateway().catch(err => console.error("Reconnect failed:", err));
  }

  closeOnboarding();
}

// Legacy — redirect to onboarding flow
function saveConnectionSettings() {
  openOnboarding();
}

// ─── Panel Navigation (Mobile Swipe) ────────────────────────────────

function setupSwipeGestures() {
  const container = document.getElementById("panel-container");
  if (!container) return;

  container.addEventListener("touchstart", (e) => {
    if (!workspace.isMobile) return;
    // Don't intercept touches on inputs/textareas
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
    workspace.touchStartX = e.touches[0].clientX;
    workspace.touchStartY = e.touches[0].clientY;
  }, { passive: true });

  container.addEventListener("touchmove", (e) => {
    if (!workspace.isMobile) return;
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;

    const dx = e.touches[0].clientX - workspace.touchStartX;
    const dy = e.touches[0].clientY - workspace.touchStartY;

    // Only horizontal swipes
    if (Math.abs(dy) > Math.abs(dx)) return;

    // Prevent overscroll
    if (Math.abs(dx) > 10) {
      const offset = -(workspace.currentPanel * window.innerWidth) + dx;
      container.style.transition = "none";
      container.style.transform = `translateX(${offset}px)`;
    }
  }, { passive: true });

  container.addEventListener("touchend", (e) => {
    if (!workspace.isMobile) return;
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;

    const dx = e.changedTouches[0].clientX - workspace.touchStartX;

    if (Math.abs(dx) > 50) {
      if (dx > 0 && workspace.currentPanel > 0) {
        // Swiping right (finger moves right) = go to previous panel
        // But if we're on the chat panel (2), check if chat tab swipe should handle it
        if (workspace.currentPanel === 2 && typeof canSwipeToPrevTab === "function" && canSwipeToPrevTab()) {
          // Let the chat tab swipe handler deal with it - just snap back
          switchPanel(workspace.currentPanel);
        } else {
          switchPanel(workspace.currentPanel - 1);
        }
      } else if (dx < 0 && workspace.currentPanel < 2) {
        switchPanel(workspace.currentPanel + 1);
      } else {
        switchPanel(workspace.currentPanel);
      }
    } else {
      switchPanel(workspace.currentPanel);
    }
  }, { passive: true });

  // Dot clicks
  document.querySelectorAll(".panel-dots .dot").forEach(dot => {
    dot.addEventListener("click", () => {
      switchPanel(parseInt(dot.dataset.panel));
    });
  });
}

function switchPanel(idx) {
  workspace.currentPanel = idx;
  const container = document.getElementById("panel-container");
  if (container) {
    container.style.transition = "transform 0.3s ease";
    container.style.transform = `translateX(${-idx * window.innerWidth}px)`;
  }
  updateDots();
}

function updateDots() {
  document.querySelectorAll(".panel-dots .dot").forEach((dot, i) => {
    dot.classList.toggle("active", i === workspace.currentPanel);
  });
}

function updateLayout() {
  const container = document.getElementById("panel-container");
  const dots = document.getElementById("panel-dots");
  const resizerL = document.getElementById("panel-resizer-left");
  const resizerR = document.getElementById("panel-resizer-right");

  if (workspace.isMobile) {
    // Mobile: panels side by side, swipeable
    container.classList.add("mobile");
    container.classList.remove("desktop");
    dots.classList.remove("oc-hidden");
    if (resizerL) resizerL.classList.add("oc-hidden");
    if (resizerR) resizerR.classList.add("oc-hidden");
    switchPanel(workspace.currentPanel);
  } else {
    // Desktop: all panels visible
    container.classList.add("desktop");
    container.classList.remove("mobile");
    container.style.transform = "";
    container.style.transition = "";
    dots.classList.add("oc-hidden");
    if (resizerL) resizerL.classList.remove("oc-hidden");
    if (resizerR) resizerR.classList.remove("oc-hidden");
  }
}

// ─── Desktop Resizer ────────────────────────────────────────────────

function setupResizer() {
  const resizerL = document.getElementById("panel-resizer-left");
  const resizerR = document.getElementById("panel-resizer-right");
  const treePanel = document.getElementById("tree-panel");
  const chatPanel = document.getElementById("chat-panel");

  if (resizerL && treePanel) {
    let startX, startWidth;
    resizerL.addEventListener("mousedown", (e) => {
      startX = e.clientX;
      startWidth = treePanel.offsetWidth;
      document.addEventListener("mousemove", onResizeLeft);
      document.addEventListener("mouseup", () => {
        document.removeEventListener("mousemove", onResizeLeft);
      }, { once: true });
    });
    function onResizeLeft(e) {
      const newWidth = Math.max(150, Math.min(500, startWidth + e.clientX - startX));
      treePanel.style.width = newWidth + "px";
      treePanel.style.minWidth = newWidth + "px";
    }
  }

  if (resizerR && chatPanel) {
    let startX, startWidth;
    resizerR.addEventListener("mousedown", (e) => {
      startX = e.clientX;
      startWidth = chatPanel.offsetWidth;
      document.addEventListener("mousemove", onResizeRight);
      document.addEventListener("mouseup", () => {
        document.removeEventListener("mousemove", onResizeRight);
      }, { once: true });
    });
    function onResizeRight(e) {
      const maxChat = Math.max(700, window.innerWidth * 0.8);
      const newWidth = Math.max(300, Math.min(maxChat, startWidth - (e.clientX - startX)));
      chatPanel.style.width = newWidth + "px";
      chatPanel.style.minWidth = newWidth + "px";
    }
  }
}
