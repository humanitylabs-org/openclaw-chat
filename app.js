// OpenClaw Chat PWA
// Ported from ObsidianClaw plugin — full feature parity

// ─── Utilities ───────────────────────────────────────────────────────

function generateId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function str(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}

function normalizeGatewayUrl(raw) {
  let url = raw.trim();
  if (url.startsWith("https://")) url = "wss://" + url.slice(8);
  else if (url.startsWith("http://")) url = "ws://" + url.slice(7);
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) return null;
  return url.replace(/\/+$/, "");
}

function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(data) {
  const hash = await crypto.subtle.digest("SHA-256", data.buffer);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Device Identity (Ed25519) ───────────────────────────────────────

async function getOrCreateDeviceIdentity() {
  const stored = localStorage.getItem("deviceIdentity");
  if (stored) {
    const data = JSON.parse(stored);
    const privBytes = fromBase64Url(data.privateKey);
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8", privBytes, { name: "Ed25519" }, false, ["sign"]
    );
    return { deviceId: data.deviceId, publicKey: data.publicKey, privateKey: data.privateKey, cryptoKey };
  }

  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const deviceId = await sha256Hex(pubRaw);
  const publicKey = toBase64Url(pubRaw);
  const privateKey = toBase64Url(privPkcs8);

  localStorage.setItem("deviceIdentity", JSON.stringify({ deviceId, publicKey, privateKey }));
  return { deviceId, publicKey, privateKey, cryptoKey: keyPair.privateKey };
}

async function signDevicePayload(identity, payload) {
  const encoded = new TextEncoder().encode(payload);
  let cryptoKey = identity.cryptoKey;
  if (!cryptoKey) {
    const privBytes = fromBase64Url(identity.privateKey);
    cryptoKey = await crypto.subtle.importKey("pkcs8", privBytes, { name: "Ed25519" }, false, ["sign"]);
  }
  const sig = await crypto.subtle.sign("Ed25519", cryptoKey, encoded);
  return toBase64Url(new Uint8Array(sig));
}

function buildSignaturePayload(params) {
  const version = params.nonce ? "v2" : "v1";
  const parts = [
    version, params.deviceId, params.clientId, params.clientMode,
    params.role, params.scopes.join(","), String(params.signedAtMs), params.token ?? "",
  ];
  if (version === "v2") parts.push(params.nonce ?? "");
  return parts.join("|");
}

// ─── Gateway Client ──────────────────────────────────────────────────

class GatewayClient {
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.pending = new Map();
    this.pendingTimeouts = new Map();
    this.closed = false;
    this.connectSent = false;
    this.connectNonce = null;
    this.backoffMs = 800;
    this.connectTimer = null;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start() {
    this.closed = false;
    this.doConnect();
  }

  stop() {
    this.closed = true;
    if (this.connectTimer !== null) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    for (const [, t] of this.pendingTimeouts) clearTimeout(t);
    this.pendingTimeouts.clear();
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("client stopped"));
  }

  async request(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("not connected");
    const id = generateId();
    const msg = { type: "req", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("request timeout")); }
      }, 30000);
      this.pendingTimeouts.set(id, t);
      this.ws.send(JSON.stringify(msg));
    });
  }

  doConnect() {
    if (this.closed) return;
    const url = normalizeGatewayUrl(this.opts.url);
    if (!url) { console.error("Invalid gateway URL"); return; }

    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => this.queueConnect());
    this.ws.addEventListener("message", (e) => this.handleMessage(e.data));
    this.ws.addEventListener("close", (e) => {
      this.ws = null;
      this.flushPending(new Error(`closed (${e.code})`));
      this.opts.onClose?.({ code: e.code, reason: e.reason || "" });
      this.scheduleReconnect();
    });
    this.ws.addEventListener("error", () => {});
  }

  scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15000);
    setTimeout(() => this.doConnect(), delay);
  }

  flushPending(err) {
    for (const [id, p] of this.pending) {
      const t = this.pendingTimeouts.get(id);
      if (t) clearTimeout(t);
      p.reject(err);
    }
    this.pending.clear();
    this.pendingTimeouts.clear();
  }

  queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => this.sendConnect(), 750);
  }

  async sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer !== null) { clearTimeout(this.connectTimer); this.connectTimer = null; }

    const CLIENT_ID = "gateway-client";
    const CLIENT_MODE = "ui";
    const ROLE = "operator";
    const SCOPES = ["operator.admin", "operator.write", "operator.read"];
    const auth = this.opts.token ? { token: this.opts.token } : undefined;

    let device = undefined;
    const identity = this.opts.deviceIdentity;
    if (identity) {
      try {
        const signedAtMs = Date.now();
        const nonce = this.connectNonce ?? null;
        const payload = buildSignaturePayload({
          deviceId: identity.deviceId, clientId: CLIENT_ID, clientMode: CLIENT_MODE,
          role: ROLE, scopes: SCOPES, signedAtMs, token: this.opts.token ?? null, nonce,
        });
        const signature = await signDevicePayload(identity, payload);
        device = { id: identity.deviceId, publicKey: identity.publicKey, signature, signedAt: signedAtMs, nonce: nonce ?? undefined };
      } catch (err) { console.error("Failed to sign device payload:", err); }
    }

    const params = {
      minProtocol: 3, maxProtocol: 3,
      client: { id: CLIENT_ID, version: "0.1.0", platform: "web", mode: CLIENT_MODE },
      role: ROLE, scopes: SCOPES, auth, device, caps: ["tool-events"],
    };

    this.request("connect", params)
      .then((payload) => { this.backoffMs = 800; this.opts.onHello?.(payload); })
      .catch(() => { this.ws?.close(4008, "connect failed"); });
  }

  handleMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === "res") {
      const p = this.pending.get(msg.id);
      if (p) {
        const t = this.pendingTimeouts.get(msg.id);
        if (t) clearTimeout(t);
        this.pending.delete(msg.id);
        this.pendingTimeouts.delete(msg.id);
        if (msg.ok) p.resolve(msg.payload);
        else p.reject(new Error(msg.error?.message || "request failed"));
      }
      return;
    }

    if (msg.type === "event") {
      if (msg.event === "connect.challenge") {
        const nonce = msg.payload?.nonce;
        if (typeof nonce === "string") {
          this.connectNonce = nonce;
          this.connectSent = false;
          void this.sendConnect();
        }
        return;
      }
      this.opts.onEvent?.(msg);
    }
  }
}

// ─── Session Delete with Fallback ────────────────────────────────────

async function deleteSessionWithFallback(gateway, key, deleteTranscript = true) {
  const result = await gateway.request("sessions.delete", { key, deleteTranscript });
  if (result?.deleted) return true;
  const match = key.match(/^agent:[^:]+:(.+)$/);
  if (match) {
    const retry = await gateway.request("sessions.delete", { key: match[1], deleteTranscript });
    return !!retry?.deleted;
  }
  return false;
}

// ─── App State ───────────────────────────────────────────────────────

const state = {
  gatewayUrl: "",
  token: "",
  deviceIdentity: null,
  gateway: null,
  sessionKey: "main",
  messages: [],

  // Agents
  agents: [],
  activeAgent: { id: "main", name: "Agent", emoji: "🤖", creature: "" },

  // Model
  currentModel: "",
  currentModelSetAt: 0,

  // Tabs
  tabSessions: [],
  renderingTabs: false,
  tabDeleteInProgress: false,

  // Stream state (per-session)
  streams: new Map(),
  runToSession: new Map(),
  streamEl: null,

  // Attachments
  pendingAttachments: [],
  sending: false,
};

