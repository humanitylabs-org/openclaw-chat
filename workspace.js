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
    if ((e.metaKey || e.ctrlKey) && e.key === "s" && workspace.editMode) {
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
    <div class="tree-search" id="tree-search" style="padding-top:10px;">
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

  // Settings cogwheel in bottom-left
  const settingsEl = document.createElement("div");
  settingsEl.className = "tree-settings";
  settingsEl.style.position = "relative";
  settingsEl.innerHTML = `
    <div id="tree-settings-popup" class="tree-settings-popup oc-hidden"></div>
    <div style="display:flex;align-items:center;">
      <button class="tree-settings-cogwheel" id="tree-settings-btn" title="Settings" onclick="toggleSettingsPopup()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
      </button>
    </div>
  `;
  treePanel.appendChild(settingsEl);
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
      const r = await fetch(`${baseUrl}/api/files/${tab.path.split("/").map(encodeURIComponent).join("/")}`, { method: "HEAD" });
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
  const el = document.getElementById("fs-status");
  if (!el) return;
  const dot = el.querySelector(".fs-dot");
  if (connected) {
    dot.classList.add("connected");
  } else {
    dot.classList.remove("connected");
  }
}

// ─── File Tree ──────────────────────────────────────────────────────

async function loadFileTree() {
  if (!workspace.fileServerUrl) return;
  try {
    const r = await fetch(`${workspace.fileServerUrl.replace(/\/+$/, "")}/api/files/`);
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
    const r = await fetch(`${baseUrl}/api/files/${filePath.split("/").map(encodeURIComponent).join("/")}`);
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

function closeTab(idx, e) {
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
      <span class="editor-tab-close" onclick="closeTab(${i}, event)">×</span>
    `;
    el.addEventListener("click", () => selectTab(i));
    container.appendChild(el);
  });
}

function renderEditorContent() {
  const area = document.getElementById("editor-area");
  if (!area) return;

  if (workspace.activeTabIdx < 0 || !workspace.openTabs[workspace.activeTabIdx]) {
    area.innerHTML = '<div class="editor-empty">Open a file from the file tree</div>';
    return;
  }

  const tab = workspace.openTabs[workspace.activeTabIdx];

  // Save scroll position before re-render
  const prevScrollTop = workspace._editorScrollTop || 0;

  if (workspace.editMode) {
    area.innerHTML = `
      <textarea class="editor-textarea" id="editor-textarea" spellcheck="false">${escapeHtml(tab.content)}</textarea>
      <div class="editor-mode-indicator edit" id="editor-mode-indicator">Edit</div>
    `;
    const textarea = document.getElementById("editor-textarea");
    // Restore scroll position
    textarea.scrollTop = prevScrollTop;
    // Autosave with debounce
    let autosaveTimer = null;
    textarea.addEventListener("input", () => {
      tab.content = textarea.value;
      tab.dirty = tab.content !== tab.savedContent;
      renderEditorTabs();
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        if (tab.dirty) saveCurrentFile();
      }, 1000);
    });
    // Track scroll position
    textarea.addEventListener("scroll", () => {
      workspace._editorScrollTop = textarea.scrollTop;
    });
    // Support tab key for indentation
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + "  " + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        tab.content = textarea.value;
        tab.dirty = tab.content !== tab.savedContent;
        if (autosaveTimer) clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(() => {
          if (tab.dirty) saveCurrentFile();
        }, 1000);
      }
    });
    // Click outside the textarea (on the editor area) exits edit mode
    // Use mousedown on the editor panel to detect clicks outside
    const exitHandler = (e) => {
      // If clicking on the textarea itself, do nothing
      if (e.target === textarea || textarea.contains(e.target)) return;
      // If clicking on editor tabs, do nothing
      if (e.target.closest(".editor-tab-bar")) return;
      // If clicking the indicator itself, do nothing (it's informational)
      if (e.target.closest(".editor-mode-indicator")) return;
      // Save and exit edit mode
      workspace._editorScrollTop = textarea.scrollTop;
      if (tab.dirty) {
        if (autosaveTimer) clearTimeout(autosaveTimer);
        saveCurrentFile();
      }
      document.removeEventListener("mousedown", exitHandler);
      workspace.editMode = false;
      renderEditorContent();
    };
    // Delay to avoid the same click that entered edit mode from triggering exit
    setTimeout(() => document.addEventListener("mousedown", exitHandler), 100);
    textarea.focus();
  } else {
    const rendered = renderMarkdown(tab.content);
    area.innerHTML = `
      <div class="editor-preview" id="editor-preview-content">${rendered}</div>
      <div class="editor-mode-indicator reading" id="editor-mode-indicator">Reading</div>
    `;
    // Restore scroll position
    const preview = document.getElementById("editor-preview-content");
    if (preview) preview.scrollTop = prevScrollTop;
    // Track scroll position on preview
    if (preview) preview.addEventListener("scroll", () => {
      workspace._editorScrollTop = preview.scrollTop;
    });
    // Double-click to enter edit mode
    if (preview) {
      preview.addEventListener("dblclick", (e) => {
        // Don't trigger on links or checkboxes
        if (e.target.tagName === "A" || e.target.tagName === "INPUT") return;
        workspace._editorScrollTop = preview.scrollTop;
        workspace.editMode = true;
        renderEditorContent();
      });
    }
  }
}

function toggleEditMode() {
  workspace.editMode = !workspace.editMode;
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
    const r = await fetch(`${baseUrl}/api/files/${tab.path.split("/").map(encodeURIComponent).join("/")}`);
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
  if (!popup) return;
  renderSettingsPopup();
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

// Auto-open settings if not fully connected, auto-close when fully connected
function checkAutoOpenSettings() {
  const allConnected = workspace.connected && workspace.chatConnected;
  const popup = document.getElementById("tree-settings-popup");
  if (!popup) return;
  if (!allConnected && popup.classList.contains("oc-hidden")) {
    openSettingsPopup();
  } else if (allConnected && !popup.classList.contains("oc-hidden") && !workspace._settingsEditing) {
    popup.classList.add("oc-hidden");
    workspace._settingsCloseHandler && document.removeEventListener("mousedown", workspace._settingsCloseHandler);
  }
}

function renderSettingsPopup() {
  const popup = document.getElementById("tree-settings-popup");
  if (!popup) return;
  const currentTheme = document.body.getAttribute("data-theme") || "dark";
  const themeIcon = currentTheme === "dark"
    ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M13.5 8.5a5.5 5.5 0 01-6-6 5.5 5.5 0 106 6z"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/></svg>';

  // Get connection info
  let gatewayUrl = '';
  let token = '';
  try {
    const connData = JSON.parse(localStorage.getItem("connection") || '{}');
    gatewayUrl = connData.gatewayUrl || '';
    token = connData.token || '';
  } catch {}
  const filesUp = workspace.connected;
  const chatUp = workspace.chatConnected;
  const allConnected = filesUp && chatUp;
  const connColor = allConnected ? '#4caf50' : (chatUp || filesUp) ? '#ffc107' : '';
  const connLabel = allConnected ? 'Connected' : chatUp ? 'Chat only' : filesUp ? 'Files only' : 'Not connected';
  const isEditing = workspace._settingsEditing || !gatewayUrl || !token;

  popup.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 10px 8px;border-bottom:1px solid var(--background-modifier-border);">
      <img src="/logo-64.png" width="28" height="28" style="border-radius:6px;flex-shrink:0;" alt="">
      <div style="flex:1;">
        <div style="font-size:12px;font-weight:500;color:var(--text-normal);line-height:1.2;">usemyclaw.com</div>
        <div style="font-size:10px;color:var(--text-faint);margin-top:1px;">OpenClaw Web Client</div>
      </div>
      <button onclick="toggleTheme()" title="${currentTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}" style="
        background:none;border:none;color:var(--text-faint);cursor:pointer;
        padding:6px;border-radius:6px;display:flex;align-items:center;
        transition:all 0.15s;
      " onmouseover="this.style.color='var(--text-normal)';this.style.background='rgba(128,128,128,0.1)'"
         onmouseout="this.style.color='var(--text-faint)';this.style.background='none'">
        ${themeIcon}
      </button>
    </div>
    <div style="padding:8px 10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span class="fs-dot ${allConnected ? 'connected' : ''}" style="width:8px;height:8px;flex-shrink:0;${!allConnected && (chatUp || filesUp) ? 'background:#ffc107;box-shadow:0 0 4px rgba(255,193,7,0.3);' : ''}"></span>
        <span style="font-size:12px;${connColor ? 'color:' + connColor : ''};flex:1;">${connLabel}</span>
        ${gatewayUrl && token ? `<button id="settings-modify-btn" onclick="toggleSettingsEditing()" style="
          background:none;border:1px solid var(--background-modifier-border);
          color:var(--text-faint);padding:2px 8px;border-radius:4px;
          font-size:10px;cursor:pointer;transition:all 0.15s;
        ">${workspace._settingsEditing ? 'Cancel' : 'Modify'}</button>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <div>
          <label style="font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;display:block;">Gateway URL</label>
          <input id="settings-gateway-url" class="settings-field-input" type="text"
            value="${escapeHtml(gatewayUrl)}" placeholder="https://your-server.tail1234.ts.net"
            ${isEditing ? '' : 'disabled'}
            style="width:100%;padding:6px 8px;font-size:11px;border-radius:4px;
              background:rgba(128,128,128,0.06);border:1px solid var(--background-modifier-border);
              color:${isEditing ? 'var(--text-normal)' : 'var(--text-faint)'};
              font-family:var(--font-mono,monospace);outline:none;box-sizing:border-box;
              ${isEditing ? '' : 'opacity:0.5;cursor:default;'}">
        </div>
        <div>
          <label style="font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;display:block;">Auth Token</label>
          <input id="settings-token" class="settings-field-input" type="password"
            value="${escapeHtml(token)}" placeholder="Paste your token"
            ${isEditing ? '' : 'disabled'}
            style="width:100%;padding:6px 8px;font-size:11px;border-radius:4px;
              background:rgba(128,128,128,0.06);border:1px solid var(--background-modifier-border);
              color:${isEditing ? 'var(--text-normal)' : 'var(--text-faint)'};
              font-family:var(--font-mono,monospace);outline:none;box-sizing:border-box;
              ${isEditing ? '' : 'opacity:0.5;cursor:default;'}">
        </div>
        ${isEditing ? `
          <button onclick="saveConnectionSettings()" style="
            width:100%;padding:7px;font-size:11px;border-radius:4px;
            background:var(--interactive-accent);color:var(--text-on-accent);
            border:none;cursor:pointer;font-weight:500;transition:opacity 0.15s;
            margin-top:2px;
          ">Save & Reconnect</button>
        ` : ''}
      </div>
      ${!isEditing && !allConnected && (chatUp || filesUp) ? `
        <div style="font-size:10px;color:var(--text-faint);margin-top:6px;padding-top:6px;border-top:1px solid var(--background-modifier-border);">
          ${chatUp && !filesUp ? '⚠ File server not responding.' + (workspace._lastFileError ? '<br><span style="font-family:var(--font-mono,monospace);font-size:9px;opacity:0.7;">' + escapeHtml(workspace._lastFileError) + '</span>' : '') : ''}
          ${filesUp && !chatUp ? '⚠ Chat disconnected.' : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function toggleSettingsEditing() {
  workspace._settingsEditing = !workspace._settingsEditing;
  renderSettingsPopup();
  if (workspace._settingsEditing) {
    // Focus the URL field
    setTimeout(() => {
      const urlInput = document.getElementById("settings-gateway-url");
      if (urlInput) urlInput.focus();
    }, 50);
  }
}

function saveConnectionSettings() {
  const urlInput = document.getElementById("settings-gateway-url");
  const tokenInput = document.getElementById("settings-token");
  if (!urlInput || !tokenInput) return;
  const newUrl = urlInput.value.trim();
  const newToken = tokenInput.value.trim();
  if (!newUrl || !newToken) return;

  // Save to localStorage (single source of truth)
  localStorage.setItem("connection", JSON.stringify({ gatewayUrl: newUrl, token: newToken }));

  workspace._settingsEditing = false;

  // Reconnect file server (derives URL from same gateway)
  workspace.connected = false;
  updateFsStatus(false);
  deriveFileServerUrl();
  if (workspace.fileServerUrl) connectFileServer();

  // Reconnect chat (uses same gateway URL)
  if (typeof state !== 'undefined') {
    state.gatewayUrl = newUrl;
    state.token = newToken;
    if (state.gateway) state.gateway.stop();
    connectToGateway().catch(err => console.error("Reconnect failed:", err));
  }

  renderSettingsPopup();
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
      const newWidth = Math.max(300, Math.min(700, startWidth - (e.clientX - startX)));
      chatPanel.style.width = newWidth + "px";
      chatPanel.style.minWidth = newWidth + "px";
    }
  }
}
