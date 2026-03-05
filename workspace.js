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
  expandedDirs: new Set(),
};

// ─── Init ───────────────────────────────────────────────────────────

function initWorkspace() {
  const stored = localStorage.getItem("fileServerUrl");
  if (stored) workspace.fileServerUrl = stored;

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
  });

  if (workspace.fileServerUrl) connectFileServer();
  updateLayout();
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
    <div class="tree-header">
      <span class="tree-title">Files</span>
      <button class="tree-refresh-btn" onclick="refreshFileTree()" title="Refresh">↻</button>
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

  // Settings link in file tree for file server URL
  const settingsEl = document.createElement("div");
  settingsEl.className = "tree-settings";
  settingsEl.innerHTML = `
    <div class="tree-settings-row" id="fs-status">
      <span class="fs-dot"></span>
      <span class="fs-label">Not connected</span>
    </div>
    <div class="tree-settings-input oc-hidden" id="fs-input-row">
      <input type="text" id="fs-url-input" placeholder="http://100.x.x.x:18790" value="${workspace.fileServerUrl}">
      <button onclick="saveFileServerUrl()">Connect</button>
    </div>
  `;
  treePanel.appendChild(settingsEl);

  document.getElementById("fs-status").addEventListener("click", () => {
    document.getElementById("fs-input-row").classList.toggle("oc-hidden");
  });
}

// ─── File Server Connection ─────────────────────────────────────────

function connectFileServer() {
  if (!workspace.fileServerUrl) return;
  const baseUrl = workspace.fileServerUrl.replace(/\/+$/, "");

  // Test connection
  fetch(`${baseUrl}/health`)
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        workspace.connected = true;
        updateFsStatus(true);
        loadFileTree();
        connectFileServerWs();
      }
    })
    .catch(() => {
      workspace.connected = false;
      updateFsStatus(false);
    });
}

function connectFileServerWs() {
  if (workspace.fileServerWs) {
    workspace.fileServerWs.close();
    workspace.fileServerWs = null;
  }
  const wsUrl = workspace.fileServerUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws";
  try {
    workspace.fileServerWs = new WebSocket(wsUrl);
    workspace.fileServerWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleFileChange(msg);
      } catch {}
    };
    workspace.fileServerWs.onclose = () => {
      workspace.fileServerWs = null;
      // Reconnect after 5s
      setTimeout(() => {
        if (workspace.connected) connectFileServerWs();
      }, 5000);
    };
    workspace.fileServerWs.onerror = () => {};
  } catch {}
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

function saveFileServerUrl() {
  const input = document.getElementById("fs-url-input");
  workspace.fileServerUrl = input.value.trim();
  localStorage.setItem("fileServerUrl", workspace.fileServerUrl);
  document.getElementById("fs-input-row").classList.add("oc-hidden");
  connectFileServer();
}

function updateFsStatus(connected) {
  const el = document.getElementById("fs-status");
  if (!el) return;
  const dot = el.querySelector(".fs-dot");
  const label = el.querySelector(".fs-label");
  if (connected) {
    dot.classList.add("connected");
    label.textContent = "Connected";
  } else {
    dot.classList.remove("connected");
    label.textContent = "Not connected";
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

function renderFileTree() {
  const container = document.getElementById("tree-content");
  if (!container) return;
  container.innerHTML = "";
  container.appendChild(buildTreeNodes(workspace.tree, 0));
}

function buildTreeNodes(items, depth) {
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const row = document.createElement("div");
    row.className = `tree-item ${item.type === "dir" ? "tree-dir" : "tree-file"}`;
    row.style.paddingLeft = `${12 + depth * 16}px`;

    if (item.type === "dir") {
      const expanded = workspace.expandedDirs.has(item.path);
      row.innerHTML = `<span class="tree-arrow ${expanded ? "open" : ""}">${expanded ? "▾" : "▸"}</span><span class="tree-icon">📁</span><span class="tree-name">${escapeHtml(item.name)}</span>`;
      row.addEventListener("click", () => toggleDir(item.path));
      frag.appendChild(row);

      if (expanded && item.children) {
        const children = buildTreeNodes(item.children, depth + 1);
        frag.appendChild(children);
      }
    } else {
      const isActive = workspace.openTabs[workspace.activeTabIdx]?.path === item.path;
      row.innerHTML = `<span class="tree-icon">${getFileIcon(item.name)}</span><span class="tree-name">${escapeHtml(item.name)}</span>`;
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
  const icons = {
    md: "📝", txt: "📄", json: "📋", js: "🟨", ts: "🔷",
    py: "🐍", html: "🌐", css: "🎨", yaml: "⚙️", yml: "⚙️",
    sh: "💻", jpg: "🖼️", png: "🖼️", gif: "🖼️", svg: "🖼️",
    pdf: "📕", csv: "📊",
  };
  return icons[ext] || "📄";
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

  if (workspace.editMode) {
    area.innerHTML = `
      <div class="editor-toolbar">
        <button class="editor-btn" onclick="toggleEditMode()">Preview</button>
        <button class="editor-btn" onclick="saveCurrentFile()">Save</button>
      </div>
      <textarea class="editor-textarea" id="editor-textarea" spellcheck="false">${escapeHtml(tab.content)}</textarea>
    `;
    const textarea = document.getElementById("editor-textarea");
    textarea.addEventListener("input", () => {
      tab.content = textarea.value;
      tab.dirty = tab.content !== tab.savedContent;
      renderEditorTabs();
    });
    textarea.focus();
  } else {
    const rendered = renderMarkdown(tab.content);
    area.innerHTML = `
      <div class="editor-toolbar">
        <button class="editor-btn" onclick="toggleEditMode()">Edit</button>
        ${tab.dirty ? '<button class="editor-btn" onclick="saveCurrentFile()">Save</button>' : ""}
      </div>
      <div class="editor-preview">${rendered}</div>
    `;
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
  let html = escapeHtml(text);

  // Code blocks (fenced)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Headers
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Bold & italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/_(.+?)_/g, "<em>$1</em>");

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Blockquotes
  html = html.replace(/^&gt;\s+(.+)$/gm, "<blockquote>$1</blockquote>");

  // Horizontal rules
  html = html.replace(/^---+$/gm, "<hr>");

  // Unordered lists
  html = html.replace(/^[\-\*]\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

  // Ordered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;">');

  // Line breaks -> paragraphs
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  html = "<p>" + html + "</p>";

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, "");
  html = html.replace(/<p>\s*(<h[1-6]>)/g, "$1");
  html = html.replace(/(<\/h[1-6]>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*(<pre>)/g, "$1");
  html = html.replace(/(<\/pre>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*(<ul>)/g, "$1");
  html = html.replace(/(<\/ul>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*(<blockquote>)/g, "$1");
  html = html.replace(/(<\/blockquote>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*(<hr>)/g, "$1");
  html = html.replace(/(<hr>)\s*<\/p>/g, "$1");

  return html;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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
        switchPanel(workspace.currentPanel - 1);
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