// ─── Agent prefix helper ─────────────────────────────────────────────

function agentPrefix() {
  return `agent:${state.activeAgent.id}:`;
}

// ─── UI Elements ─────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const ui = {
  // Onboarding
  onboarding: $("onboarding"),
  step1: $("step1"),
  step2: $("step2"),
  step3: $("step3"),
  gatewayUrlInput: $("gateway-url"),
  tokenInput: $("token"),
  connectBtn: $("connect-btn"),
  connectStatus: $("connect-status"),
  requestId: $("request-id"),
  startChatBtn: $("start-chat-btn"),

  // Chat
  chatContainer: $("chat-container"),
  tabBar: $("tab-bar"),
  agentBtn: $("agent-btn"),
  agentDropdown: $("agent-dropdown"),
  statusBanner: $("status-banner"),
  messagesContainer: $("messages"),
  messageInput: $("message-input"),
  brainBtn: $("brain-btn"),
  attachBtn: $("attach-btn"),
  fileInput: $("file-input"),
  attachPreview: $("attach-preview"),
  sendBtn: $("send-btn"),
  reconnectBtn: $("reconnect-btn"),
  abortBtn: $("abort-btn"),
  connectionStatus: $("connection-status"),
  typingIndicator: $("typing-indicator"),
  modelLabel: $("model-label"),
};

// ─── Onboarding Flow ─────────────────────────────────────────────────

async function initApp() {
  const stored = localStorage.getItem("connection");
  if (stored) {
    const data = JSON.parse(stored);
    state.gatewayUrl = data.gatewayUrl;
    state.token = data.token;
    state.sessionKey = localStorage.getItem("sessionKey") || "main";
    state.currentModel = localStorage.getItem("currentModel") || "";
    state.activeAgent = JSON.parse(localStorage.getItem("activeAgent") || '{"id":"main","name":"Agent","emoji":"🤖","creature":""}');
    state.deviceIdentity = await getOrCreateDeviceIdentity();

    const approvalStatus = localStorage.getItem("deviceApproved");
    if (approvalStatus === "true") {
      await startChat();
      return;
    }
  }

  ui.onboarding.style.display = "flex";
  ui.chatContainer.classList.remove("active");
}

ui.connectBtn.addEventListener("click", async () => {
  const gatewayUrl = ui.gatewayUrlInput.value.trim();
  const token = ui.tokenInput.value.trim();
  if (!gatewayUrl || !token) { showStatus("Please fill in both fields", "error"); return; }

  ui.connectBtn.disabled = true;
  showStatus("Connecting...", "info");

  try {
    state.gatewayUrl = gatewayUrl;
    state.token = token;
    state.deviceIdentity = await getOrCreateDeviceIdentity();
    localStorage.setItem("connection", JSON.stringify({ gatewayUrl, token }));

    ui.step1.classList.add("hidden");
    ui.step2.classList.remove("hidden");
    ui.requestId.textContent = state.deviceIdentity.deviceId.slice(0, 16);
    await connectToGateway();
  } catch (err) {
    console.error("Connection error:", err);
    showStatus("Connection failed: " + err.message, "error");
    ui.connectBtn.disabled = false;
  }
});

ui.startChatBtn.addEventListener("click", () => startChat());

function showStatus(message, type) {
  ui.connectStatus.textContent = message;
  ui.connectStatus.className = `status-message ${type}`;
  ui.connectStatus.classList.remove("hidden");
}

async function connectToGateway() {
  return new Promise((resolve, reject) => {
    let helloReceived = false;

    state.gateway = new GatewayClient({
      url: state.gatewayUrl,
      token: state.token,
      deviceIdentity: state.deviceIdentity,
      onHello: (payload) => {
        console.log("Connected to gateway:", payload);
        helloReceived = true;
        localStorage.setItem("deviceApproved", "true");

        if (!ui.step2.classList.contains("hidden")) {
          ui.step2.classList.add("hidden");
          ui.step3.classList.remove("hidden");
        }

        updateConnectionStatus(true);
        resolve();
      },
      onClose: (info) => {
        console.log("Gateway connection closed:", info);
        updateConnectionStatus(false);
        if (!helloReceived && info.reason === "pairing required") {
          showStatus("Device needs approval. Please approve in Control UI.", "info");
        }
      },
      onEvent: handleGatewayEvent,
    });

    state.gateway.start();

    setTimeout(() => {
      if (!helloReceived) reject(new Error("Connection timeout - device may need approval"));
    }, 30000);
  });
}

async function startChat() {
  ui.onboarding.style.display = "none";
  ui.chatContainer.classList.add("active");

  if (!state.gateway || !state.gateway.connected) {
    state.deviceIdentity = await getOrCreateDeviceIdentity();
    await connectToGateway();
  }

  updateConnectionStatus(true);
  await loadAgents();
  await loadChatHistory();
  await renderTabs();
  updateModelLabel();

  // Start periodic context meter updates
  setInterval(() => updateContextMeter(), 15000);
}

function updateConnectionStatus(connected) {
  if (connected) {
    ui.connectionStatus.classList.add("connected");
    ui.sendBtn.classList.remove("oc-hidden");
    ui.reconnectBtn.classList.add("oc-hidden");
    ui.messageInput.disabled = false;
    ui.messageInput.placeholder = "Message...";
  } else {
    ui.connectionStatus.classList.remove("connected");
    ui.sendBtn.classList.add("oc-hidden");
    ui.reconnectBtn.classList.remove("oc-hidden");
    ui.messageInput.disabled = true;
    ui.messageInput.placeholder = "Disconnected";
  }
}

// ─── Agent Management ────────────────────────────────────────────────

async function loadAgents() {
  if (!state.gateway?.connected) return;
  try {
    const result = await state.gateway.request("agents.list", {});
    const agentList = result?.agents || [];
    if (agentList.length === 0) agentList.push({ id: "main" });

    state.agents = agentList.map(a => ({
      id: a.id || "main",
      name: a.name || a.id || "Agent",
      emoji: "🤖",
      creature: a.creature || "",
    }));

    // Set active agent
    const saved = state.activeAgent;
    const active = state.agents.find(a => a.id === saved.id) || state.agents[0];
    if (active) {
      state.activeAgent = active;
      localStorage.setItem("activeAgent", JSON.stringify(active));
    }

    updateAgentButton();
  } catch (err) {
    console.warn("Failed to load agents:", err);
  }
}

function updateAgentButton() {
  if (state.agents.length <= 1) {
    ui.agentBtn.classList.add("oc-hidden");
    return;
  }
  ui.agentBtn.classList.remove("oc-hidden");
  ui.agentBtn.querySelector(".openclaw-agent-emoji-btn").textContent = state.activeAgent.emoji || "🤖";
}

async function switchAgent(agent) {
  if (agent.id === state.activeAgent.id) return;
  state.activeAgent = agent;
  state.sessionKey = "main";
  localStorage.setItem("activeAgent", JSON.stringify(agent));
  localStorage.setItem("sessionKey", "main");
  updateAgentButton();
  state.messages = [];
  ui.messagesContainer.innerHTML = "";
  await loadChatHistory();
  await renderTabs();
}

function toggleAgentDropdown() {
  const dd = ui.agentDropdown;
  if (!dd.classList.contains("oc-hidden")) {
    dd.classList.add("oc-hidden");
    return;
  }
  dd.innerHTML = "";
  for (const agent of state.agents) {
    const isActive = agent.id === state.activeAgent.id;
    const item = document.createElement("div");
    item.className = `openclaw-agent-item${isActive ? " active" : ""}`;
    item.innerHTML = `
      <span class="openclaw-agent-item-emoji">${agent.emoji || "🤖"}</span>
      <div class="openclaw-agent-item-info">
        <div class="openclaw-agent-item-name">${agent.name}</div>
        ${agent.creature ? `<div class="openclaw-agent-item-sub">${agent.creature}</div>` : ""}
      </div>
    `;
    if (!isActive) {
      item.addEventListener("click", () => {
        dd.classList.add("oc-hidden");
        switchAgent(agent);
      });
    }
    dd.appendChild(item);
  }
  dd.classList.remove("oc-hidden");
}

ui.agentBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleAgentDropdown(); });
document.addEventListener("click", () => ui.agentDropdown.classList.add("oc-hidden"));

// ─── Tab Management ──────────────────────────────────────────────────

async function renderTabs() {
  if (!ui.tabBar || state.renderingTabs) return;
  state.renderingTabs = true;
  try { await _renderTabsInner(); } finally { state.renderingTabs = false; }
}

async function _renderTabsInner() {
  ui.tabBar.innerHTML = "";
  const currentKey = state.sessionKey || "main";

  let sessions = [];
  if (state.gateway?.connected) {
    try {
      const result = await state.gateway.request("sessions.list", {});
      sessions = result?.sessions || [];
    } catch { /* use empty */ }
  }

  const prefix = agentPrefix();
  const convSessions = sessions.filter(s => {
    if (!s.key.startsWith(prefix)) return false;
    if (s.key.includes(":cron:")) return false;
    if (s.key.includes(":subagent:")) return false;
    return true;
  });

  // Build tab list
  state.tabSessions = [];
  const mainSession = convSessions.find(s => s.key === `${prefix}main`);
  if (mainSession) {
    const used = mainSession.totalTokens || 0;
    const max = mainSession.contextTokens || 200000;
    state.tabSessions.push({ key: "main", label: "Main", pct: Math.min(100, Math.round((used / max) * 100)) });
  } else {
    state.tabSessions.push({ key: "main", label: "Main", pct: 0 });
  }

  const others = convSessions
    .filter(s => s.key.slice(prefix.length) !== "main")
    .sort((a, b) => (a.createdAt || a.updatedAt || 0) - (b.createdAt || b.updatedAt || 0));
  let num = 1;
  for (const s of others) {
    const sk = s.key.slice(prefix.length);
    const used = s.totalTokens || 0;
    const max = s.contextTokens || 200000;
    const pct = Math.min(100, Math.round((used / max) * 100));
    const label = s.label || s.displayName || String(num);
    state.tabSessions.push({ key: sk, label, pct });
    num++;
  }

  // Render each tab
  for (const tab of state.tabSessions) {
    const isCurrent = tab.key === currentKey;
    const tabEl = document.createElement("div");
    tabEl.className = `openclaw-tab${isCurrent ? " active" : ""}`;

    const row = document.createElement("div");
    row.className = "openclaw-tab-row";
    const label = document.createElement("span");
    label.className = "openclaw-tab-label";
    label.textContent = tab.label;
    row.appendChild(label);

    // × button
    const closeBtn = document.createElement("span");
    closeBtn.className = "openclaw-tab-close";
    closeBtn.textContent = "×";
    const isResetOnly = tab.key === "main";

    if (isResetOnly) {
      closeBtn.title = "Reset conversation";
      closeBtn.addEventListener("click", (e) => { e.stopPropagation(); resetTab(tab); });
    } else {
      closeBtn.title = "Close tab";
      closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab, currentKey); });
    }
    row.appendChild(closeBtn);
    tabEl.appendChild(row);

    // Meter bar
    const meter = document.createElement("div");
    meter.className = "openclaw-tab-meter";
    const fill = document.createElement("div");
    fill.className = "openclaw-tab-meter-fill";
    fill.style.width = tab.pct + "%";
    meter.appendChild(fill);
    tabEl.appendChild(meter);

    // Click to switch
    if (!isCurrent) {
      tabEl.addEventListener("click", () => switchTab(tab));
    }

    ui.tabBar.appendChild(tabEl);
  }

  // + button
  const addBtn = document.createElement("div");
  addBtn.className = "openclaw-tab openclaw-tab-add";
  addBtn.innerHTML = '<span class="openclaw-tab-label">+</span>';
  addBtn.addEventListener("click", () => createNewTab());
  ui.tabBar.appendChild(addBtn);
}

async function switchTab(tab) {
  state.streamEl = null;
  ui.typingIndicator.classList.add("oc-hidden");
  ui.abortBtn.classList.add("oc-hidden");
  hideBanner();

  state.sessionKey = tab.key;
  localStorage.setItem("sessionKey", tab.key);
  state.messages = [];
  ui.messagesContainer.innerHTML = "";
  await loadChatHistory();

  // Restore stream UI if tab has active stream
  restoreStreamUI();
  await updateContextMeter();
  renderTabs();
}

async function resetTab(tab) {
  if (!state.gateway?.connected) return;
  try {
    await state.gateway.request("chat.send", {
      sessionKey: tab.key,
      message: "/reset",
      deliver: false,
      idempotencyKey: "reset-" + Date.now(),
    });
    if (tab.key === state.sessionKey) {
      state.messages = [];
      ui.messagesContainer.innerHTML = "";
    }
    await updateContextMeter();
    await renderTabs();
  } catch (err) {
    console.error("Reset failed:", err);
  }
}

async function closeTab(tab, currentKey) {
  if (!state.gateway?.connected || state.tabDeleteInProgress) return;
  state.tabDeleteInProgress = true;
  try {
    await deleteSessionWithFallback(state.gateway, `${agentPrefix()}${tab.key}`);
  } catch (err) {
    console.error("Close failed:", err);
  }
  // Clean up stream state
  finishStream(tab.key);
  // Switch to main if closed active tab
  if (tab.key === currentKey) {
    state.sessionKey = "main";
    localStorage.setItem("sessionKey", "main");
    state.messages = [];
    ui.messagesContainer.innerHTML = "";
    await loadChatHistory();
  }
  state.tabDeleteInProgress = false;
  await renderTabs();
  await updateContextMeter();
}

async function createNewTab() {
  if (!state.gateway?.connected) return;
  const nums = state.tabSessions.map(t => parseInt(t.label)).filter(n => !isNaN(n));
  const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  const sessionKey = `tab-${nextNum}`;
  try {
    await state.gateway.request("chat.send", {
      sessionKey: sessionKey,
      message: "/new",
      deliver: false,
      idempotencyKey: "newtab-" + Date.now(),
    });
    await new Promise(r => setTimeout(r, 500));
    try {
      await state.gateway.request("sessions.patch", {
        key: `${agentPrefix()}${sessionKey}`,
        label: String(nextNum),
      });
    } catch { /* label optional */ }

    state.streamEl = null;
    ui.typingIndicator.classList.add("oc-hidden");
    ui.abortBtn.classList.add("oc-hidden");
    hideBanner();

    state.sessionKey = sessionKey;
    localStorage.setItem("sessionKey", sessionKey);
    state.messages = [];
    ui.messagesContainer.innerHTML = "";
    await renderTabs();
    await updateContextMeter();
  } catch (err) {
    console.error("Failed to create tab:", err);
  }
}

// ─── Context Meter ───────────────────────────────────────────────────

async function updateContextMeter() {
  if (!state.gateway?.connected) return;
  try {
    const result = await state.gateway.request("sessions.list", {});
    const sessions = result?.sessions || [];
    const sk = state.sessionKey || "main";
    const prefix = agentPrefix();
    const session = sessions.find(s => s.key === sk) ||
      sessions.find(s => s.key === `${prefix}${sk}`) ||
      sessions.find(s => s.key.endsWith(`:${sk}`));
    if (!session) return;

    // Update model from session
    const fullModel = session.model || "";
    const modelCooldown = Date.now() - state.currentModelSetAt < 15000;
    if (fullModel && fullModel !== state.currentModel && !modelCooldown) {
      state.currentModel = fullModel;
      localStorage.setItem("currentModel", fullModel);
      updateModelLabel();
    }

    // Update active tab meter
    const activeFill = ui.tabBar?.querySelector(".openclaw-tab.active .openclaw-tab-meter-fill");
    if (activeFill) {
      const used = session.totalTokens || 0;
      const max = session.contextTokens || 200000;
      const pct = Math.min(100, Math.round((used / max) * 100));
      activeFill.style.width = pct + "%";
    }

    // Detect session changes and re-render tabs
    const currentSessionKeys = new Set(
      sessions.filter(s => s.key.startsWith(prefix) && !s.key.includes(":cron:") && !s.key.includes(":subagent:")).map(s => s.key)
    );
    const trackedKeys = new Set(state.tabSessions.map(t => `${prefix}${t.key}`));
    const added = [...currentSessionKeys].some(k => !trackedKeys.has(k));
    const removed = [...trackedKeys].some(k => !currentSessionKeys.has(k));
    if ((added || removed) && !state.tabDeleteInProgress) {
      if (removed && !currentSessionKeys.has(`${prefix}${sk}`)) {
        state.sessionKey = "main";
        localStorage.setItem("sessionKey", "main");
        state.messages = [];
        ui.messagesContainer.innerHTML = "";
        await loadChatHistory();
      }
      await renderTabs();
    }
  } catch { /* ignore */ }
}

// ─── Model Management ────────────────────────────────────────────────

function shortModelName(fullId) {
  const model = fullId.includes("/") ? fullId.split("/")[1] : fullId;
  return model.replace(/^claude-/, "");
}

function updateModelLabel() {
  if (!state.currentModel) {
    ui.modelLabel.textContent = "";
    return;
  }
  ui.modelLabel.textContent = shortModelName(state.currentModel) + " ▾";
}

async function openModelPicker() {
  let models = [];
  try {
    const result = await state.gateway?.request("models.list", {});
    models = result?.models || [];
  } catch { models = []; }

  // Normalize current model
  let currentModel = state.currentModel || "";
  if (currentModel && !currentModel.includes("/")) {
    const match = models.find(m => m.id === currentModel);
    if (match) currentModel = `${match.provider}/${match.id}`;
  }

  // Group by provider
  const providerMap = new Map();
  for (const m of models) {
    const p = m.provider || "unknown";
    if (!providerMap.has(p)) providerMap.set(p, []);
    providerMap.get(p).push(m);
  }

  const providers = [...providerMap.keys()];
  const currentProvider = currentModel.includes("/") ? currentModel.split("/")[0] : "";

  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

  const box = document.createElement("div");
  box.className = "modal";

  if (providers.length > 1) {
    renderProviderList(box, providerMap, currentModel, currentProvider, modal);
  } else if (providers.length === 1) {
    renderModelList(box, providerMap.get(providers[0]), providers[0], currentModel, modal, null);
  } else {
    box.innerHTML = "<h3>No models available</h3>";
  }

  modal.appendChild(box);
  document.body.appendChild(modal);
}

function renderProviderList(box, providerMap, currentModel, currentProvider, modal) {
  box.innerHTML = "<h3>Select Provider</h3>";
  const list = document.createElement("div");
  list.className = "openclaw-picker-list";

  for (const [provider, models] of providerMap) {
    const isCurrent = provider === currentProvider;
    const row = document.createElement("div");
    row.className = `openclaw-picker-row${isCurrent ? " active" : ""}`;
    row.innerHTML = `
      <div class="openclaw-picker-row-left">
        ${isCurrent ? '<span class="openclaw-picker-dot">● </span>' : ""}
        <span style="font-weight:500">${provider}</span>
      </div>
      <div class="openclaw-picker-row-right">
        <span class="openclaw-picker-meta">${models.length} model${models.length !== 1 ? "s" : ""}</span>
        <span class="openclaw-picker-arrow">→</span>
      </div>
    `;
    row.addEventListener("click", () => {
      box.innerHTML = "";
      renderModelList(box, models, provider, currentModel, modal, providerMap);
    });
    list.appendChild(row);
  }
  box.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "openclaw-picker-footer";
  footer.innerHTML = 'Want more models? <a href="https://docs.openclaw.ai/gateway/configuration#choose-and-configure-models" target="_blank">Add them in your gateway config.</a>';
  box.appendChild(footer);
}

function renderModelList(box, models, provider, currentModel, modal, providerMap) {
  box.innerHTML = "";

  if (providerMap && providerMap.size > 1) {
    const backBtn = document.createElement("button");
    backBtn.className = "openclaw-picker-back";
    backBtn.textContent = "← " + provider;
    backBtn.addEventListener("click", () => {
      box.innerHTML = "";
      const currentProvider = currentModel.includes("/") ? currentModel.split("/")[0] : "";
      renderProviderList(box, providerMap, currentModel, currentProvider, modal);
    });
    box.appendChild(backBtn);
  }

  const list = document.createElement("div");
  list.className = "openclaw-picker-list";

  for (const m of models) {
    const fullId = `${m.provider}/${m.id}`;
    const isCurrent = fullId === currentModel;
    const row = document.createElement("div");
    row.className = `openclaw-picker-row${isCurrent ? " active" : ""}`;
    row.innerHTML = `
      <div class="openclaw-picker-row-left">
        ${isCurrent ? '<span class="openclaw-picker-dot">● </span>' : ""}
        <span>${m.name || m.id}</span>
      </div>
    `;
    row.addEventListener("click", async () => {
      if (!state.gateway?.connected) return;
      row.className = "openclaw-picker-row openclaw-picker-selecting";
      row.textContent = "Switching...";
      try {
        await state.gateway.request("chat.send", {
          sessionKey: state.sessionKey,
          message: `/model ${fullId}`,
          deliver: false,
          idempotencyKey: "model-" + Date.now(),
        });
        state.currentModel = fullId;
        state.currentModelSetAt = Date.now();
        localStorage.setItem("currentModel", fullId);
        updateModelLabel();
        modal.remove();
      } catch (err) {
        console.error("Model switch failed:", err);
        row.className = "openclaw-picker-row";
        row.textContent = m.name || m.id;
      }
    });
    list.appendChild(row);
  }
  box.appendChild(list);
}

// ─── Chat Functions ──────────────────────────────────────────────────

async function loadChatHistory() {
  if (!state.gateway?.connected) return;
  try {
    const result = await state.gateway.request("chat.history", {
      sessionKey: state.sessionKey,
      limit: 200,
    });

    const messages = result?.messages || [];
    state.messages = messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => {
        const { text, images } = extractContent(m.content);
        return {
          role: m.role,
          text,
          images,
          timestamp: m.timestamp ?? Date.now(),
          contentBlocks: Array.isArray(m.content) ? m.content : undefined,
        };
      })
      .filter(m => (m.text.trim() || m.images.length > 0) && !m.text.startsWith("HEARTBEAT"));

    // Hide first user message (typically system prompt)
    if (state.messages.length > 0 && state.messages[0].role === "user") {
      state.messages = state.messages.slice(1);
    }

    renderMessages();
  } catch (err) {
    console.error("Failed to load chat history:", err);
  }
}

function extractContent(content) {
  let text = "";
  const images = [];

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === "text") {
        text += (text ? "\n" : "") + (c.text || "");
      } else if (c.type === "tool_result") {
        const trContent = c.content;
        if (typeof trContent === "string") {
          text += (text ? "\n" : "") + trContent;
        } else if (Array.isArray(trContent)) {
          for (const tc of trContent) {
            if (tc?.type === "text" && tc.text) text += (text ? "\n" : "") + tc.text;
          }
        }
      } else if (c.type === "image_url" && c.image_url?.url) {
        images.push(c.image_url.url);
      }
    }
  }

  // Extract inline data URIs
  const dataUriRegex = /(?:^|\n)data:(image\/[^;]+);base64,[A-Za-z0-9+/=\n]+/g;
  let match;
  while ((match = dataUriRegex.exec(text)) !== null) {
    images.push(match[0].replace(/^\n/, "").trim());
  }
  text = text.replace(/\n?data:image\/[^;]+;base64,[A-Za-z0-9+/=\n]+/g, "").trim();
  text = text.replace(/^\[Attached image:.*?\]\s*/gm, "").trim();
  text = text.replace(/^File saved at:.*$/gm, "").trim();
  text = text.replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, "").trim();
  text = text.replace(/^```json\s*\{\s*"message_id"[\s\S]*?```\s*/gm, "").trim();
  text = text.replace(/^\[.*?GMT[+-]\d+\]\s*/gm, "").trim();
  text = text.replace(/^\[media attached:.*?\]\s*/gm, "").trim();
  text = text.replace(/^To send an image back.*$/gm, "").trim();
  if (text === "NO_REPLY" || text === "HEARTBEAT_OK") text = "";
  return { text, images };
}

function cleanText(text) {
  text = text.replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, "").trim();
  text = text.replace(/^```json\s*\{\s*"message_id"[\s\S]*?```\s*/gm, "").trim();
  text = text.replace(/^\[.*?GMT[+-]\d+\]\s*/gm, "").trim();
  text = text.replace(/^\[media attached:.*?\]\s*/gm, "").trim();
  text = text.replace(/^To send an image back.*$/gm, "").trim();
  text = text.replace(/^\[\[audio_as_voice\]\]\s*/gm, "").trim();
  text = text.replace(/^MEDIA:\/[^\n]+$/gm, "").trim();
  text = text.replace(/^VOICE:[^\s\n]+$/gm, "").trim();
  text = text.replace(/^AUDIO_DATA:[^\n]+$/gm, "").trim();
  if (text === "NO_REPLY" || text === "HEARTBEAT_OK") return "";
  return text;
}

function extractVoiceRefs(text) {
  const refs = [];
  const re = /^VOICE:([^\s\n]+\.(?:mp3|opus|ogg|wav|m4a|mp4))$/gm;
  let match;
  while ((match = re.exec(text)) !== null) refs.push(match[1].trim());
  return refs;
}

function buildVoiceUrl(voicePath) {
  const gwUrl = state.gatewayUrl || "";
  const httpUrl = gwUrl.replace(/^ws(s?):\/\//, "http$1://");
  return `${httpUrl}/${voicePath}`;
}

function renderMessages() {
  ui.messagesContainer.innerHTML = "";
  for (const msg of state.messages) {
    if (msg.role === "assistant") {
      const hasContentTools = msg.contentBlocks?.some(b => b.type === "tool_use" || b.type === "toolCall") || false;
      if (hasContentTools && msg.contentBlocks) {
        for (const block of msg.contentBlocks) {
          if (block.type === "text" && block.text?.trim()) {
            const blockAudio = extractVoiceRefs(block.text);
            const cleaned = cleanText(block.text);
            if (cleaned) {
              const bubble = document.createElement("div");
              bubble.className = "openclaw-msg openclaw-msg-assistant";
              const textDiv = document.createElement("div");
              textDiv.className = "openclaw-msg-text";
              textDiv.innerHTML = formatMarkdown(cleaned);
              bubble.appendChild(textDiv);
              for (const ap of blockAudio) renderAudioPlayer(bubble, ap);
              ui.messagesContainer.appendChild(bubble);
            } else if (blockAudio.length > 0) {
              const bubble = document.createElement("div");
              bubble.className = "openclaw-msg openclaw-msg-assistant";
              for (const ap of blockAudio) renderAudioPlayer(bubble, ap);
              ui.messagesContainer.appendChild(bubble);
            }
          } else if (block.type === "tool_use" || block.type === "toolCall") {
            const { label, url } = buildToolLabel(block.name || "", block.input || block.arguments || {});
            appendToolCall(label, url);
          }
        }
        continue;
      }
    }

    appendMessage(msg);
  }
  scrollToBottom();
}

function appendMessage(msg) {
  const cls = msg.role === "user" ? "openclaw-msg-user" : "openclaw-msg-assistant";
  const bubble = document.createElement("div");
  bubble.className = `openclaw-msg ${cls}`;

  // Images
  if (msg.images && msg.images.length > 0) {
    const imgContainer = document.createElement("div");
    imgContainer.className = "openclaw-msg-images";
    for (const src of msg.images) {
      const img = document.createElement("img");
      img.className = "openclaw-msg-img";
      img.src = src;
      img.loading = "lazy";
      img.addEventListener("click", () => {
        const overlay = document.createElement("div");
        overlay.className = "openclaw-img-overlay";
        const fullImg = document.createElement("img");
        fullImg.src = src;
        overlay.appendChild(fullImg);
        overlay.addEventListener("click", () => overlay.remove());
        document.body.appendChild(overlay);
      });
      imgContainer.appendChild(img);
    }
    bubble.appendChild(imgContainer);
  }

  // Voice refs
  const allAudio = msg.text ? extractVoiceRefs(msg.text) : [];

  // Text
  let displayText = "";
  if (typeof msg.text === "string") displayText = msg.text;
  else if (typeof msg.content === "string") displayText = msg.content;
  else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "text") displayText += (block.text || "");
    }
  }

  if (msg.role === "assistant") displayText = cleanText(displayText);

  if (displayText) {
    const textDiv = document.createElement("div");
    textDiv.className = "openclaw-msg-text";
    if (msg.role === "assistant") {
      textDiv.innerHTML = formatMarkdown(displayText);
    } else {
      textDiv.textContent = displayText;
    }
    bubble.appendChild(textDiv);
  }

  // Audio players
  for (const ap of allAudio) renderAudioPlayer(bubble, ap);

  ui.messagesContainer.appendChild(bubble);
}

function renderAudioPlayer(container, voiceRef) {
  const playerEl = document.createElement("div");
  playerEl.className = "openclaw-audio-player";
  const playBtn = document.createElement("button");
  playBtn.className = "openclaw-audio-play-btn";
  playBtn.textContent = "▶ voice message";
  const progressEl = document.createElement("div");
  progressEl.className = "openclaw-audio-progress";
  const barEl = document.createElement("div");
  barEl.className = "openclaw-audio-bar";
  progressEl.appendChild(barEl);
  playerEl.appendChild(playBtn);
  playerEl.appendChild(progressEl);
  container.appendChild(playerEl);

  let audio = null;
  playBtn.addEventListener("click", async () => {
    if (audio && !audio.paused) { audio.pause(); playBtn.textContent = "▶ voice message"; return; }
    if (!audio) {
      playBtn.textContent = "⏳ loading...";
      try {
        const url = buildVoiceUrl(voiceRef);
        audio = new Audio(url);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timeout")), 10000);
          audio.addEventListener("canplaythrough", () => { clearTimeout(timer); resolve(); }, { once: true });
          audio.addEventListener("error", () => { clearTimeout(timer); reject(new Error("load error")); }, { once: true });
          audio.load();
        });
        audio.addEventListener("timeupdate", () => {
          if (audio.duration) barEl.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
        });
        audio.addEventListener("ended", () => { playBtn.textContent = "▶ voice message"; barEl.style.width = "0%"; });
      } catch (e) {
        playBtn.textContent = "⚠ audio unavailable";
        playBtn.disabled = true;
        return;
      }
    }
    playBtn.textContent = "⏸ playing...";
    audio.play().catch(() => { playBtn.textContent = "⚠ audio unavailable"; playBtn.disabled = true; });
  });
}

function formatMarkdown(text) {
  // Remove VOICE: refs from display
  text = text.replace(/VOICE:([^\s]+)/g, "");

  let formatted = text
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Inline code
    .replace(/`(.+?)`/g, "<code>$1</code>")
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    // Line breaks
    .replace(/\n/g, "<br>");

  return formatted;
}

function constructAudioUrl(path) {
  let baseUrl = state.gatewayUrl;
  if (baseUrl.startsWith("ws://")) baseUrl = "http://" + baseUrl.slice(5);
  else if (baseUrl.startsWith("wss://")) baseUrl = "https://" + baseUrl.slice(6);
  baseUrl = baseUrl.replace(/\/+$/, "");
  return `${baseUrl}/${path.replace(/^\/+/, "")}`;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    ui.messagesContainer.scrollTop = ui.messagesContainer.scrollHeight;
  });
}

// ─── Tool Call Display ───────────────────────────────────────────────

function buildToolLabel(toolName, args) {
  const a = args ?? {};
  switch (toolName) {
    case "exec": {
      const cmd = str(a?.command);
      const short = cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd;
      return { label: `🔧 ${short || "Running command"}` };
    }
    case "read": case "Read": {
      const p = str(a?.path, str(a?.file_path));
      return { label: `📄 Reading ${p.split("/").pop() || "file"}` };
    }
    case "write": case "Write": {
      const p = str(a?.path, str(a?.file_path));
      return { label: `✏️ Writing ${p.split("/").pop() || "file"}` };
    }
    case "edit": case "Edit": {
      const p = str(a?.path, str(a?.file_path));
      return { label: `✏️ Editing ${p.split("/").pop() || "file"}` };
    }
    case "web_search": return { label: `🔍 Searching "${str(a?.query).slice(0, 40)}"` };
    case "web_fetch": {
      const rawUrl = str(a?.url);
      try { return { label: `🌐 Fetching ${new URL(rawUrl).hostname}`, url: rawUrl }; }
      catch { return { label: "🌐 Fetching page", url: rawUrl || undefined }; }
    }
    case "browser": return { label: "🌐 Using browser" };
    case "image": return { label: "👁️ Viewing image" };
    case "message": return { label: "💬 Sending message" };
    case "tts": return { label: "🔊 Speaking" };
    case "sessions_spawn": return { label: "🤖 Spawning sub-agent" };
    default: return { label: toolName ? `⚡ ${toolName}` : "Working" };
  }
}

function appendToolCall(label, url, active = false) {
  const el = document.createElement("div");
  el.className = "openclaw-tool-item" + (active ? " openclaw-tool-active" : "");
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.textContent = label;
    link.className = "openclaw-tool-link";
    link.addEventListener("click", (e) => { e.preventDefault(); window.open(url, "_blank"); });
    el.appendChild(link);
  } else {
    const span = document.createElement("span");
    span.textContent = label;
    el.appendChild(span);
  }
  if (active) {
    const dots = document.createElement("span");
    dots.className = "openclaw-tool-dots";
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.className = "openclaw-dot";
      dots.appendChild(dot);
    }
    el.appendChild(dots);
  }
  ui.messagesContainer.appendChild(el);
  scrollToBottom();
}

function deactivateLastToolItem() {
  const items = ui.messagesContainer.querySelectorAll(".openclaw-tool-active");
  const last = items[items.length - 1];
  if (last) {
    last.classList.remove("openclaw-tool-active");
    const dots = last.querySelector(".openclaw-tool-dots");
    if (dots) dots.remove();
  }
}

// ─── Banner ──────────────────────────────────────────────────────────

function showBanner(text) {
  ui.statusBanner.textContent = text;
  ui.statusBanner.classList.remove("oc-hidden");
}

function hideBanner() {
  ui.statusBanner.classList.add("oc-hidden");
}

// ─── Stream Management ──────────────────────────────────────────────

function resolveStreamSession(payload) {
  const sk = str(payload.sessionKey);
  if (sk) {
    const prefix = agentPrefix();
    const normalized = sk.startsWith(prefix) ? sk.slice(prefix.length) : sk;
    if (state.streams.has(normalized)) return normalized;
  }
  const data = payload.data;
  const runId = str(payload.runId, str(data?.runId));
  if (runId && state.runToSession.has(runId)) return state.runToSession.get(runId);
  if (state.streams.size === 1) return state.streams.keys().next().value;
  return null;
}

function finishStream(sessionKey) {
  const sk = sessionKey ?? state.sessionKey;
  const ss = state.streams.get(sk);
  if (ss) {
    if (ss.compactTimer) clearTimeout(ss.compactTimer);
    if (ss.workingTimer) clearTimeout(ss.workingTimer);
    state.runToSession.delete(ss.runId);
    state.streams.delete(sk);
  }
  if (sk === state.sessionKey) {
    hideBanner();
    state.streamEl = null;
    ui.abortBtn.classList.add("oc-hidden");
    ui.typingIndicator.classList.add("oc-hidden");
    const typingText = ui.typingIndicator.querySelector(".openclaw-typing-text");
    if (typingText) typingText.textContent = "Thinking";
  }
}

function restoreStreamUI() {
  const ss = state.streams.get(state.sessionKey);
  if (!ss) return;
  ui.abortBtn.classList.remove("oc-hidden");
  for (const item of ss.items) {
    if (item.type === "tool") appendToolCall(item.label, item.url);
  }
  if (ss.text) {
    updateStreamBubble();
    const typingText = ui.typingIndicator.querySelector(".openclaw-typing-text");
    if (typingText) typingText.textContent = "Working";
    ui.typingIndicator.classList.remove("oc-hidden");
  } else {
    const typingText = ui.typingIndicator.querySelector(".openclaw-typing-text");
    if (typingText) typingText.textContent = "Thinking";
    ui.typingIndicator.classList.remove("oc-hidden");
  }
  scrollToBottom();
}

function updateStreamBubble() {
  const ss = state.streams.get(state.sessionKey);
  const visibleText = ss?.text;
  if (!visibleText) return;
  if (!state.streamEl) {
    state.streamEl = document.createElement("div");
    state.streamEl.className = "openclaw-msg openclaw-msg-assistant openclaw-streaming";
    ui.messagesContainer.appendChild(state.streamEl);
    scrollToBottom();
  }
  state.streamEl.innerHTML = "";
  const textDiv = document.createElement("div");
  textDiv.className = "openclaw-msg-text";
  textDiv.innerHTML = formatMarkdown(visibleText);
  state.streamEl.appendChild(textDiv);
}

function extractDeltaText(msg) {
  if (typeof msg === "string") return msg;
  if (!msg) return "";
  const content = msg.content ?? msg;
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content) {
      if (typeof block === "string") text += block;
      else if (block && typeof block === "object" && "text" in block) text += (text ? "\n" : "") + String(block.text);
    }
    return text;
  }
  if (typeof content === "string") return content;
  return str(msg.text);
}

// ─── Gateway Event Handlers ─────────────────────────────────────────

function handleGatewayEvent(msg) {
  if (!msg.event) return;

  if (msg.event === "chat") {
    handleChatEvent(msg.payload);
  } else if (msg.event === "stream" || msg.event === "agent") {
    handleStreamEvent(msg.payload);
  }
}

function handleStreamEvent(payload) {
  const stream = str(payload.stream);
  const eventState = str(payload.state);
  const payloadData = payload.data;

  const sessionKey = resolveStreamSession(payload);
  const isActiveTab = sessionKey === state.sessionKey;

  if (!sessionKey || !state.streams.has(sessionKey)) {
    if (stream === "compaction" || eventState === "compacting") {
      const cPhase = str(payloadData?.phase);
      if (isActiveTab || !sessionKey) {
        if (cPhase === "end") setTimeout(() => hideBanner(), 2000);
        else showBanner("Compacting context...");
      }
    }
    return;
  }

  const ss = state.streams.get(sessionKey);
  const typingText = ui.typingIndicator.querySelector(".openclaw-typing-text");

  if (eventState === "assistant") {
    const timeSinceDelta = Date.now() - ss.lastDeltaTime;
    if (ss.text && timeSinceDelta > 1500) {
      if (!ss.workingTimer) {
        ss.workingTimer = setTimeout(() => {
          if (state.streams.has(sessionKey) && isActiveTab && ui.typingIndicator.classList.contains("oc-hidden")) {
            if (typingText) typingText.textContent = "Working";
            ui.typingIndicator.classList.remove("oc-hidden");
          }
          ss.workingTimer = null;
        }, 500);
      }
    } else if (!ss.text && !ss.lastDeltaTime && isActiveTab) {
      ui.typingIndicator.classList.remove("oc-hidden");
    }
  } else if (eventState === "lifecycle") {
    if (!ss.text && isActiveTab && typingText) {
      typingText.textContent = "Thinking";
      ui.typingIndicator.classList.remove("oc-hidden");
    }
  }

  const toolName = str(payloadData?.name, str(payloadData?.toolName, str(payload.toolName, str(payload.name))));
  const phase = str(payloadData?.phase, str(payload.phase));

  if ((stream === "tool" || toolName) && (phase === "start" || eventState === "tool_use")) {
    if (ss.compactTimer) { clearTimeout(ss.compactTimer); ss.compactTimer = null; }
    if (ss.workingTimer) { clearTimeout(ss.workingTimer); ss.workingTimer = null; }
    if (ss.text) ss.splitPoints.push(ss.text.length);

    const { label, url } = buildToolLabel(toolName, (payloadData?.args || payload.args));
    ss.toolCalls.push(label);
    ss.items.push({ type: "tool", label, url });
    if (isActiveTab) {
      appendToolCall(label, url, true);
      if (typingText) typingText.textContent = label;
      ui.typingIndicator.classList.remove("oc-hidden");
    }
  } else if ((stream === "tool" || toolName) && phase === "result") {
    if (isActiveTab) {
      deactivateLastToolItem();
      if (typingText) typingText.textContent = "Thinking";
      ui.typingIndicator.classList.remove("oc-hidden");
      scrollToBottom();
    }
  } else if (stream === "compaction" || eventState === "compacting") {
    if (phase === "end") {
      if (isActiveTab) setTimeout(() => hideBanner(), 2000);
    } else {
      ss.toolCalls.push("Compacting memory");
      ss.items.push({ type: "tool", label: "Compacting memory" });
      if (isActiveTab) {
        appendToolCall("Compacting memory");
        ui.typingIndicator.classList.add("oc-hidden");
        showBanner("Compacting context...");
      }
    }
  }
}

function handleChatEvent(payload) {
  const payloadSk = str(payload.sessionKey);
  const prefix = agentPrefix();
  let eventSessionKey = null;

  for (const sk of [...state.streams.keys(), state.sessionKey]) {
    if (payloadSk === sk || payloadSk === `${prefix}${sk}` || payloadSk.endsWith(`:${sk}`)) {
      eventSessionKey = sk;
      break;
    }
  }

  if (!eventSessionKey) {
    const active = state.sessionKey;
    if (payloadSk === active || payloadSk === `${prefix}${active}` || payloadSk.endsWith(`:${active}`)) {
      eventSessionKey = active;
    } else return;
  }

  const ss = state.streams.get(eventSessionKey);
  const isActiveTab = eventSessionKey === state.sessionKey;
  const chatState = str(payload.state);

  // No active stream — refresh on final
  if (!ss && (chatState === "final" || chatState === "aborted" || chatState === "error")) {
    if (isActiveTab) { hideBanner(); loadChatHistory(); }
    return;
  }

  if (chatState === "delta" && ss) {
    if (ss.compactTimer) { clearTimeout(ss.compactTimer); ss.compactTimer = null; }
    if (ss.workingTimer) { clearTimeout(ss.workingTimer); ss.workingTimer = null; }
    ss.lastDeltaTime = Date.now();
    const text = extractDeltaText(payload.message);
    if (text) {
      ss.text = text;
      if (isActiveTab) {
        ui.typingIndicator.classList.add("oc-hidden");
        hideBanner();
        updateStreamBubble();
      }
    }
  } else if (chatState === "final") {
    finishStream(eventSessionKey);
    if (isActiveTab) {
      loadChatHistory().then(() => updateContextMeter());
    }
  } else if (chatState === "aborted") {
    if (isActiveTab && ss?.text) {
      state.messages.push({ role: "assistant", text: ss.text, images: [], timestamp: Date.now() });
    }
    finishStream(eventSessionKey);
    if (isActiveTab) renderMessages();
  } else if (chatState === "error") {
    if (isActiveTab) {
      state.messages.push({
        role: "assistant",
        text: `Error: ${str(payload.errorMessage, "unknown error")}`,
        images: [], timestamp: Date.now(),
      });
    }
    finishStream(eventSessionKey);
    if (isActiveTab) renderMessages();
  }
}

// ─── Send Message ────────────────────────────────────────────────────

async function sendMessage(text) {
  const hasAttachments = state.pendingAttachments.length > 0;
  if (!text.trim() && !hasAttachments) return;
  if (state.sending) return;
  if (!state.gateway?.connected) return;

  state.sending = true;
  ui.sendBtn.disabled = true;
  ui.messageInput.value = "";
  autoResize();

  // Build attachments
  let fullMessage = text;
  const displayText = text;
  const userImages = [];
  const gatewayAttachments = [];

  if (state.pendingAttachments.length > 0) {
    for (const att of state.pendingAttachments) {
      if (att.base64 && att.mimeType) {
        gatewayAttachments.push({ type: "image", mimeType: att.mimeType, content: att.base64 });
        userImages.push(`data:${att.mimeType};base64,${att.base64}`);
      } else {
        fullMessage = (fullMessage ? fullMessage + "\n\n" : "") + att.content;
      }
    }
    if (!text.trim()) {
      const label = `📎 ${state.pendingAttachments.map(a => a.name).join(", ")}`;
      fullMessage = label;
    }
    state.pendingAttachments = [];
    ui.attachPreview.classList.add("oc-hidden");
    ui.attachPreview.innerHTML = "";
  }

  state.messages.push({ role: "user", text: displayText || fullMessage, images: userImages, timestamp: Date.now() });
  renderMessages();

  const runId = generateId();
  const sendSessionKey = state.sessionKey;

  // Create stream state
  const ss = {
    runId,
    text: null,
    toolCalls: [],
    items: [],
    splitPoints: [],
    lastDeltaTime: 0,
    compactTimer: null,
    workingTimer: null,
  };
  state.streams.set(sendSessionKey, ss);
  state.runToSession.set(runId, sendSessionKey);

  ui.abortBtn.classList.remove("oc-hidden");
  ui.typingIndicator.classList.remove("oc-hidden");
  const thinkText = ui.typingIndicator.querySelector(".openclaw-typing-text");
  if (thinkText) thinkText.textContent = "Thinking";
  scrollToBottom();

  // Fallback timeout
  ss.compactTimer = setTimeout(() => {
    const current = state.streams.get(sendSessionKey);
    if (current?.runId === runId && !current.text) {
      if (state.sessionKey === sendSessionKey) {
        const tt = ui.typingIndicator.querySelector(".openclaw-typing-text");
        if (tt && tt.textContent === "Thinking") tt.textContent = "Still thinking";
      }
    }
  }, 15000);

  try {
    const sendParams = {
      sessionKey: sendSessionKey,
      message: fullMessage,
      deliver: false,
      idempotencyKey: runId,
    };
    if (gatewayAttachments.length > 0) sendParams.attachments = gatewayAttachments;
    await state.gateway.request("chat.send", sendParams);
  } catch (err) {
    if (ss.compactTimer) clearTimeout(ss.compactTimer);
    state.messages.push({ role: "assistant", text: `Error: ${err}`, images: [], timestamp: Date.now() });
    state.streams.delete(sendSessionKey);
    state.runToSession.delete(runId);
    ui.abortBtn.classList.add("oc-hidden");
    renderMessages();
  } finally {
    state.sending = false;
    ui.sendBtn.disabled = false;
  }
}

async function abortMessage() {
  const ss = state.streams.get(state.sessionKey);
  if (!state.gateway?.connected || !ss) return;
  try {
    await state.gateway.request("chat.abort", {
      sessionKey: state.sessionKey,
      runId: ss.runId,
    });
  } catch { /* ignore */ }
}

// ─── Attachment Handling ─────────────────────────────────────────────

async function handleFileSelect() {
  const files = ui.fileInput.files;
  if (!files || files.length === 0) return;

  for (const file of Array.from(files)) {
    try {
      const isImage = file.type.startsWith("image/");
      const isText = file.type.startsWith("text/") ||
        ["application/json", "application/yaml", "application/xml", "application/javascript"].includes(file.type) ||
        /\.(md|txt|json|csv|yaml|yml|js|ts|py|html|css|xml|toml|ini|sh|log)$/i.test(file.name);

      if (isImage) {
        const resized = await resizeImage(file, 2048, 0.85);
        state.pendingAttachments.push({
          name: file.name,
          content: `[Attached image: ${file.name}]`,
          base64: resized.base64,
          mimeType: resized.mimeType,
        });
      } else if (isText) {
        const content = await file.text();
        const truncated = content.length > 10000 ? content.slice(0, 10000) + "\n...(truncated)" : content;
        state.pendingAttachments.push({
          name: file.name,
          content: `File: ${file.name}\n\`\`\`\n${truncated}\n\`\`\``,
        });
      } else {
        state.pendingAttachments.push({
          name: file.name,
          content: `[Attached file: ${file.name} (${file.type || "unknown type"}, ${Math.round(file.size / 1024)}KB)]`,
        });
      }
    } catch (e) {
      console.error(`Failed to attach ${file.name}:`, e);
    }
  }

  renderAttachPreview();
  ui.fileInput.value = "";
}

async function handlePastedFile(file) {
  try {
    const ext = file.type.split("/")[1] || "png";
    const resized = await resizeImage(file, 2048, 0.85);
    state.pendingAttachments.push({
      name: `clipboard.${ext}`,
      content: `[Attached image: clipboard.${ext}]`,
      base64: resized.base64,
      mimeType: resized.mimeType,
    });
    renderAttachPreview();
  } catch (e) {
    console.error("Failed to paste image:", e);
  }
}

function resizeImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxSide || height > maxSide) {
        const scale = maxSide / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("No canvas context")); return; }
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const base64 = dataUrl.split(",")[1];
      resolve({ base64, mimeType: "image/jpeg" });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image")); };
    img.src = url;
  });
}

function renderAttachPreview() {
  ui.attachPreview.innerHTML = "";
  if (state.pendingAttachments.length === 0) {
    ui.attachPreview.classList.add("oc-hidden");
    return;
  }
  ui.attachPreview.classList.remove("oc-hidden");

  for (let i = 0; i < state.pendingAttachments.length; i++) {
    const att = state.pendingAttachments[i];
    const chip = document.createElement("div");
    chip.className = "openclaw-attach-chip";

    if (att.base64 && att.mimeType) {
      const img = document.createElement("img");
      img.className = "openclaw-attach-thumb";
      img.src = `data:${att.mimeType};base64,${att.base64}`;
      chip.appendChild(img);
    }

    const name = document.createElement("span");
    name.className = "openclaw-attach-name";
    name.textContent = att.name;
    chip.appendChild(name);

    const removeBtn = document.createElement("button");
    removeBtn.className = "openclaw-attach-remove";
    removeBtn.textContent = "✕";
    const idx = i;
    removeBtn.addEventListener("click", () => {
      state.pendingAttachments.splice(idx, 1);
      renderAttachPreview();
    });
    chip.appendChild(removeBtn);
    ui.attachPreview.appendChild(chip);
  }

  updateSendButton();
}

function updateSendButton() {
  if (ui.messageInput.value.trim() || state.pendingAttachments.length > 0) {
    ui.sendBtn.classList.remove("oc-opacity-low");
  } else {
    ui.sendBtn.classList.add("oc-opacity-low");
  }
}

function autoResize() {
  ui.messageInput.style.height = "auto";
  ui.messageInput.style.height = Math.min(ui.messageInput.scrollHeight, 120) + "px";
}

// ─── Input Handlers ──────────────────────────────────────────────────

ui.sendBtn.addEventListener("click", () => {
  if (ui.messageInput.value.trim() || state.pendingAttachments.length > 0) {
    sendMessage(ui.messageInput.value);
  }
});

ui.messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(ui.messageInput.value);
  }
});

ui.messageInput.addEventListener("input", () => {
  autoResize();
  updateSendButton();
});

// Clipboard paste: capture images
ui.messageInput.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of Array.from(items)) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) handlePastedFile(file);
      return;
    }
  }
});

// Brain button -> model picker
ui.brainBtn.addEventListener("click", () => openModelPicker());
ui.modelLabel.addEventListener("click", () => openModelPicker());

// Attach button
ui.attachBtn.addEventListener("click", () => ui.fileInput.click());
ui.fileInput.addEventListener("change", () => handleFileSelect());

// Abort button
ui.abortBtn.addEventListener("click", () => abortMessage());

// Reconnect button
ui.reconnectBtn.addEventListener("click", () => {
  if (state.gateway) state.gateway.stop();
  connectToGateway().catch(err => console.error("Reconnect failed:", err));
});

// Tab bar horizontal scroll
ui.tabBar.addEventListener("wheel", (e) => {
  e.preventDefault();
  ui.tabBar.scrollLeft += e.deltaY;
}, { passive: false });

// ─── Initialize ──────────────────────────────────────────────────────

initApp();

// Register service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((err) => {
    console.error("Service worker registration failed:", err);
  });
}
