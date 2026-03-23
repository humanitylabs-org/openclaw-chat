// OpenClaw Chat PWA
// Command Center + Chat interface

// ─── Utilities ───────────────────────────────────────────────────────

function generateId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function str(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}

/** Generate a short tab title (2-4 words, max 25 chars) from the user's first message */
function generateTabTitle(text) {
  // Strip attachments, code blocks, URLs, markdown
  let clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return null;

  // Take first sentence or clause
  const sentence = clean.split(/[.!?\n]/)[0].trim();
  if (!sentence) return null;

  // Remove filler starts
  const stripped = sentence
    .replace(/^(hey|hi|hello|please|can you|could you|i want to|i need to|i'd like to|let's|lets)\s+/i, "")
    .trim();

  const words = (stripped || sentence).split(/\s+/);

  // Take 2-4 words, cap at 25 chars
  let title = "";
  for (let i = 0; i < Math.min(words.length, 4); i++) {
    const next = title ? title + " " + words[i] : words[i];
    if (next.length > 25) break;
    title = next;
  }

  if (!title || title.length < 2) return null;

  // Capitalize first letter
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** Auto-rename an "Untitled" tab after the user's first message */
async function autoRenameTab(sessionKey, messageText) {
  if (sessionKey === "main") return;
  const tab = state.tabSessions.find(t => t.key === sessionKey);
  if (!tab || tab.label !== "Untitled") return;
  const title = generateTabTitle(messageText);
  if (!title) return;
  try {
    await state.gateway.request("sessions.patch", {
      key: `${agentPrefix()}${sessionKey}`,
      label: title,
    });
    tab.label = title;
    renderTabs();
  } catch { /* non-critical */ }
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

  // Session controls
  thinkingLevel: "",   // off|minimal|low|medium|high|xhigh
  reasoningLevel: "",  // off|on|stream
  verboseLevel: "",    // off|on|full

  // Agent defaults (from config)
  defaults: { model: "", thinking: "", reasoning: "", verbose: "" },
  
  // Pending default changes (not yet applied to config)
  pendingDefaults: {},
  
  // TTS config from gateway
  ttsConfig: {},
  
  // Dock channel
  dockChannel: "",  // "" = webchat (here), "telegram", "discord", etc.
  availableChannels: [],

  // Tabs
  tabSessions: [],
  renderingTabs: false,
  tabDeleteInProgress: false,
  tabCache: {},  // { [sessionKey]: { messages: [...], timestamp: number } }
  tabDrafts: JSON.parse(localStorage.getItem('tabDrafts') || '{}'),
  messageQueue: JSON.parse(localStorage.getItem('messageQueue') || '{}'),  // { [sessionKey]: [{ text, images, timestamp }] }

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
  // Chat
  chatContainer: $("chat-container"),
  tabBar: $("tab-bar"),
  agentBtn: $("agent-btn"),
  agentDropdown: $("agent-dropdown"),
  statusBanner: $("status-banner"),
  messagesContainer: $("messages"),
  messageInput: $("message-input"),
  attachBtn: $("attach-btn"),
  fileInput: $("file-input"),
  attachPreview: $("attach-preview"),
  sendBtn: $("send-btn"),
  abortBtn: null, // merged into send button
  typingIndicator: $("typing-indicator"),
  modelLabel: $("model-label"),
};

// ─── Onboarding Flow ─────────────────────────────────────────────────

async function initApp() {
  const stored = localStorage.getItem("connection");
  if (stored) {
    try {
      const data = JSON.parse(stored);
      state.gatewayUrl = data.gatewayUrl || "";
      state.token = data.token || "";
    } catch {}
  }

  state.sessionKey = localStorage.getItem("sessionKey") || "main";
  state.currentModel = localStorage.getItem("currentModel") || "";
  state.activeAgent = JSON.parse(localStorage.getItem("activeAgent") || '{"id":"main","name":"Agent","emoji":"🤖","creature":""}');
  state.deviceIdentity = await getOrCreateDeviceIdentity();

  // Always show chat container
  ui.chatContainer.classList.add("active");

  if (state.gatewayUrl && state.token) {
    await startChat();
  } else {
    updateConnectionStatus(false);
  }
  updateDashboard();
}

function showStatus(message, type) {
  console.log(`[${type}] ${message}`);
}

function showPairingBanner() {
  if (document.getElementById("pairing-banner")) return;

  const deviceShort = state.deviceIdentity?.deviceId?.slice(0, 12) || "unknown";

  const banner = document.createElement("div");
  banner.id = "pairing-banner";
  banner.innerHTML = `
    <div style="position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;">
      <div style="max-width:420px;width:calc(100% - 2rem);background:#1a1a1e;border:1px solid rgba(74,158,255,0.3);border-radius:12px;padding:1.2rem 1.4rem;box-shadow:0 8px 32px rgba(0,0,0,0.6);color:#eee;font-size:0.88em;line-height:1.5;">
        <div style="margin-bottom:0.75rem;">
          <strong style="color:var(--interactive-accent);font-size:1.05em;">🔐 Device pairing required</strong>
        </div>
        <p style="margin:0 0 0.5rem;color:#ccc;">
          This device (<code style="background:#28282d;padding:0.15em 0.4em;border-radius:4px;font-size:0.85em;">${deviceShort}</code>) needs to be approved by your gateway.
        </p>

        <div style="margin:0.75rem 0;">
          <p style="color:#999;font-size:0.8em;margin-bottom:0.35rem;font-weight:500;">Option 1 — Run on the server:</p>
          <div id="pairing-cmd" style="background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:0.55rem 0.75rem;font-family:monospace;font-size:0.82em;color:#eee;cursor:pointer;position:relative;user-select:all;" title="Click to copy">
            openclaw devices approve --latest
            <span id="pairing-copy-feedback" style="position:absolute;right:0.6rem;top:50%;transform:translateY(-50%);font-size:0.75em;color:#888;">📋</span>
          </div>
        </div>

        <div style="margin-bottom:0.5rem;">
          <p style="color:#999;font-size:0.8em;margin-bottom:0.2rem;font-weight:500;">Option 2 — Ask your bot:</p>
          <p style="color:#ccc;font-size:0.82em;margin:0;">
            Message your bot on Telegram, Discord, etc: <em>"approve the pending device"</em>
          </p>
        </div>

        <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.75rem;padding-top:0.6rem;border-top:1px solid rgba(255,255,255,0.06);">
          <div class="spinner" style="width:14px;height:14px;border-width:2px;"></div>
          <span style="color:#888;font-size:0.82em;">Waiting for approval — will connect automatically...</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(banner);

  document.getElementById("pairing-cmd")?.addEventListener("click", () => {
    navigator.clipboard.writeText("openclaw devices approve --latest").then(() => {
      const fb = document.getElementById("pairing-copy-feedback");
      if (fb) { fb.textContent = "✓ copied"; setTimeout(() => { fb.textContent = "📋"; }, 1500); }
    }).catch(() => {});
  });
}

async function connectToGateway() {
  return new Promise((resolve, reject) => {
    let helloReceived = false;
    let pairingDetected = false;

    state.gateway = new GatewayClient({
      url: state.gatewayUrl,
      token: state.token,
      deviceIdentity: state.deviceIdentity,
      onHello: (payload) => {
        console.log("Connected to gateway:", payload);
        helloReceived = true;
        localStorage.setItem("deviceApproved", "true");
        state.snapshot = payload?.snapshot || {};
        state.serverVersion = payload?.server?.version || '';

        document.getElementById("pairing-banner")?.remove();

        updateConnectionStatus(true);
        resolve();
      },
      onClose: (info) => {
        console.log("Gateway connection closed:", info);
        updateConnectionStatus(false);
        if (!helloReceived && info.reason === "pairing required" && !pairingDetected) {
          pairingDetected = true;
          showPairingBanner();
        }
      },
      onEvent: handleGatewayEvent,
    });

    state.gateway.start();

    setTimeout(() => {
      if (!helloReceived && !pairingDetected) {
        reject(new Error("Connection timeout — check your gateway URL and token"));
      }
    }, 30000);
  });
}

async function startChat() {
  ui.chatContainer.classList.add("active");

  if (!state.gateway || !state.gateway.connected) {
    state.deviceIdentity = await getOrCreateDeviceIdentity();
    await connectToGateway();
  }

  updateConnectionStatus(true);
  await loadDefaults();
  await loadAgents();
  await loadChatHistory();
  await renderTabs();
  updateModelLabel();
  prefetchAllTabs(); // pre-load other tabs in background
  restoreDraft();
  renderQueuedMessages();

  setInterval(() => updateContextMeter(), 15000);
}

function updateConnectionStatus(connected) {
  if (connected) {
    ui.sendBtn.classList.remove("oc-hidden");
    ui.messageInput.disabled = false;
    ui.messageInput.placeholder = "Message...";
  } else {
    ui.sendBtn.classList.add("oc-hidden");
    ui.messageInput.disabled = true;
    ui.messageInput.placeholder = "Disconnected — reconnect in settings";
  }
  updateDashboard();
}



// ─── Agent Management ────────────────────────────────────────────────

async function loadDefaults() {
  if (!state.gateway?.connected) return;
  try {
    const result = await state.gateway.request("config.get", {});
    const cfg = result?.config || result || {};
    // config.get returns raw JSON string, parse it
    let parsed = cfg;
    if (result?.raw && typeof result.raw === "string") {
      try { parsed = JSON.parse(result.raw); } catch {}
    }
    const ad = parsed?.agents?.defaults || cfg?.agents?.defaults || {};
    const model = ad?.model?.primary || ad?.model || "";
    const thinking = ad?.thinkingDefault || "";
    const reasoning = ad?.reasoningDefault || "";
    const verbose = ad?.verboseDefault || "";
    state.defaults = { model: typeof model === "string" ? model : "", thinking, reasoning, verbose };
    
    // Parse TTS config
    const tts = parsed?.messages?.tts || cfg?.messages?.tts || {};
    state.ttsConfig = {
      auto: tts.auto || (tts.enabled ? "always" : "off"),
      provider: tts.provider || "",
      openaiKey: tts.openai?.apiKey || "",
      elevenlabsKey: tts.elevenlabs?.apiKey || "",
    };
    // Redacted keys show as __OPENCLAW_REDACTED__ - treat as empty for display but don't overwrite
    if (state.ttsConfig.openaiKey === "__OPENCLAW_REDACTED__") state.ttsConfig.openaiKey = "••••••••";
    if (state.ttsConfig.elevenlabsKey === "__OPENCLAW_REDACTED__") state.ttsConfig.elevenlabsKey = "••••••••";
    
    updateDefaultsPanel();
    updateBarControls();
    loadTTSSettings();
    
    // Load available channels for dock switcher
    loadAvailableChannels();
  } catch (err) {
    console.warn("Failed to load defaults:", err);
  }
}

async function loadAgents() {
  if (!state.gateway?.connected) return;
  try {
    const result = await state.gateway.request("agents.list", {});
    const agentList = result?.agents || [];
    if (agentList.length === 0) agentList.push({ id: "main" });

    state.agents = agentList.map(a => ({
      id: a.id || "main",
      name: a.identity?.name || a.name || a.id || "Agent",
      emoji: a.identity?.emoji || "🤖",
      creature: a.creature || "",
    }));

    const saved = state.activeAgent;
    const active = state.agents.find(a => a.id === saved.id) || state.agents[0];
    if (active) {
      state.activeAgent = active;
      localStorage.setItem("activeAgent", JSON.stringify(active));
    }

    updateAgentButton();
    updateDashboard();
  } catch (err) {
    console.warn("Failed to load agents:", err);
  }
}

function updateAgentButton() {
  // Top-bar agent switcher removed; control panel handles switching
}

async function switchAgent(agent) {
  if (agent.id === state.activeAgent.id) return;
  state.activeAgent = agent;
  state.sessionKey = "main";
  localStorage.setItem("activeAgent", JSON.stringify(agent));
  localStorage.setItem("sessionKey", "main");
  updateAgentButton();
  // Update HUD identity
  const emojiEl = document.getElementById('hud-beacon-emoji');
  if (emojiEl) emojiEl.textContent = agent.emoji || '🤖';
  const nameEl = document.getElementById('hud-agent-name');
  if (nameEl) {
    const chevron = nameEl.querySelector('.hud-agent-chevron');
    nameEl.textContent = (agent.name || 'Agent') + ' ';
    if (chevron) nameEl.appendChild(chevron);
  }
  state.messages = [];
  state.tabCache = {};
  ui.messagesContainer.innerHTML = "";
  showLoading("Loading…");
  await loadChatHistory();
  await renderTabs();
  prefetchAllTabs();
  // Reload control panel sections for new agent
  loadAgentFiles();
  loadCronJobs();
  loadSubagents();
}

// Top-bar agent dropdown removed — control panel handles switching

// ─── Tab Management ──────────────────────────────────────────────────

function isCloseConfirmDisabled() {
  return localStorage.getItem("openclaw-confirm-close-disabled") === "true";
}
function setCloseConfirmDisabled(v) {
  localStorage.setItem("openclaw-confirm-close-disabled", v ? "true" : "false");
}

function confirmClose(title, msg) {
  if (isCloseConfirmDisabled()) return Promise.resolve(true);
  return new Promise(resolve => {
    const overlay = document.getElementById("confirm-overlay");
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-msg").textContent = msg;
    document.getElementById("confirm-ok").textContent = title.startsWith("Reset") ? "Reset" : "Close";
    const checkbox = document.getElementById("confirm-dont-ask");
    checkbox.checked = false;
    overlay.classList.add("oc-open");
    const cleanup = (result) => {
      overlay.classList.remove("oc-open");
      if (result && checkbox.checked) setCloseConfirmDisabled(true);
      resolve(result);
    };
    document.getElementById("confirm-ok").onclick = () => cleanup(true);
    document.getElementById("confirm-cancel").onclick = () => cleanup(false);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
  });
}

function startTabRename(labelEl, tab) {
  const input = document.createElement("input");
  input.className = "openclaw-tab-label-input";
  input.value = tab.label;
  input.maxLength = 30;
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  const finish = async (save) => {
    const newName = input.value.trim();
    if (save && newName && newName !== tab.label) {
      try {
        await state.gateway.request("sessions.patch", {
          key: `${agentPrefix()}${tab.key}`,
          label: newName,
        });
        tab.label = newName;
      } catch { /* keep old name */ }
    }
    input.replaceWith(labelEl);
    labelEl.textContent = tab.label;
    renderTabs();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

function updateTabMode() {
  const tabBar = ui.tabBar;
  const hamburgerBar = document.getElementById("hamburger-bar");
  if (!tabBar || !hamburgerBar) return;
  const isMobile = window.innerWidth <= 1024;
  const tabCount = state.tabSessions.length + 1;
  const barWidth = tabBar.parentElement?.offsetWidth || 400;
  const perTab = barWidth / tabCount;
  if (isMobile || perTab < 60) {
    tabBar.classList.add("oc-hamburger-mode");
    hamburgerBar.classList.add("oc-visible");
    renderMobileTabSwitcher();
  } else {
    tabBar.classList.remove("oc-hamburger-mode");
    hamburgerBar.classList.remove("oc-visible");
  }
}

function renderMobileTabSwitcher() {
  const label = document.getElementById("tab-switcher-label");
  const meterFill = document.getElementById("tab-switcher-meter-fill");
  const actions = document.getElementById("tab-switcher-actions");
  const arrowLeft = document.getElementById("tab-arrow-left");
  const arrowRight = document.getElementById("tab-arrow-right");
  if (!label || !actions || !arrowLeft || !arrowRight) return;

  const currentKey = state.sessionKey || "main";
  const currentIdx = state.tabSessions.findIndex(t => t.key === currentKey);
  const current = currentIdx >= 0 ? state.tabSessions[currentIdx] : state.tabSessions[0];
  const idx = currentIdx >= 0 ? currentIdx : 0;

  if (current.key === "main") {
    label.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-4px;opacity:0.8"><path d="M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3l9-8z"/></svg>';
    label.title = "";
    label.style.cursor = "";
    label.ondblclick = null;
  } else {
    label.textContent = current.label;
    label.title = "Double-click to rename";
    label.style.cursor = "default";
    label.ondblclick = (e) => {
      e.stopPropagation();
      startSwitcherRename(label, current);
    };
  }

  if (meterFill) meterFill.style.width = (current.pct || 0) + "%";

  arrowLeft.style.visibility = idx <= 0 ? "hidden" : "visible";
  arrowLeft.style.pointerEvents = idx <= 0 ? "none" : "auto";

  arrowRight.style.visibility = idx >= state.tabSessions.length - 1 ? "hidden" : "visible";
  arrowRight.style.pointerEvents = idx >= state.tabSessions.length - 1 ? "none" : "auto";

  actions.innerHTML = "";
  const isHome = current.key === "main";

  const resetBtn = document.createElement("button");
  resetBtn.className = "oc-tab-switcher-action";
  resetBtn.title = "Reset conversation";
  resetBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-12.28L1 10"/></svg>';
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    resetTab(current);
  });
  actions.appendChild(resetBtn);

  const closeBtn = document.createElement("button");
  closeBtn.className = "oc-tab-switcher-action";
  closeBtn.textContent = "×";
  closeBtn.style.fontSize = "16px";
  if (!isHome) {
    closeBtn.title = "Close tab";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(current, currentKey);
    });
  } else {
    closeBtn.style.visibility = "hidden";
    closeBtn.style.pointerEvents = "none";
  }
  actions.appendChild(closeBtn);
}

function startSwitcherRename(labelEl, tab) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = tab.label;
  input.maxLength = 30;
  input.style.cssText = "font-size:14px;font-weight:600;background:rgba(128,128,128,0.2);border:1px solid var(--interactive-accent);border-radius:4px;color:var(--text-normal);padding:2px 6px;width:100%;outline:none;min-height:24px;";
  labelEl.textContent = "";
  labelEl.appendChild(input);
  input.focus();
  input.select();
  const finish = async (save) => {
    const newName = input.value.trim();
    if (save && newName && newName !== tab.label) {
      try {
        await state.gateway.request("sessions.patch", {
          key: `${agentPrefix()}${tab.key}`,
          label: newName,
        });
        tab.label = newName;
      } catch { /* keep old name */ }
    }
    renderTabs();
    renderMobileTabSwitcher();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

(function initTabSwitcher() {
  document.addEventListener("DOMContentLoaded", () => {
    const arrowLeft = document.getElementById("tab-arrow-left");
    const arrowRight = document.getElementById("tab-arrow-right");
    if (arrowLeft) {
      arrowLeft.addEventListener("click", (e) => {
        e.stopPropagation();
        const currentKey = state.sessionKey || "main";
        const idx = state.tabSessions.findIndex(t => t.key === currentKey);
        if (idx > 0) switchTab(state.tabSessions[idx - 1]);
      });
    }
    if (arrowRight) {
      arrowRight.addEventListener("click", (e) => {
        e.stopPropagation();
        const currentKey = state.sessionKey || "main";
        const idx = state.tabSessions.findIndex(t => t.key === currentKey);
        if (idx < state.tabSessions.length - 1) switchTab(state.tabSessions[idx + 1]);
      });
    }
  });
})();

function renderHamburgerDropdown() {
  const dd = document.getElementById("hamburger-dropdown");
  if (!dd) return;
  dd.innerHTML = "";
  const currentKey = state.sessionKey || "main";
  for (const tab of state.tabSessions) {
    const isHome = tab.key === "main";
    const isCurrent = tab.key === currentKey;
    const item = document.createElement("div");
    item.className = `oc-hamburger-dropdown-item${isCurrent ? " oc-active" : ""}`;

    const label = document.createElement("span");
    label.className = "oc-dd-label";
    if (isHome) {
      label.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-3px;opacity:0.7"><path d="M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3l9-8z"/></svg> Home';
    } else {
      label.textContent = tab.label;
      label.title = "Double-click to rename";
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startHamburgerRename(label, tab, dd);
      });
    }
    item.appendChild(label);

    const meter = document.createElement("div");
    meter.className = "oc-dd-meter";
    const fill = document.createElement("div");
    fill.className = "oc-dd-meter-fill";
    fill.style.width = tab.pct + "%";
    meter.appendChild(fill);
    item.appendChild(meter);

    const actions = document.createElement("span");
    actions.className = "oc-dd-actions";

    const resetBtn = document.createElement("span");
    resetBtn.className = "oc-dd-action-btn";
    resetBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-12.28L1 10"/></svg>';
    resetBtn.title = "Reset conversation";
    resetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dd.classList.remove("oc-open");
      resetTab(tab);
    });
    actions.appendChild(resetBtn);

    if (!isHome) {
      const closeBtn = document.createElement("span");
      closeBtn.className = "oc-dd-action-btn oc-dd-action-close";
      closeBtn.textContent = "×";
      closeBtn.title = "Close tab";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        dd.classList.remove("oc-open");
        closeTab(tab, currentKey);
      });
      actions.appendChild(closeBtn);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "oc-dd-action-btn";
      spacer.style.visibility = "hidden";
      spacer.textContent = "×";
      actions.appendChild(spacer);
    }
    item.appendChild(actions);

    item.addEventListener("click", () => {
      dd.classList.remove("oc-open");
      if (!isCurrent) switchTab(tab);
    });
    dd.appendChild(item);
  }

  const addItem = document.createElement("div");
  addItem.className = "oc-hamburger-dropdown-item";
  addItem.style.justifyContent = "center";
  addItem.style.color = "var(--text-muted)";
  addItem.style.opacity = "0.7";
  const addLabel = document.createElement("span");
  addLabel.textContent = "+ New Tab";
  addItem.appendChild(addLabel);
  addItem.addEventListener("click", () => {
    dd.classList.remove("oc-open");
    createNewTab();
  });
  dd.appendChild(addItem);
}

function startHamburgerRename(labelEl, tab, dd) {
  const input = document.createElement("input");
  input.className = "oc-dd-rename-input";
  input.value = tab.label;
  input.maxLength = 30;
  labelEl.textContent = "";
  labelEl.appendChild(input);
  input.focus();
  input.select();
  const finish = async (save) => {
    const newName = input.value.trim();
    if (save && newName && newName !== tab.label) {
      try {
        await state.gateway.request("sessions.patch", {
          key: `${agentPrefix()}${tab.key}`,
          label: newName,
        });
        tab.label = newName;
      } catch { /* keep old name */ }
    }
    labelEl.textContent = tab.label;
    labelEl.title = "Double-click to rename";
    renderTabs();
    renderMobileTabSwitcher();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

(function initHamburger() {
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("hamburger-btn");
    const dd = document.getElementById("hamburger-dropdown");
    if (btn && dd) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        renderHamburgerDropdown();
        dd.classList.toggle("oc-open");
      });
      document.addEventListener("click", (e) => {
        if (!dd.contains(e.target) && !btn.contains(e.target)) dd.classList.remove("oc-open");
      });
    }
  });
})();

async function renderTabs() {
  if (!ui.tabBar || state.renderingTabs) return;
  state.renderingTabs = true;
  try { await _renderTabsInner(); } finally { state.renderingTabs = false; }
}

async function _renderTabsInner() {
  const currentKey = state.sessionKey || "main";

  let sessions = [];
  if (state.gateway?.connected) {
    try {
      const result = await state.gateway.request("sessions.list", {});
      sessions = result?.sessions || [];
      state._cachedSessions = sessions;
      state._cachedSessionsAt = Date.now();
    } catch {
      sessions = state._cachedSessions || [];
    }
  } else {
    sessions = state._cachedSessions || [];
  }

  // Build tabs into a fragment off-screen, then swap in at the end
  const fragment = document.createDocumentFragment();

  const prefix = agentPrefix();
  const convSessions = sessions.filter(s => {
    if (!s.key.startsWith(prefix)) return false;
    if (s.key.includes(":cron:")) return false;
    if (s.key.includes(":subagent:")) return false;
    const suffix = s.key.slice(prefix.length);
    return !suffix.includes(":");
  });

  state.tabSessions = [];
  const mainSession = convSessions.find(s => s.key === `${prefix}main`);
  if (mainSession) {
    const used = mainSession.totalTokens || 0;
    const max = mainSession.contextTokens || 200000;
    state.tabSessions.push({ key: "main", label: "Home", pct: Math.min(100, Math.round((used / max) * 100)) });
  } else {
    state.tabSessions.push({ key: "main", label: "Home", pct: 0 });
  }

  const others = convSessions
    .filter(s => s.key.slice(prefix.length) !== "main")
    .sort((a, b) => (a.createdAt || a.updatedAt || 0) - (b.createdAt || b.updatedAt || 0));

  const savedOrder = JSON.parse(localStorage.getItem("tabOrder") || "[]");
  if (savedOrder.length > 0) {
    const orderMap = new Map(savedOrder.map((k, i) => [k, i]));
    others.sort((a, b) => {
      const skA = a.key.slice(prefix.length);
      const skB = b.key.slice(prefix.length);
      const oA = orderMap.has(skA) ? orderMap.get(skA) : 9999;
      const oB = orderMap.has(skB) ? orderMap.get(skB) : 9999;
      if (oA !== oB) return oA - oB;
      return (a.createdAt || a.updatedAt || 0) - (b.createdAt || b.updatedAt || 0);
    });
  }

  for (const s of others) {
    const sk = s.key.slice(prefix.length);
    const used = s.totalTokens || 0;
    const max = s.contextTokens || 200000;
    const pct = Math.min(100, Math.round((used / max) * 100));
    const label = s.label || s.displayName || "Untitled";
    state.tabSessions.push({ key: sk, label, pct });
  }

  for (const tab of state.tabSessions) {
    const isCurrent = tab.key === currentKey;
    const isHome = tab.key === "main";
    const tabEl = document.createElement("div");
    tabEl.className = `openclaw-tab${isCurrent ? " active" : ""}${isHome ? " openclaw-tab-home" : ""}`;

    const row = document.createElement("div");
    row.className = "openclaw-tab-row";
    const label = document.createElement("span");
    label.className = "openclaw-tab-label";

    if (isHome) {
      label.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3l9-8z"/></svg>';
      label.classList.add('openclaw-tab-home-label');
    } else {
      label.textContent = tab.label;
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startTabRename(label, tab);
      });
      label.title = "Double-click to rename";
    }
    row.appendChild(label);

    const actionBtn = document.createElement("span");
    actionBtn.className = "openclaw-tab-close";

    if (isHome) {
      const homeReset = document.createElement("span");
      homeReset.className = "openclaw-home-reset";
      homeReset.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-12.28L1 10"/></svg>';
      homeReset.title = "Reset conversation";
      homeReset.addEventListener("click", (e) => { e.stopPropagation(); resetTab(tab); });
      row.appendChild(homeReset);
    } else {
      const resetBtn = document.createElement("span");
      resetBtn.className = "openclaw-tab-close openclaw-tab-reset";
      resetBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-12.28L1 10"/></svg>';
      resetBtn.title = "Reset conversation";
      resetBtn.addEventListener("click", (e) => { e.stopPropagation(); resetTab(tab); });
      row.appendChild(resetBtn);

      actionBtn.textContent = "×";
      actionBtn.title = "Close tab";
      actionBtn.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab, currentKey); });
      row.appendChild(actionBtn);
    }
    tabEl.appendChild(row);

    const meter = document.createElement("div");
    meter.className = "openclaw-tab-meter";
    const fill = document.createElement("div");
    fill.className = "openclaw-tab-meter-fill";
    fill.style.width = tab.pct + "%";
    meter.appendChild(fill);
    tabEl.appendChild(meter);

    if (!isHome) {
      tabEl.draggable = true;
      tabEl.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", tab.key);
        tabEl.classList.add("oc-dragging");
      });
      tabEl.addEventListener("dragend", () => {
        tabEl.classList.remove("oc-dragging");
        document.querySelectorAll(".oc-drag-over").forEach(el => el.classList.remove("oc-drag-over"));
      });
      tabEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        tabEl.classList.add("oc-drag-over");
      });
      tabEl.addEventListener("dragleave", () => {
        tabEl.classList.remove("oc-drag-over");
      });
      tabEl.addEventListener("drop", (e) => {
        e.preventDefault();
        tabEl.classList.remove("oc-drag-over");
        const draggedKey = e.dataTransfer.getData("text/plain");
        if (draggedKey && draggedKey !== tab.key) {
          reorderTabs(draggedKey, tab.key);
        }
      });
    }

    if (!isCurrent) {
      tabEl.addEventListener("click", () => switchTab(tab));
    }

    fragment.appendChild(tabEl);
  }

  const addBtn = document.createElement("div");
  addBtn.className = "openclaw-tab openclaw-tab-add";
  const addLabel = document.createElement("span");
  addLabel.className = "openclaw-tab-label";
  addLabel.textContent = "+";
  addBtn.appendChild(addLabel);
  addBtn.addEventListener("click", () => createNewTab());
  fragment.appendChild(addBtn);

  // Swap in all at once (no flicker)
  ui.tabBar.innerHTML = "";
  ui.tabBar.appendChild(fragment);

  updateTabMode();
}

// ─── Drafts & Message Queue ──────────────────────────────────────────

function saveDraft() {
  const input = document.getElementById('message-input');
  if (!input || !state.sessionKey) return;
  const text = input.value.trim();
  if (text) {
    state.tabDrafts[state.sessionKey] = text;
  } else {
    delete state.tabDrafts[state.sessionKey];
  }
  localStorage.setItem('tabDrafts', JSON.stringify(state.tabDrafts));
}

function restoreDraft() {
  const input = document.getElementById('message-input');
  if (!input || !state.sessionKey) return;
  const draft = state.tabDrafts[state.sessionKey] || '';
  input.value = draft;
  input.dispatchEvent(new Event('input')); // trigger auto-resize
}

function clearDraft(key) {
  delete state.tabDrafts[key || state.sessionKey];
  localStorage.setItem('tabDrafts', JSON.stringify(state.tabDrafts));
}

function queueMessage(text, attachments) {
  const key = state.sessionKey;
  if (!key) return;
  // Only allow 1 queued message per tab
  const entry = { text, timestamp: Date.now() };
  if (attachments && attachments.length > 0) {
    entry.attachments = attachments.map(a => ({ name: a.name, mimeType: a.mimeType, base64: a.base64, content: a.content }));
  }
  state.messageQueue[key] = [entry];
  localStorage.setItem('messageQueue', JSON.stringify(state.messageQueue));
  renderQueuedMessages();
}

function removeQueuedMessage(key, index) {
  if (!state.messageQueue[key]) return;
  state.messageQueue[key].splice(index, 1);
  if (state.messageQueue[key].length === 0) delete state.messageQueue[key];
  localStorage.setItem('messageQueue', JSON.stringify(state.messageQueue));
  renderQueuedMessages();
}

function renderQueuedMessages() {
  let container = document.getElementById('message-queue');
  if (!container) {
    // Create queue container above the input area
    container = document.createElement('div');
    container.id = 'message-queue';
    container.className = 'oc-message-queue';
    const inputArea = document.querySelector('.openclaw-input-area-inner');
    if (inputArea) inputArea.prepend(container);
    else return;
  }

  const queue = state.messageQueue[state.sessionKey] || [];
  if (queue.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = '';
  container.innerHTML = queue.map((msg, i) => {
    let preview = msg.text || '';
    if (msg.attachments && msg.attachments.length > 0) {
      const names = msg.attachments.map(a => a.name).join(', ');
      preview = preview ? `📎 ${names} — ${preview}` : `📎 ${names}`;
    }
    if (preview.length > 80) preview = preview.slice(0, 80) + '…';
    const esc = preview.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<div class="oc-queue-item">
      <span class="oc-queue-badge">${i + 1}</span>
      <span class="oc-queue-text">${esc}</span>
      <button class="oc-queue-remove" onclick="removeQueuedMessage('${state.sessionKey}', ${i})" title="Remove">✕</button>
    </div>`;
  }).join('');
}

function processQueue() {
  const key = state.sessionKey;
  const queue = state.messageQueue[key];
  if (!queue || queue.length === 0) return;
  // Don't process if still streaming or sending
  if (state.streams.has(key) || state.sending) return;
  const next = queue.shift();
  if (queue.length === 0) delete state.messageQueue[key];
  localStorage.setItem('messageQueue', JSON.stringify(state.messageQueue));
  renderQueuedMessages();
  // Restore attachments if any
  if (next.attachments && next.attachments.length > 0) {
    state.pendingAttachments = next.attachments;
  }
  // Send directly (bypass input/click which can race)
  sendMessage(next.text || '');
}

async function switchTab(tab) {
  // Save draft from current tab before switching
  saveDraft();

  state.streamEl = null;
  ui.typingIndicator.classList.add("oc-hidden");
  setSendButtonStopMode(false);
  hideBanner();

  state.sessionKey = tab.key;
  localStorage.setItem("sessionKey", tab.key);

  // Serve from cache instantly if available
  const cached = state.tabCache[tab.key];
  if (cached) {
    state.messages = [...cached.messages];
    renderMessages();
    // Background refresh (don't await)
    loadChatHistory({ background: true });
  } else {
    state.messages = [];
    ui.messagesContainer.innerHTML = "";
    await loadChatHistory();
  }

  restoreStreamUI();
  restoreDraft();
  renderQueuedMessages();

  // Re-render tabs and context meter in background (don't block UI)
  renderTabs();
  updateContextMeter();
}

async function resetTab(tab) {
  if (!state.gateway?.connected) return;
  delete state.tabCache[tab.key];
  const isHome = tab.key === "main";
  const title = isHome ? "Reset Home?" : `Reset "${tab.label}"?`;
  const msg = "This will clear the conversation.";
  const ok = await confirmClose(title, msg);
  if (!ok) return;
  if (tab.key === state.sessionKey) {
    state.messages = [];
    ui.messagesContainer.innerHTML = "";
    showLoading("Resetting…");
  }
  try {
    await state.gateway.request("chat.send", {
      sessionKey: `${agentPrefix()}${tab.key}`,
      message: "/reset",
      deliver: false,
      idempotencyKey: "reset-" + Date.now(),
    });
    if (tab.key === state.sessionKey) hideLoading();
    await updateContextMeter();
    await renderTabs();
  } catch (err) {
    hideLoading();
    console.error("Reset failed:", err);
  }
}

async function closeTab(tab, currentKey) {
  if (!state.gateway?.connected || state.tabDeleteInProgress) return;
  const ok = await confirmClose("Close tab?", `Close "${tab.label}"? Chat history will be lost.`);
  if (!ok) return;
  delete state.tabCache[tab.key];
  state.tabDeleteInProgress = true;
  try {
    await deleteSessionWithFallback(state.gateway, `${agentPrefix()}${tab.key}`);
  } catch (err) {
    console.error("Close failed:", err);
  } finally {
    state.tabDeleteInProgress = false;
  }
  finishStream(tab.key);
  if (tab.key === currentKey) {
    state.sessionKey = "main";
    localStorage.setItem("sessionKey", "main");
    state.messages = [];
    ui.messagesContainer.innerHTML = "";
    await loadChatHistory();
  }
  await renderTabs();
  await updateContextMeter();
}

async function createNewTab() {
  if (!state.gateway?.connected) return;
  const nums = state.tabSessions
    .map(t => { const m = t.key.match(/^tab-(\d+)$/); return m ? parseInt(m[1]) : NaN; })
    .filter(n => !isNaN(n));
  const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  const sessionKey = `tab-${nextNum}`;
  try {
    await state.gateway.request("chat.send", {
      sessionKey: `${agentPrefix()}${sessionKey}`,
      message: "/new",
      deliver: false,
      idempotencyKey: "newtab-" + Date.now(),
    });
    await new Promise(r => setTimeout(r, 500));
    try {
      await state.gateway.request("sessions.patch", {
        key: `${agentPrefix()}${sessionKey}`,
        label: "Untitled",
      });
    } catch { /* label optional */ }

    state.streamEl = null;
    ui.typingIndicator.classList.add("oc-hidden");
    setSendButtonStopMode(false);
    hideBanner();

    state.sessionKey = sessionKey;
    localStorage.setItem("sessionKey", sessionKey);
    state.messages = [];
    ui.messagesContainer.innerHTML = "";
    showLoading("Loading…");
    await renderTabs();
    await updateContextMeter();
  } catch (err) {
    console.error("Failed to create tab:", err);
  }
}

function reorderTabs(draggedKey, targetKey) {
  const keys = state.tabSessions.filter(t => t.key !== "main").map(t => t.key);
  const fromIdx = keys.indexOf(draggedKey);
  const toIdx = keys.indexOf(targetKey);
  if (fromIdx === -1 || toIdx === -1) return;
  keys.splice(fromIdx, 1);
  keys.splice(toIdx, 0, draggedKey);
  localStorage.setItem("tabOrder", JSON.stringify(keys));
  renderTabs();
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

    const fullModel = session.model || "";
    const modelCooldown = Date.now() - state.currentModelSetAt < 15000;
    if (fullModel && fullModel !== state.currentModel && !modelCooldown) {
      state.currentModel = fullModel;
      localStorage.setItem("currentModel", fullModel);
      updateModelLabel();
    }

    // Sync session controls
    state.thinkingLevel = session.thinkingLevel || "";
    state.reasoningLevel = session.reasoningLevel || "";
    state.verboseLevel = session.verboseLevel || "";
    updateBarControls();

    const activeFill = ui.tabBar?.querySelector(".openclaw-tab.active .openclaw-tab-meter-fill");
    if (activeFill) {
      const used = session.totalTokens || 0;
      const max = session.contextTokens || 200000;
      const pct = Math.min(100, Math.round((used / max) * 100));
      activeFill.style.width = pct + "%";
    }

    const currentSessionKeys = new Set(
      sessions.filter(s => {
          if (!s.key.startsWith(prefix)) return false;
          if (s.key.includes(":cron:") || s.key.includes(":subagent:")) return false;
          const sfx = s.key.slice(prefix.length);
          if (/(?:telegram|signal|discord|whatsapp|irc|slack|googlechat|imessage):/.test(sfx)) return false;
          return true;
        }).map(s => s.key)
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
    
    // Update subagents panel from same sessions data
    loadSubagents();
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
  updateDashboard();
}

// ─── Bar Controls (thinking/reasoning/verbose) ──────────────────────

const THINKING_CYCLE = ["", "off", "low", "medium", "high"];
const REASONING_CYCLE = ["", "off", "on", "stream"];
const VERBOSE_CYCLE = ["", "off", "on", "full"];

function defaultLabel(defaultVal, key) {
  const val = (key && key in state.pendingDefaults) ? state.pendingDefaults[key] : defaultVal;
  return val ? "default (" + val + ")" : "default";
}

function updateBarControls() {
  const thinkEl = document.getElementById("bar-thinking");
  const reasonEl = document.getElementById("bar-reasoning");
  const verboseEl = document.getElementById("bar-verbose");

  if (thinkEl) {
    const v = state.thinkingLevel || defaultLabel(state.defaults.thinking, "thinking");
    thinkEl.textContent = "think: " + v;
    thinkEl.classList.toggle("active", !!state.thinkingLevel);
  }
  if (reasonEl) {
    // Reasoning is a toggle-style chip: just show the mode, highlight when on
    const level = state.reasoningLevel || "";
    const isOn = level === "on" || level === "stream";
    reasonEl.textContent = isOn ? (level === "stream" ? "reasoning ⚡" : "reasoning ●") : "reasoning";
    reasonEl.classList.toggle("active", isOn);
  }
  if (verboseEl) {
    const v = state.verboseLevel || defaultLabel(state.defaults.verbose, "verbose");
    verboseEl.textContent = "verbose: " + v;
    verboseEl.classList.toggle("active", !!state.verboseLevel);
  }
}

async function cycleBarControl(field, cycle) {
  if (!state.gateway?.connected) return;
  const current = state[field] || "";
  const idx = cycle.indexOf(current);
  const next = cycle[(idx + 1) % cycle.length];
  const patch = {};
  patch[field] = next || null; // null = clear override (inherit)
  try {
    await state.gateway.request("sessions.patch", {
      key: `${agentPrefix()}${state.sessionKey}`,
      ...patch,
    });
    state[field] = next;
    updateBarControls();
  } catch (err) {
    console.error(`Failed to set ${field}:`, err);
  }
}

document.getElementById("bar-thinking")?.addEventListener("click", () =>
  cycleBarControl("thinkingLevel", THINKING_CYCLE));
document.getElementById("bar-reasoning")?.addEventListener("click", () =>
  cycleBarControl("reasoningLevel", REASONING_CYCLE));
document.getElementById("bar-verbose")?.addEventListener("click", () =>
  cycleBarControl("verboseLevel", VERBOSE_CYCLE));

async function openModelPicker(opts = {}) {
  // opts.current: current model id, opts.onSelect: callback(fullId, modal)
  // If no onSelect, uses default session model switch behavior
  let models = [];
  try {
    const result = await state.gateway?.request("models.list", {});
    models = result?.models || [];
  } catch { models = []; }

  let currentModel = opts.current || state.currentModel || "";
  if (currentModel && !currentModel.includes("/")) {
    const match = models.find(m => m.id === currentModel);
    if (match) currentModel = `${match.provider}/${match.id}`;
  }

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

  const onSelect = opts.onSelect || null;

  if (providers.length > 1) {
    renderProviderList(box, providerMap, currentModel, currentProvider, modal, onSelect);
  } else if (providers.length === 1) {
    renderModelList(box, providerMap.get(providers[0]), providers[0], currentModel, modal, null, onSelect);
  } else {
    box.innerHTML = "<h3>No models available</h3>";
  }

  modal.appendChild(box);
  document.body.appendChild(modal);
}

function renderProviderList(box, providerMap, currentModel, currentProvider, modal, onSelect) {
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
      renderModelList(box, models, provider, currentModel, modal, providerMap, onSelect);
    });
    list.appendChild(row);
  }
  box.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "openclaw-picker-footer";
  footer.innerHTML = 'Want more models? <a href="https://docs.openclaw.ai/gateway/configuration#choose-and-configure-models" target="_blank">Add them in your gateway config.</a>';
  box.appendChild(footer);
}

function renderModelList(box, models, provider, currentModel, modal, providerMap, onSelect) {
  box.innerHTML = "";

  if (providerMap && providerMap.size > 1) {
    const backBtn = document.createElement("button");
    backBtn.className = "openclaw-picker-back";
    backBtn.textContent = "← " + provider;
    backBtn.addEventListener("click", () => {
      box.innerHTML = "";
      const currentProvider = currentModel.includes("/") ? currentModel.split("/")[0] : "";
      renderProviderList(box, providerMap, currentModel, currentProvider, modal, onSelect);
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
      if (onSelect) {
        // Custom callback (e.g. for defaults panel)
        onSelect(fullId, modal);
        return;
      }
      if (!state.gateway?.connected) return;
      row.className = "openclaw-picker-row openclaw-picker-selecting";
      row.textContent = "Switching...";
      try {
        await state.gateway.request("chat.send", {
          sessionKey: `${agentPrefix()}${state.sessionKey}`,
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

// ─── Loading Indicator ───────────────────────────────────────────────

function showLoading(text = "Loading…") {
  hideLoading();
  ui.messagesContainer.classList.add("oc-loading");
  const el = document.createElement("div");
  el.className = "openclaw-loading";
  el.id = "oc-loading-indicator";
  el.innerHTML = `<div class="spinner"></div><span>${text}</span>`;
  ui.messagesContainer.appendChild(el);
}

function hideLoading() {
  ui.messagesContainer.classList.remove("oc-loading");
  document.getElementById("oc-loading-indicator")?.remove();
}

// ─── Chat Functions ──────────────────────────────────────────────────

async function loadChatHistory(opts) {
  const background = opts?.background || false;
  const targetKey = opts?.sessionKey || state.sessionKey;
  if (!state.gateway?.connected) return;
  if (!background) showLoading("Loading…");
  try {
    const result = await state.gateway.request("chat.history", {
      sessionKey: `${agentPrefix()}${targetKey}`,
      limit: 200,
    });

    const messages = result?.messages || [];
    let parsed = messages
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

    if (parsed.length > 0 && parsed[0].role === "user") {
      parsed = parsed.slice(1);
    }

    // Cache the result
    state.tabCache[targetKey] = { messages: parsed, timestamp: Date.now() };

    // Only update UI if this is still the active tab
    if (targetKey === state.sessionKey) {
      state.messages = parsed;
      if (!background) hideLoading();
      renderMessages();
    }
  } catch (err) {
    if (!background && targetKey === state.sessionKey) hideLoading();
    console.error("Failed to load chat history:", err);
  }
}

// Pre-fetch history for all tabs in background
async function prefetchAllTabs() {
  if (!state.gateway?.connected) return;
  for (const tab of state.tabSessions) {
    if (tab.key === state.sessionKey) continue; // skip active tab
    if (state.tabCache[tab.key]) continue; // already cached
    loadChatHistory({ background: true, sessionKey: tab.key });
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
  // Sync cache with current messages
  if (state.sessionKey && state.messages.length > 0) {
    state.tabCache[state.sessionKey] = { messages: [...state.messages], timestamp: Date.now() };
  }
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

  const allAudio = msg.text ? extractVoiceRefs(msg.text) : [];

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
  text = text.replace(/VOICE:([^\s]+)/g, "");

  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const langLabel = lang ? `<div style="font-family:var(--font-mono,'IBM Plex Mono',monospace);font-size:10px;color:var(--text-faint,#666);padding:4px 10px 0;letter-spacing:0.06em;text-transform:uppercase">${lang}</div>` : "";
    codeBlocks.push(`<pre style="margin:6px 0;background:var(--background-secondary,#141416);border:1px solid var(--background-modifier-border,rgba(255,255,255,0.06));border-radius:4px;overflow-x:auto">${langLabel}<code style="display:block;padding:8px 12px;font-size:12px;line-height:1.6;background:none">${escapeHtmlChat(code)}</code></pre>`);
    return `\x00CB${idx}\x00`;
  });

  const inlineCodes = [];
  processed = processed.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtmlChat(code)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  let html = escapeHtmlChat(processed);

  html = html.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[i]);
  html = html.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[i]);

  html = html.replace(/^(\|.+\|)\n(\|[\s\-:|]+\|)\n((?:\|.+\|\n?)+)/gm, (_, header, align, body) => {
    const parseAligns = (row) => row.split('|').filter(c => c.trim()).map(c => {
      c = c.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    const aligns = parseAligns(align);
    const ths = header.split('|').filter(c => c.trim()).map((c, i) =>
      `<th style="text-align:${aligns[i]||'left'}">${c.trim()}</th>`
    ).join('');
    const rows = body.trim().split('\n').map(row => {
      const cells = row.split('|').filter(c => c.trim()).map((c, i) =>
        `<td style="text-align:${aligns[i]||'left'}">${c.trim()}</td>`
      ).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  html = html.replace(/^(&gt;\s?.+\n?)+/gm, (match) => {
    const inner = match.replace(/^&gt;\s?/gm, '').trim();
    return `<blockquote>${inner}</blockquote>`;
  });

  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  html = html.replace(/^---+$/gm, "<hr>");

  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");

  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:4px">');

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  html = html.replace(/^[\-\*]\s+(.+)$/gm, "<li>$1</li>");

  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li class="ol-item">$1</li>');

  html = html.replace(/((?:<li(?:\s[^>]*)?>.*?<\/li>\s*)+)/g, (match) => {
    if (match.includes('class="ol-item"')) return '<ol>' + match.replace(/ class="ol-item"/g, '') + '</ol>';
    return '<ul>' + match + '</ul>';
  });

  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  html = "<p>" + html + "</p>";

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

  html = html.replace(/<\/li>\s*<br>\s*<li/g, '</li><li');
  html = html.replace(/<ul>\s*<br>/g, '<ul>');
  html = html.replace(/<ol>\s*<br>/g, '<ol>');
  html = html.replace(/<br>\s*<\/ul>/g, '</ul>');
  html = html.replace(/<br>\s*<\/ol>/g, '</ol>');

  return html;
}

function escapeHtmlChat(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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
    setSendButtonStopMode(false);
    ui.typingIndicator.classList.add("oc-hidden");
    const typingText = ui.typingIndicator.querySelector(".openclaw-typing-text");
    if (typingText) typingText.textContent = "Thinking";
    // Auto-send next queued message after a brief pause
    setTimeout(() => processQueue(), 500);
  }
}

function restoreStreamUI() {
  const ss = state.streams.get(state.sessionKey);
  if (!ss) return;
  setSendButtonStopMode(true);
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
  ui.messageInput.value = "";
  autoResize();

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

  // Auto-rename "Untitled" tabs based on first message
  void autoRenameTab(state.sessionKey, text);

  const runId = generateId();
  const sendSessionKey = state.sessionKey;

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

  setSendButtonStopMode(true);
  ui.typingIndicator.classList.remove("oc-hidden");
  const thinkText = ui.typingIndicator.querySelector(".openclaw-typing-text");
  if (thinkText) thinkText.textContent = "Thinking";
  scrollToBottom();

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
      sessionKey: `${agentPrefix()}${sendSessionKey}`,
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
    setSendButtonStopMode(false);
    renderMessages();
  } finally {
    state.sending = false;
  }
}

async function abortMessage() {
  const ss = state.streams.get(state.sessionKey);
  if (!state.gateway?.connected || !ss) return;
  try {
    await state.gateway.request("chat.abort", {
      sessionKey: `${agentPrefix()}${state.sessionKey}`,
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

// ─── Voice Input (STT) ───────────────────────────────────────────────

const voiceState = {
  mediaRecorder: null,
  audioChunks: [],
  recording: false,
  transcribing: false,
};

const SEND_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
const MIC_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';

function isSTTConfigured() {
  return !!localStorage.getItem("openclaw-stt-key");
}

function getSTTConfig() {
  return {
    url: localStorage.getItem("openclaw-stt-url") || "https://api.openai.com/v1/audio/transcriptions",
    key: localStorage.getItem("openclaw-stt-key") || "",
    model: localStorage.getItem("openclaw-stt-model") || "whisper-1",
  };
}

function updateSendButton() {
  // Don't override stop/queue mode icons
  if (ui.sendBtn?.classList.contains('stop-mode')) { updateStopSendIcon(); return; }

  const hasContent = ui.messageInput.value.trim() || state.pendingAttachments.length > 0;
  const sttReady = isSTTConfigured();

  if (hasContent || voiceState.recording || voiceState.transcribing) {
    ui.sendBtn.classList.remove("oc-opacity-low");
  } else if (!sttReady) {
    ui.sendBtn.classList.add("oc-opacity-low");
  } else {
    ui.sendBtn.classList.remove("oc-opacity-low");
  }

  if (voiceState.recording) {
    ui.sendBtn.innerHTML = MIC_ICON;
    ui.sendBtn.classList.remove("oc-opacity-low", "mic-mode", "transcribing");
    ui.sendBtn.classList.add("recording");
  } else if (voiceState.transcribing) {
    ui.sendBtn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div>';
    ui.sendBtn.classList.remove("oc-opacity-low", "mic-mode", "recording");
    ui.sendBtn.classList.add("transcribing");
  } else if (!hasContent && sttReady) {
    ui.sendBtn.innerHTML = MIC_ICON;
    ui.sendBtn.classList.remove("recording", "transcribing");
    ui.sendBtn.classList.add("mic-mode");
  } else {
    ui.sendBtn.innerHTML = SEND_ICON;
    ui.sendBtn.classList.remove("mic-mode", "recording", "transcribing");
  }
}

async function handleMicClick() {
  if (voiceState.transcribing) return;

  if (voiceState.recording) {
    voiceState.mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
    voiceState.mediaRecorder = new MediaRecorder(stream, { mimeType });
    voiceState.audioChunks = [];

    voiceState.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceState.audioChunks.push(e.data);
    };

    voiceState.mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      voiceState.recording = false;
      voiceState.transcribing = true;
      updateSendButton();

      const blob = new Blob(voiceState.audioChunks, { type: voiceState.mediaRecorder.mimeType });
      const config = getSTTConfig();
      const ext = voiceState.mediaRecorder.mimeType.includes("webm") ? "webm" : "m4a";

      try {
        const formData = new FormData();
        formData.append("file", blob, `recording.${ext}`);
        formData.append("model", config.model);

        const response = await fetch(config.url, {
          method: "POST",
          headers: { "Authorization": `Bearer ${config.key}` },
          body: formData,
        });

        if (!response.ok) throw new Error(`STT failed: ${response.status}`);
        const result = await response.json();
        const text = result.text || "";
        if (text) {
          ui.messageInput.value = text;
          autoResize();
        }
      } catch (err) {
        console.error("Transcription failed:", err);
      } finally {
        voiceState.transcribing = false;
        voiceState.mediaRecorder = null;
        voiceState.audioChunks = [];
        updateSendButton();
      }
    };

    voiceState.mediaRecorder.start();
    voiceState.recording = true;
    updateSendButton();
  } catch (err) {
    console.error("Mic access failed:", err);
  }
}

function autoResize() {
  ui.messageInput.style.height = "auto";
  ui.messageInput.style.height = Math.min(ui.messageInput.scrollHeight, 120) + "px";
}

// ─── Input Handlers ──────────────────────────────────────────────────

function handleSendOrQueue() {
  const text = ui.messageInput.value.trim();
  const isStreaming = state.streams.has(state.sessionKey);

  // If streaming and input is empty, abort (stop button behavior)
  if (ui.sendBtn.classList.contains("stop-mode") && !text) {
    abortMessage();
    return;
  }

  if (ui.sendBtn.classList.contains("mic-mode") || ui.sendBtn.classList.contains("recording")) {
    handleMicClick();
    return;
  }

  if (!text && state.pendingAttachments.length === 0) return;

  // If agent is currently streaming, queue the message (with any attachments)
  if (isStreaming && (text || state.pendingAttachments.length > 0)) {
    queueMessage(text, state.pendingAttachments.length > 0 ? [...state.pendingAttachments] : null);
    ui.messageInput.value = '';
    ui.messageInput.dispatchEvent(new Event('input'));
    // Clear attachments from UI
    if (state.pendingAttachments.length > 0) {
      state.pendingAttachments = [];
      ui.attachPreview.classList.add('oc-hidden');
      ui.attachPreview.innerHTML = '';
    }
    clearDraft(state.sessionKey);
    return;
  }

  clearDraft(state.sessionKey);
  sendMessage(ui.messageInput.value);
}

ui.sendBtn.addEventListener("click", handleSendOrQueue);

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || window.innerWidth <= 768;
state.isMobile = isMobile;

// ─── Keep input pinned when virtual keyboard opens (iOS/Android) ────
if (isMobile && window.visualViewport) {
  const inputArea = document.querySelector('.openclaw-input-area');
  const chatContainer = document.getElementById('chat-container');
  let vpTimeout;
  const onViewportResize = () => {
    clearTimeout(vpTimeout);
    vpTimeout = setTimeout(() => {
      const vv = window.visualViewport;
      const keyboardOpen = vv.height < window.innerHeight * 0.85;
      if (keyboardOpen) {
        // Keyboard is open: offset the input area up by the keyboard height
        const offset = window.innerHeight - vv.height - vv.offsetTop;
        inputArea.style.paddingBottom = '0px';
        chatContainer.style.height = vv.height + 'px';
      } else {
        // Keyboard closed: restore
        inputArea.style.paddingBottom = '';
        chatContainer.style.height = '';
      }
    }, 50);
  };
  window.visualViewport.addEventListener('resize', onViewportResize);
  window.visualViewport.addEventListener('scroll', onViewportResize);
}

ui.messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !isMobile) {
    e.preventDefault();
    handleSendOrQueue();
  }
});

ui.messageInput.addEventListener("input", () => {
  autoResize();
  if (ui.sendBtn.classList.contains('stop-mode')) {
    updateStopSendIcon();
  } else {
    updateSendButton();
  }
});

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

ui.modelLabel.addEventListener("click", () => openModelPicker());

ui.attachBtn.addEventListener("click", () => ui.fileInput.click());
ui.fileInput.addEventListener("change", () => handleFileSelect());

// Send button mode: toggles between send and stop
const STOP_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';

function setSendButtonStopMode(isStop) {
  const btn = ui.sendBtn;
  if (!btn) return;
  if (isStop) {
    btn.classList.add('stop-mode');
    btn.disabled = false;
    updateStopSendIcon();
  } else {
    btn.classList.remove('stop-mode');
    btn.classList.remove('queue-mode');
    updateSendButton();
  }
}

// When streaming: show send arrow if input has text (queue mode), stop square if empty
function updateStopSendIcon() {
  const btn = ui.sendBtn;
  if (!btn || !btn.classList.contains('stop-mode')) return;
  const hasText = ui.messageInput.value.trim().length > 0;
  btn.classList.remove('oc-opacity-low');
  if (hasText) {
    btn.classList.add('queue-mode');
    btn.innerHTML = SEND_ICON;
  } else {
    btn.classList.remove('queue-mode');
    btn.innerHTML = STOP_ICON;
  }
}

ui.tabBar.addEventListener("wheel", (e) => {
  e.preventDefault();
  ui.tabBar.scrollLeft += e.deltaY;
}, { passive: false });

// ─── Touch Gestures (swipe between tabs) ──────────

(function initTouchGestures() {
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
  let swiping = false, swipeLocked = false;
  let currentDeltaX = 0, rafId = 0;
  let incomingPane = null;

  const SWIPE_THRESHOLD = 0.25;  // fraction of screen width to commit
  const SWIPE_VELOCITY = 0.3;    // px/ms — fast flick commits even if short
  const LOCK_DISTANCE = 15;      // px before we decide swipe vs scroll
  const RESISTANCE = 0.3;        // rubber-band factor at edges

  function getContainerWidth() {
    return ui.messagesContainer?.offsetWidth || window.innerWidth;
  }

  function getSwipeTarget(deltaX) {
    const currentIdx = state.tabSessions.findIndex(t => t.key === state.sessionKey);
    if (currentIdx < 0) return null;
    const nextIdx = deltaX < 0 ? currentIdx + 1 : currentIdx - 1;
    if (nextIdx < 0 || nextIdx >= state.tabSessions.length) return null;
    return { idx: nextIdx, tab: state.tabSessions[nextIdx] };
  }

  function createIncomingPane(tab, fromRight) {
    removeIncomingPane();
    const pane = document.createElement("div");
    pane.className = "oc-swipe-incoming";
    pane.style.cssText = `
      position: absolute; top: 0; bottom: 0; width: 100%;
      ${fromRight ? "left: 100%;" : "right: 100%;"}
      display: flex; flex-direction: column; gap: 8px;
      padding: 16px max(16px, calc(50% - 410px));
      overflow: hidden; pointer-events: none;
      background: var(--background-primary, #1a1a1e);
    `;
    // Render cached messages or a tab label
    const cached = state.tabCache[tab.key];
    if (cached && cached.messages.length > 0) {
      // Show last few messages as preview
      const msgs = cached.messages.slice(-8);
      for (const msg of msgs) {
        const bubble = document.createElement("div");
        bubble.className = `openclaw-msg openclaw-msg-${msg.role}`;
        const textDiv = document.createElement("div");
        textDiv.className = "openclaw-msg-text";
        textDiv.innerHTML = formatMarkdown(msg.text.slice(0, 300));
        bubble.appendChild(textDiv);
        pane.appendChild(bubble);
      }
    } else {
      const label = document.createElement("div");
      label.style.cssText = "color: var(--text-faint); text-align: center; padding: 40px 16px; font-size: 13px;";
      label.textContent = tab.label || "Untitled";
      pane.appendChild(label);
    }
    return pane;
  }

  function removeIncomingPane() {
    if (incomingPane && incomingPane.parentNode) {
      incomingPane.parentNode.removeChild(incomingPane);
    }
    incomingPane = null;
  }

  function applySwipeTransform(deltaX) {
    const w = getContainerWidth();
    const target = getSwipeTarget(deltaX);
    let clampedDelta = deltaX;

    // Rubber-band if no target tab in this direction
    if (!target) {
      clampedDelta = deltaX * RESISTANCE;
    }

    // Move messages container
    ui.messagesContainer.style.transform = `translateX(${clampedDelta}px)`;

    // Move incoming pane with it (it's absolutely positioned inside container's parent)
    if (incomingPane) {
      incomingPane.style.transform = `translateX(${clampedDelta}px)`;
    }

    // Fade tab switcher label
    const progress = Math.min(1, Math.abs(clampedDelta) / (w * 0.5));
    const switcherLabel = document.getElementById("tab-switcher-label");
    if (switcherLabel) {
      switcherLabel.style.opacity = 1 - progress * 0.6;
      switcherLabel.style.transform = `translateX(${clampedDelta * 0.3}px)`;
    }
  }

  function resetSwipeStyles() {
    ui.messagesContainer.style.transform = "";
    ui.messagesContainer.style.transition = "";
    ui.messagesContainer.style.willChange = "";
    const switcherLabel = document.getElementById("tab-switcher-label");
    if (switcherLabel) {
      switcherLabel.style.opacity = "";
      switcherLabel.style.transform = "";
      switcherLabel.style.transition = "";
    }
    removeIncomingPane();
  }

  function animateSwipe(commit, deltaX, targetTab) {
    const w = getContainerWidth();
    const duration = commit ? "250ms" : "200ms";
    const easing = commit ? "cubic-bezier(0.2, 0.9, 0.3, 1)" : "cubic-bezier(0.4, 0, 0.2, 1)";
    const destX = commit ? (deltaX < 0 ? -w : w) : 0;

    ui.messagesContainer.style.transition = `transform ${duration} ${easing}`;
    ui.messagesContainer.style.transform = `translateX(${destX}px)`;

    if (incomingPane) {
      incomingPane.style.transition = `transform ${duration} ${easing}`;
      incomingPane.style.transform = `translateX(${destX}px)`;
    }

    const switcherLabel = document.getElementById("tab-switcher-label");
    if (switcherLabel) {
      switcherLabel.style.transition = `opacity ${duration} ${easing}, transform ${duration} ${easing}`;
      switcherLabel.style.opacity = commit ? "0" : "1";
      switcherLabel.style.transform = commit ? `translateX(${destX * 0.3}px)` : "";
    }

    const onEnd = () => {
      ui.messagesContainer.removeEventListener("transitionend", onEnd);
      resetSwipeStyles();
      if (commit && targetTab) {
        switchTab(targetTab);
      }
    };
    ui.messagesContainer.addEventListener("transitionend", onEnd);
    // Safety timeout in case transitionend doesn't fire
    setTimeout(onEnd, commit ? 300 : 250);
  }

  if (ui.messagesContainer) {
    // Container needs relative positioning for the incoming pane
    const chatArea = ui.messagesContainer.parentElement;

    ui.messagesContainer.addEventListener("touchstart", (e) => {
      if (!state.isMobile) return;
      if (e.target.closest("textarea, input, a, button, .openclaw-tool-item")) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      swiping = false;
      swipeLocked = false;
      currentDeltaX = 0;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }, { passive: true });

    ui.messagesContainer.addEventListener("touchmove", (e) => {
      if (!state.isMobile) return;
      if (e.target.closest("textarea, input")) return;

      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const deltaX = currentX - touchStartX;
      const deltaY = currentY - touchStartY;

      // Decide direction lock
      if (!swipeLocked && !swiping) {
        if (Math.abs(deltaX) < LOCK_DISTANCE && Math.abs(deltaY) < LOCK_DISTANCE) return;
        if (Math.abs(deltaX) > Math.abs(deltaY) * 3) {
          swiping = true;
          swipeLocked = true;
          ui.messagesContainer.style.willChange = "transform";
          // Create incoming pane
          const target = getSwipeTarget(deltaX);
          if (target) {
            incomingPane = createIncomingPane(target.tab, deltaX < 0);
            chatArea.style.position = "relative";
            chatArea.style.overflow = "hidden";
            chatArea.appendChild(incomingPane);
          }
        } else {
          swipeLocked = true;
          swiping = false;
          return;
        }
      }

      if (!swiping) return;

      currentDeltaX = deltaX;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        applySwipeTransform(currentDeltaX);
        rafId = 0;
      });
    }, { passive: true });

    ui.messagesContainer.addEventListener("touchend", (e) => {
      if (!state.isMobile) return;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }

      if (!swiping) {
        ui.messagesContainer.style.willChange = "";
        return;
      }

      swiping = false;
      swipeLocked = false;

      const deltaX = e.changedTouches[0].clientX - touchStartX;
      const elapsed = Date.now() - touchStartTime;
      const velocity = Math.abs(deltaX) / Math.max(1, elapsed);
      const w = getContainerWidth();
      const progress = Math.abs(deltaX) / w;

      const target = getSwipeTarget(deltaX);
      const commit = target && (progress > SWIPE_THRESHOLD || velocity > SWIPE_VELOCITY);

      animateSwipe(commit, deltaX, commit ? target.tab : null);
    }, { passive: true });

    // Cancel swipe on touch cancel
    ui.messagesContainer.addEventListener("touchcancel", () => {
      if (swiping) {
        swiping = false;
        swipeLocked = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        resetSwipeStyles();
      }
    }, { passive: true });
  }
})();

window.ocResetCloseConfirm = () => { setCloseConfirmDisabled(false); console.log("Close confirmation re-enabled"); };

// ─── Dashboard ──────────────────────────────────────────────────────

function updateDashboard() {
  const connected = state.gateway?.connected;

  // Orb state
  const orb = document.getElementById('hud-orb');
  if (orb) orb.className = 'hud-orb' + (connected ? ' online' : '');

  // Emoji
  const emojiEl = document.getElementById('hud-beacon-emoji');
  const name = state.activeAgent?.name || 'Agent';
  if (emojiEl) emojiEl.textContent = state.activeAgent?.emoji || '🤖';

  // Agent name (preserve chevron indicator)
  const nameEl = document.getElementById('hud-agent-name');
  if (nameEl) {
    const chevron = nameEl.querySelector('.hud-agent-chevron');
    nameEl.textContent = name + ' ';
    if (chevron) nameEl.appendChild(chevron);
    else {
      const ch = document.createElement('span');
      ch.className = 'hud-agent-chevron';
      ch.textContent = '▾';
      nameEl.appendChild(ch);
    }
  }

  // Status line
  const statusLine = document.getElementById('hud-status-line');
  if (statusLine) {
    statusLine.textContent = connected ? 'ONLINE' : 'OFFLINE';
    statusLine.className = 'hud-status-line' + (connected ? ' online' : '');
  }



  // Connection info
  const connStatus = document.getElementById('hud-conn-status');
  const connUrl = document.getElementById('hud-conn-url');
  if (connStatus) {
    if (connected) {
      connStatus.textContent = 'Connected';
      connStatus.className = 'hud-defaults-value hud-conn-status-on';
    } else if (state.gatewayUrl) {
      connStatus.textContent = 'Disconnected';
      connStatus.className = 'hud-defaults-value hud-conn-status-off';
    } else {
      connStatus.textContent = '—';
      connStatus.className = 'hud-defaults-value';
    }
  }
  if (connUrl && state.gatewayUrl) {
    try {
      const hostname = new URL(state.gatewayUrl.replace(/^ws/, 'http')).hostname;
      const short = hostname.split('.')[0];
      connUrl.textContent = short;
      connUrl.title = hostname;
    } catch {
      connUrl.textContent = state.gatewayUrl.replace(/^wss?:\/\//, '').replace(/\/+$/, '');
    }
  }

  // Show connect form or dashboard content
  const connectForm = document.getElementById('dash-connect-form');
  const dashboard = document.getElementById('dashboard');
  const hudSections = document.querySelectorAll('#dashboard .hud-identity, #dashboard .hud-alerts, #dashboard .hud-next, #dashboard .hud-timeline, #dashboard .hud-files-row, #dashboard .hud-inline-setting, #dashboard .hud-section');
  if (!state.gatewayUrl || !state.token) {
    if (connectForm) connectForm.style.display = '';
    hudSections.forEach(s => s.style.display = 'none');
    // No credentials — skip skeleton, show connect form directly
    if (dashboard) {
      dashboard.classList.remove('dash-loading');
      dashboard.classList.add('dash-loaded');
    }
  } else {
    if (connectForm) connectForm.style.display = 'none';
    hudSections.forEach(s => s.style.display = '');
    // Show skeleton while loading
    if (dashboard && !dashboard.classList.contains('dash-loaded')) {
      dashboard.classList.add('dash-loading');
    }
  }

  // Load settings
  loadDashSettings();

  // Fetch server info if connected
  if (connected) fetchServerInfo();
}

async function fetchServerInfo() {
  if (!state.gateway?.connected) return;
  try {
    const health = await state.gateway.request('health', {});
    const alerts = [];

    // Load dynamic sections
    loadAgentSwitcher();
    loadAgentFiles();
    loadCronJobs();

    // Version + Update (from connect snapshot)
    const snap = state.snapshot || {};

    // Version
    const vEl = document.getElementById('hud-version-val');
    if (vEl && state.serverVersion) vEl.textContent = 'v' + state.serverVersion;

    // Update available
    const upd = snap.updateAvailable;
    const updateEl = document.getElementById('hud-update-badge');
    const updateRow = document.getElementById('hud-update-row');
    if (updateEl && upd && upd.latestVersion && upd.currentVersion !== upd.latestVersion) {
      if (updateRow) updateRow.style.display = '';
      updateEl.textContent = 'v' + upd.latestVersion + ' available';
    }

    // Check for update (compare versions) — show subtly near version
    const currentVersion = state.serverVersion;
    if (currentVersion) {
      try {
        const resp = await fetch('https://registry.npmjs.org/openclaw/latest', { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const pkg = await resp.json();
          const latest = pkg.version;
          if (latest && latest !== currentVersion) {
            const updateRow = document.getElementById('hud-update-row');
            const updateBadge = document.getElementById('hud-update-badge');
            if (updateRow) updateRow.style.display = '';
            if (updateBadge) updateBadge.textContent = 'v' + latest + ' available';
          }
        }
      } catch (e) { /* can't check, skip */ }
    }

    // Clear top alerts (no longer used)
    const alertsEl = document.getElementById('hud-alerts');
    if (alertsEl) alertsEl.innerHTML = '';

    // Mark dashboard as loaded (fade in content, hide skeleton)
    const dash = document.getElementById('dashboard');
    if (dash) {
      dash.classList.remove('dash-loading');
      dash.classList.add('dash-loaded');
    }

    // Preload browser + terminal iframes in background
    if (typeof preloadAllEmbeds === 'function') preloadAllEmbeds();

  } catch (err) {
    console.warn('Failed to fetch server info:', err);
    // Still mark loaded on error to show what we have
    const dash = document.getElementById('dashboard');
    if (dash) {
      dash.classList.remove('dash-loading');
      dash.classList.add('dash-loaded');
    }
  }
}

// ─── Agent File List + Viewer ─────────────────────────────────────

const FILE_META = {
  'SOUL.md':      { label: 'Personality' },
  'USER.md':      { label: 'About You' },
  'MEMORY.md':    { label: 'Memory' },
  'TOOLS.md':     { label: 'Tools & Access' },
  'AGENTS.md':    { label: 'Behavior Rules' },
  'IDENTITY.md':  { label: 'Identity' },
  'HEARTBEAT.md': { label: 'Check-ins' },
  'BOOTSTRAP.md': { label: 'Setup Script' },
};

function friendlyFile(name) {
  const meta = FILE_META[name];
  if (meta) return meta;
  const clean = name.replace(/\.md$/i, '').replace(/[-_]/g, ' ');
  return { label: clean.charAt(0).toUpperCase() + clean.slice(1) };
}

// ─── Collapsible Sections ─────────────────────────────────────────

function toggleSection(sectionId) {
  const el = document.querySelector(`.hud-collapsible[data-section="${sectionId}"]`);
  if (!el) return;
  const wasOpen = el.classList.contains('hud-open');

  // Accordion: close all other sections first
  document.querySelectorAll('.hud-collapsible.hud-open').forEach(other => {
    if (other !== el) {
      other.classList.remove('hud-open');
      // If it's an embed panel, also destroy its iframe
      const otherSection = other.dataset.section;
      if (otherSection === 'agent-browser' || otherSection === 'agent-terminal') {
        const evt = new CustomEvent('panel-close', { detail: otherSection });
        document.dispatchEvent(evt);
      }
    }
  });

  // Toggle the clicked section
  const isOpen = wasOpen ? false : true;
  if (isOpen) el.classList.add('hud-open');
  else el.classList.remove('hud-open');

  // Remember which section is open (only one at a time)
  localStorage.setItem('openSection', isOpen ? sectionId : '');
}

function restoreCollapsibleState() {
  // Migrate from old multi-open format
  const legacy = localStorage.getItem('openSections');
  if (legacy) localStorage.removeItem('openSections');
  localStorage.removeItem('browserPanelOpen');
  localStorage.removeItem('terminalPanelOpen');
  localStorage.removeItem('mindfeedPanelOpen');

  const openId = localStorage.getItem('openSection') || 'agent-browser';
  if (openId) {
    const el = document.querySelector(`.hud-collapsible[data-section="${openId}"]`);
    if (el) el.classList.add('hud-open');
  }
}

async function loadAgentFiles() {
  const container = document.getElementById('hud-file-list');
  if (!container || !state.gateway?.connected) return;

  let files = [];
  try {
    const agentId = state.activeAgent?.id || 'main';
    const result = await state.gateway.request('agents.files.list', { agentId });
    files = result?.files || [];
  } catch (err) {
    console.warn('Failed to load agent files:', err);
    files = [{ name: 'SOUL.md' }, { name: 'USER.md' }, { name: 'MEMORY.md' }, { name: 'TOOLS.md' }];
  }

  if (files.length === 0) {
    container.innerHTML = '<div style="color:var(--text-faint);font-size:12px;padding:4px 2px;">No files found</div>';
    return;
  }

  container.innerHTML = '';
  for (const file of files) {
    const meta = friendlyFile(file.name);
    const chip = document.createElement('button');
    chip.className = 'hud-file-chip';
    chip.textContent = meta.label;
    chip.addEventListener('click', () => viewAgentFile(file.name, meta.label));
    container.appendChild(chip);
  }
}

async function viewAgentFile(filename, label) {
  const overlay = document.getElementById('file-viewer-overlay');
  const titleEl = document.getElementById('file-viewer-title');
  const body = document.getElementById('file-viewer-body');
  if (!overlay || !titleEl || !body) return;

  titleEl.textContent = label || friendlyFile(filename).label;
  body.innerHTML = '<div class="oc-file-viewer-loading"><div class="spinner" style="width:14px;height:14px;border-width:2px;"></div> Loading...</div>';
  overlay.classList.add('oc-open');

  if (!state.gateway?.connected) {
    body.innerHTML = '<p style="color:var(--text-faint);text-align:center;padding:30px;">Not connected.</p>';
    return;
  }

  try {
    const agentId = state.activeAgent?.id || 'main';
    const result = await state.gateway.request('agents.files.get', { agentId, name: filename });
    const content = result?.file?.content ?? '';

    body.innerHTML = '';

    if (content) {
      const contentDiv = document.createElement('div');
      contentDiv.innerHTML = formatMarkdown(content);
      body.appendChild(contentDiv);
    } else {
      const emptyDiv = document.createElement('p');
      emptyDiv.style.cssText = 'color:var(--text-faint);text-align:center;padding:20px;';
      emptyDiv.textContent = 'This file is empty.';
      body.appendChild(emptyDiv);
    }

    // Edit CTA at the bottom
    const editCta = document.createElement('div');
    editCta.className = 'oc-file-edit-cta';
    editCta.innerHTML = `
      <button class="oc-file-edit-btn" id="file-edit-btn">Edit in chat</button>
      <span class="oc-file-edit-hint">Your bot will help you make changes</span>
    `;
    body.appendChild(editCta);

    editCta.querySelector('#file-edit-btn').addEventListener('click', () => {
      overlay.classList.remove('oc-open');
      closeDashboard();
      const friendlyName = label || friendlyFile(filename).label;
      const input = document.getElementById('message-input');
      if (input) {
        input.value = `I want to update my ${friendlyName} (${filename}). `;
        input.focus();
        input.dispatchEvent(new Event('input'));
      }
    });

  } catch (err) {
    console.error('agents.files.get failed:', err);
    body.innerHTML = `<p style="color:var(--text-faint);text-align:center;padding:30px;">Failed to load: ${err.message || 'unknown error'}</p>`;
  }
}

// File viewer close handlers
(function initFileViewer() {
  document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('file-viewer-overlay');
    const closeBtn = document.getElementById('file-viewer-close');
    if (closeBtn) closeBtn.addEventListener('click', () => overlay?.classList.remove('oc-open'));
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('oc-open'); });
    restoreCollapsibleState();
  });
})();

// ─── Skills List ──────────────────────────────────────────────────

async function loadSkills() {
  const container = document.getElementById('hud-skills-list');
  if (!container || !state.gateway?.connected) return;

  try {
    const result = await state.gateway.request('skills.status', {});
    const skills = result?.skills || [];

    if (skills.length === 0) {
      container.innerHTML = '<div class="hud-empty-hint">No skills installed</div>';
      return;
    }

    container.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'hud-status-list';
    for (const skill of skills) {
      const item = document.createElement('div');
      item.className = 'hud-status-item';
      const name = skill.name || skill.id || 'Unknown';
      const enabled = skill.enabled !== false;
      item.innerHTML = `
        <span class="hud-status-item-name">${name}</span>
        <span class="hud-status-dot ${enabled ? 'on' : 'off'}"></span>
      `;
      list.appendChild(item);
    }
    container.appendChild(list);
  } catch (err) {
    console.warn('skills.status failed:', err);
    container.innerHTML = '<div class="hud-empty-hint">Could not load skills</div>';
  }
}

// ─── Channels List ────────────────────────────────────────────────

async function loadChannels() {
  const container = document.getElementById('hud-channels-list');
  if (!container || !state.gateway?.connected) return;

  try {
    const result = await state.gateway.request('channels.status', {});
    const channels = result?.channels || result || {};

    const entries = Object.entries(channels).filter(([, v]) => v && typeof v === 'object');
    if (entries.length === 0) {
      container.innerHTML = '<div class="hud-empty-hint">No channels configured</div>';
      return;
    }

    container.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'hud-status-list';
    for (const [key, ch] of entries) {
      const item = document.createElement('div');
      item.className = 'hud-status-item';
      const name = ch.label || ch.name || key;
      const connected = ch.connected || ch.status === 'connected' || ch.status === 'ok';
      const configured = ch.configured !== false;
      item.innerHTML = `
        <span class="hud-status-item-name">${name}</span>
        <span class="hud-status-dot ${connected ? 'on' : configured ? 'warn' : 'off'}"></span>
      `;
      list.appendChild(item);
    }
    container.appendChild(list);
  } catch (err) {
    console.warn('channels.status failed:', err);
    container.innerHTML = '<div class="hud-empty-hint">Could not load channels</div>';
  }
}

// ─── Cron Jobs List ───────────────────────────────────────────────

// ─── Agent Switcher ───────────────────────────────────────────────

// ─── Agent dropdown (in identity section) ─────────────────────────

let agentDropdownOpen = false;

function toggleAgentDropdown2() {
  const dd = document.getElementById('hud-agent-dropdown');
  if (!dd) return;
  agentDropdownOpen = !agentDropdownOpen;
  dd.classList.toggle('open', agentDropdownOpen);
  if (agentDropdownOpen) {
    // Position dropdown as fixed to escape overflow:hidden parents
    const identity = document.getElementById('hud-identity');
    if (identity) {
      const rect = identity.getBoundingClientRect();
      dd.style.position = 'fixed';
      dd.style.top = (rect.bottom + 4) + 'px';
      dd.style.left = rect.left + 'px';
      dd.style.width = rect.width + 'px';
      dd.style.transform = 'none';
    }
    loadAgentDropdown();
  }
}

function closeAgentDropdown() {
  const dd = document.getElementById('hud-agent-dropdown');
  if (dd) dd.classList.remove('open');
  agentDropdownOpen = false;
}

// Click identity section to toggle
document.getElementById('hud-identity')?.addEventListener('click', (e) => {
  // Don't trigger on disconnect link
  if (e.target.closest('.hud-disconnect-link')) return;
  e.stopPropagation();
  toggleAgentDropdown2();
});

// Close on outside click
document.addEventListener('click', () => closeAgentDropdown());

async function loadAgentDropdown() {
  const container = document.getElementById('hud-agent-dropdown');
  if (!container || !state.gateway?.connected) return;

  try {
    const result = await state.gateway.request('agents.list', {});
    const agents = result?.agents || [];
    container.innerHTML = '';

    for (const agent of agents) {
      const isActive = agent.id === (state.activeAgent?.id || result?.defaultId);
      const btn = document.createElement('button');
      btn.className = 'hud-agent-dropdown-item' + (isActive ? ' active' : '');
      btn.innerHTML = `<span class="agent-dot"></span><span>${agent.identity?.emoji || '🤖'} ${agent.identity?.name || agent.id}</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAgentDropdown();
        if (!isActive) {
          // Map agents.list format to switchAgent format
          switchAgent({
            id: agent.id,
            name: agent.identity?.name || agent.id,
            emoji: agent.identity?.emoji || '🤖',
            creature: agent.identity?.creature || '',
          });
        }
      });
      container.appendChild(btn);
    }

    // Separator
    const sep = document.createElement('div');
    sep.className = 'hud-agent-dropdown-sep';
    container.appendChild(sep);

    // Create new agent
    const addBtn = document.createElement('button');
    addBtn.className = 'hud-agent-dropdown-add';
    addBtn.innerHTML = '<span class="add-icon">+</span><span>New agent</span>';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAgentDropdown();
      closeDashboard();
      const input = document.getElementById('message-input');
      if (input) {
        input.value = 'I want to create a new agent. Walk me through the setup.';
        input.focus();
        input.dispatchEvent(new Event('input'));
      }
    });
    container.appendChild(addBtn);
  } catch (err) {
    console.warn('agents.list failed:', err);
  }
}

// Compat: old call sites reference loadAgentSwitcher
async function loadAgentSwitcher() { /* replaced by dropdown */ }

function cronTimeAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function cronTimeUntil(ms) {
  if (!ms) return '';
  const diff = ms - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 3600000) return 'in ' + Math.floor(diff / 60000) + 'm';
  if (diff < 86400000) return 'in ' + Math.floor(diff / 3600000) + 'h';
  return 'in ' + Math.floor(diff / 86400000) + 'd';
}

async function cronRunNow(jobId, btn) {
  if (!state.gateway?.connected) return;
  btn.disabled = true;
  btn.textContent = '...';
  try {
    await state.gateway.request('cron.run', { id: jobId });
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '▶'; btn.disabled = false; loadCronJobs(); }, 3000);
  } catch (err) {
    btn.textContent = '✗';
    setTimeout(() => { btn.textContent = '▶'; btn.disabled = false; }, 2000);
  }
}

function cronFriendlyName(name) {
  return (name || 'unnamed').replace(/-/g, ' ');
}

function humanizeEvery(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return 'every ' + mins + 'm';
  const hrs = Math.round(mins / 60);
  if (hrs === 1) return 'every hour';
  return 'every ' + hrs + 'h';
}

function humanizeCron(expr) {
  if (!expr) return '';
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Format time
  let timeStr = '';
  if (hour !== '*' && min !== '*') {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    timeStr = h12 + (m > 0 ? ':' + String(m).padStart(2, '0') : '') + ampm;
  }

  // Specific days of week
  if (dow !== '*' && dom === '*' && mon === '*') {
    const dayList = dow.split(',').map(d => DAYS[parseInt(d, 10)] || d).join(', ');
    return timeStr ? dayList + ' at ' + timeStr : dayList;
  }

  // Daily
  if (dom === '*' && mon === '*' && dow === '*') {
    if (timeStr) return 'daily at ' + timeStr;
    if (hour === '*' && min !== '*') return 'every hour at :' + String(parseInt(min, 10)).padStart(2, '0');
    return 'daily';
  }

  // Specific intervals in hour field like */4
  if (hour.startsWith('*/')) {
    const interval = parseInt(hour.slice(2), 10);
    return 'every ' + interval + 'h';
  }

  // Comma-separated hours (e.g. "0 1,5,9,13,17,21 * * *")
  if (hour.includes(',') && dom === '*' && mon === '*' && dow === '*') {
    const hours = hour.split(',');
    return hours.length + 'x daily' + (timeStr ? '' : '');
  }

  // Fallback: return something readable if we have time
  if (timeStr) return 'at ' + timeStr;
  return expr;
}

async function loadCronJobs() {
  const container = document.getElementById('hud-cron-list');
  if (!container || !state.gateway?.connected) return;

  try {
    const result = await state.gateway.request('cron.list', {});
    const jobs = result?.jobs || result || [];

    if (!Array.isArray(jobs) || jobs.length === 0) {
      container.innerHTML = '';
      return;
    }

    // Filter by active agent: show jobs pinned to this agent, or global jobs (no agentId) when default agent is active
    const activeId = state.activeAgent?.id || 'main';
    const isDefaultAgent = state.agents.length === 0 || state.agents[0]?.id === activeId;
    const filtered = jobs.filter(job => {
      if (job.agentId) return job.agentId === activeId;
      // Jobs without agentId belong to the default agent
      return isDefaultAgent;
    });

    if (filtered.length === 0) {
      container.innerHTML = '';
      return;
    }

    // Sort by next run
    const sorted = [...filtered].sort((a, b) => (a.state?.nextRunAtMs || Infinity) - (b.state?.nextRunAtMs || Infinity));

    container.innerHTML = '';
    for (const job of sorted) {
      const item = document.createElement('div');
      item.className = 'hud-tl-item';
      const lastStatus = job.state?.lastRunStatus || job.state?.lastStatus;
      const next = cronTimeUntil(job.state?.nextRunAtMs);
      const lastRan = cronTimeAgo(job.state?.lastRunAtMs);
      const schedule = job.schedule?.kind === 'every'
        ? humanizeEvery(job.schedule.everyMs || 0)
        : job.schedule?.kind === 'cron'
          ? humanizeCron(job.schedule.expr || '')
          : '';

      const statusDot = lastStatus === 'error'
        ? '<span class="hud-tl-dot hud-tl-dot-err"></span>'
        : '<span class="hud-tl-dot hud-tl-dot-ok"></span>';

      item.innerHTML = `
        ${statusDot}
        <div class="hud-tl-body">
          <span class="hud-tl-name">${cronFriendlyName(job.name)}</span>
          <span class="hud-tl-when">${next}</span>
        </div>
        <button class="hud-tl-run" title="Run now" onclick="cronRunNow('${job.id}', this)">▶</button>
      `;

      // Click to show task detail popup
      item.querySelector('.hud-tl-body').addEventListener('click', () => {
        showTaskDetail(job, { schedule, lastRan, lastStatus });
      });
      container.appendChild(item);
    }
  } catch (err) {
    console.warn('cron.list failed:', err);
    container.innerHTML = '';
  }
}

function showTaskDetail(job, info) {
  const existing = document.getElementById('task-detail-overlay');
  if (existing) existing.remove();

  const name = cronFriendlyName(job.name);
  const desc = job.description || '';
  const model = (job.payload?.model || job.model || 'default').split('/').pop();
  const enabled = job.enabled !== false;
  const prompt = job.payload?.message || job.task || job.prompt || '';
  const promptPreview = prompt.length > 400 ? prompt.slice(0, 400) + '…' : prompt;

  // Delivery info
  const deliveryMode = job.delivery?.mode || 'none';
  const deliveryChannel = job.delivery?.channel || '';
  let deliverStr = '';
  if (deliveryMode !== 'none' && deliveryChannel) {
    deliverStr = deliveryChannel;
    if (job.delivery?.to) deliverStr += ' → ' + job.delivery.to;
  }

  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const overlay = document.createElement('div');
  overlay.id = 'task-detail-overlay';
  overlay.className = 'oc-task-overlay';
  overlay.innerHTML = `
    <div class="oc-task-panel">
      <div class="oc-task-header">
        <span class="oc-task-title">${esc(name)}</span>
        <button class="oc-task-close" id="task-close-btn">&times;</button>
      </div>
      <div class="oc-task-body">
        ${desc ? `<div class="oc-task-desc">${esc(desc)}</div>` : ''}
        <div class="oc-task-row">
          <span class="oc-task-label">Status</span>
          <span class="oc-task-value">${enabled ? '<span style="color:var(--accent)">active</span>' : '<span style="color:var(--text-faint)">paused</span>'}</span>
        </div>
        <div class="oc-task-row">
          <span class="oc-task-label">Schedule</span>
          <span class="oc-task-value">${info.schedule || '—'}</span>
        </div>
        <div class="oc-task-row">
          <span class="oc-task-label">Last run</span>
          <span class="oc-task-value">${info.lastRan ? info.lastRan + (info.lastStatus === 'error' ? ' <span style="color:#ef4444">failed</span>' : ' <span style="color:var(--accent)">ok</span>') : 'never'}</span>
        </div>
        <div class="oc-task-row">
          <span class="oc-task-label">Model</span>
          <span class="oc-task-value">${esc(model)}</span>
        </div>
        ${deliverStr ? `<div class="oc-task-row"><span class="oc-task-label">Delivers to</span><span class="oc-task-value">${esc(deliverStr)}</span></div>` : ''}
        ${promptPreview ? `<div class="oc-task-prompt-section"><span class="oc-task-label">Prompt</span><div class="oc-task-prompt">${esc(promptPreview)}</div></div>` : ''}
      </div>
      <div class="oc-task-footer">
        <button class="oc-task-action" onclick="cronRunNow('${job.id}', this); document.getElementById('task-detail-overlay')?.remove();">▶ Run now</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('task-close-btn').addEventListener('click', () => overlay.remove());
}

// ─── Settings ─────────────────────────────────────────────────────

const DEFAULT_OPTIONS = {
  thinking: ["not set", "off", "low", "medium", "high"],
  verbose: ["not set", "off", "on", "full"],
};

function updateDefaultsPanel() {
  const el = document.getElementById("hud-defaults-panel");
  const section = document.getElementById("hud-defaults-section");
  if (!el) return;
  const d = state.defaults;
  // Hide defaults subsection when no model info available
  if (section) section.style.display = d.model ? "" : "none";
  if (!d.model) return;
  
  const pendingModel = state.pendingDefaults.model;
  const modelDisplay = shortModelName(pendingModel || d.model);
  const modelPending = pendingModel && pendingModel !== d.model;
  
  function renderSelect(key, label) {
    const isPending = key in state.pendingDefaults;
    const current = isPending ? (state.pendingDefaults[key] || "") : (d[key] || "");
    const options = DEFAULT_OPTIONS[key];
    const optionsHtml = options.map(opt => {
      const val = opt === "not set" ? "" : opt;
      const selected = val === current ? ' selected' : '';
      return '<option value="' + val + '"' + selected + '>' + opt + '</option>';
    }).join('');
    const cls = isPending ? ' hud-defaults-pending' : '';
    return '<div class="hud-defaults-row">' +
      '<span class="hud-defaults-label">' + label + '</span>' +
      '<select class="hud-defaults-select' + cls + '" data-default-key="' + key + '">' + optionsHtml + '</select>' +
    '</div>';
  }
  
  let html =
    '<div class="hud-defaults-row">' +
      '<span class="hud-defaults-label">Model</span>' +
      '<span class="hud-defaults-value hud-defaults-editable' + (modelPending ? ' hud-defaults-pending' : '') + '" id="hud-default-model">' + modelDisplay + '</span>' +
    '</div>' +
    renderSelect("thinking", "Think") +
    renderSelect("verbose", "Verbose");
  
  if (hasPendingDefaults()) {
    html += '<button class="hud-defaults-apply" id="hud-defaults-apply" onclick="applyPendingDefaults()">restart to apply</button>';
  }
  
  el.innerHTML = html;
  
  // Wire up model click
  document.getElementById("hud-default-model")?.addEventListener("click", () => {
    openModelPicker({
      current: state.pendingDefaults.model || d.model,
      onSelect: (fullId, modal) => {
        if (fullId === d.model) {
          delete state.pendingDefaults.model;
        } else {
          state.pendingDefaults.model = fullId;
        }
        updateDefaultsPanel();
        modal.remove();
      }
    });
  });
  
  // Wire up select pickers
  el.querySelectorAll('.hud-defaults-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const key = sel.dataset.defaultKey;
      const val = sel.value;
  
      if (val === (state.defaults[key] || "")) {
        delete state.pendingDefaults[key];
      } else {
        state.pendingDefaults[key] = val;
      }
      updateDefaultsPanel();
      updateBarControls();
    });
  });
}

function hasPendingDefaults() {
  return Object.keys(state.pendingDefaults).length > 0;
}

async function applyPendingDefaults() {
  if (!hasPendingDefaults() || !state.gateway?.connected) return;
  
  // Only thinkingDefault and verboseDefault exist in config (reasoning has no default)
  const configKeys = {
    thinking: "thinkingDefault",
    verbose: "verboseDefault",
  };
  
  const applyBtn = document.getElementById("hud-defaults-apply");
  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = "applying...";
  }
  
  try {
    const getResult = await state.gateway.request("config.get", {});
    const hash = getResult?.hash || "";
    
    const patch = {};
    for (const [key, val] of Object.entries(state.pendingDefaults)) {
      if (configKeys[key]) patch[configKeys[key]] = val || null;
    }
    // Handle model change
    if (state.pendingDefaults.model) {
      patch.model = { primary: state.pendingDefaults.model };
    }
    
    const raw = JSON.stringify({ agents: { defaults: patch } });
    await state.gateway.request("config.patch", { raw, baseHash: hash });
    
    // Update local state
    for (const [key, val] of Object.entries(state.pendingDefaults)) {
      state.defaults[key] = val;
    }
    // Clear pending
    for (const key in state.pendingDefaults) delete state.pendingDefaults[key];
    
    updateDefaultsPanel();
    updateBarControls();
  } catch (err) {
    console.warn("Failed to apply defaults:", err);
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = "restart to apply";
    }
  }
}

function loadDashSettings() {
  const settings = JSON.parse(localStorage.getItem('dashSettings') || '{}');

  // Theme
  applyDashSettings(settings);

  // STT (Speech-to-Text)
  const sttToggle = document.getElementById('dash-stt-toggle');
  if (sttToggle) {
    sttToggle.checked = !!settings.voiceInput;
    const sttConfig = document.getElementById('dash-stt-config');
    if (sttConfig) sttConfig.style.display = settings.voiceInput ? '' : 'none';
  }

  const keyInput = document.getElementById('dash-openai-key');
  if (keyInput) keyInput.value = settings.openaiKey || '';
  
  loadTTSSettings();
}

function loadTTSSettings() {
  const tts = state.ttsConfig || {};
  const mode = tts.auto || 'off';
  const provider = tts.provider || 'edge';
  
  document.querySelectorAll('#dash-tts-modes .hud-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.tts === mode);
  });
  
  const ttsConfig = document.getElementById('dash-tts-config');
  if (ttsConfig) ttsConfig.style.display = (mode !== 'off') ? '' : 'none';
  
  document.querySelectorAll('#dash-tts-providers .hud-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.provider === provider);
  });
  
  updateTTSProviderUI(provider);
  updateTTSApplyBtn();
}

function updateTTSProviderUI(provider) {
  const ttsKeyRow = document.getElementById('dash-tts-key-row');
  const ttsKey = document.getElementById('dash-tts-key');
  
  if (provider === 'edge') {
    if (ttsKeyRow) ttsKeyRow.style.display = 'none';
  } else {
    if (ttsKeyRow) ttsKeyRow.style.display = '';
    const tts = state.ttsConfig || {};
    const savedKey = provider === 'openai' ? (tts.openaiKey || '') : (tts.elevenlabsKey || '');
    if (ttsKey) {
      ttsKey.value = savedKey;
      ttsKey.placeholder = (provider === 'openai' ? 'OpenAI' : 'ElevenLabs') + ' API key';
    }
  }
}

// Track pending TTS changes
const pendingTTS = {};

function markTTSPending(key, val) {
  const tts = state.ttsConfig || {};
  const original = key === 'auto' ? (tts.auto || 'off') :
                   key === 'provider' ? (tts.provider || 'edge') : '';
  if (val === original) { delete pendingTTS[key]; } 
  else { pendingTTS[key] = val; }
  updateTTSApplyBtn();
}

function updateTTSApplyBtn() {
  const btn = document.getElementById('dash-tts-apply');
  if (!btn) return;
  const hasPending = Object.keys(pendingTTS).length > 0;
  btn.style.display = hasPending ? '' : 'none';
}

async function applyTTSConfig() {
  if (!state.gateway?.connected) return;
  const btn = document.getElementById('dash-tts-apply');
  if (btn) { btn.disabled = true; btn.textContent = 'applying...'; }
  
  try {
    const getResult = await state.gateway.request("config.get", {});
    const hash = getResult?.hash || "";
    
    const patch = {};
    if ('auto' in pendingTTS) patch.auto = pendingTTS.auto;
    if ('provider' in pendingTTS) patch.provider = pendingTTS.provider;
    
    // Also save API key if provider is not edge and key is entered
    const provider = pendingTTS.provider || state.ttsConfig?.provider || 'edge';
    const keyVal = document.getElementById('dash-tts-key')?.value || '';
    if (provider !== 'edge' && keyVal && !keyVal.startsWith('•')) {
      if (provider === 'openai') patch.openai = { apiKey: keyVal };
      else if (provider === 'elevenlabs') patch.elevenlabs = { apiKey: keyVal };
    }
    
    const raw = JSON.stringify({ messages: { tts: patch } });
    await state.gateway.request("config.patch", { raw, baseHash: hash });
    
    // Update local state
    if ('auto' in pendingTTS) state.ttsConfig.auto = pendingTTS.auto;
    if ('provider' in pendingTTS) state.ttsConfig.provider = pendingTTS.provider;
    
    for (const k in pendingTTS) delete pendingTTS[k];
    updateTTSApplyBtn();
  } catch (err) {
    console.warn("Failed to apply TTS config:", err);
    if (btn) { btn.disabled = false; btn.textContent = 'restart to apply'; }
  }
}

function saveDashSettings() {
  const settings = {
    darkMode: !document.documentElement.getAttribute('data-theme'),
    voiceInput: document.getElementById('dash-stt-toggle')?.checked || false,
    openaiKey: document.getElementById('dash-openai-key')?.value || '',
  };
  localStorage.setItem('dashSettings', JSON.stringify(settings));
  
  // Save STT key to localStorage for Whisper
  if (settings.voiceInput && settings.openaiKey) {
    localStorage.setItem('openclaw-stt-key', settings.openaiKey);
  } else if (!settings.voiceInput) {
    localStorage.removeItem('openclaw-stt-key');
  }
  
  applyDashSettings(settings);
}

function selectTTSMode(mode) {
  document.querySelectorAll('#dash-tts-modes .hud-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.tts === mode);
  });
  const ttsConfig = document.getElementById('dash-tts-config');
  if (ttsConfig) ttsConfig.style.display = (mode !== 'off') ? '' : 'none';
  markTTSPending('auto', mode);
}

function selectTTSProvider(provider) {
  document.querySelectorAll('#dash-tts-providers .hud-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.provider === provider);
  });
  updateTTSProviderUI(provider);
  markTTSPending('provider', provider);
}

function onTTSKeyChange() {
  // Key change means there's something to apply
  markTTSPending('apiKey', document.getElementById('dash-tts-key')?.value || '');
}

function setTextSize(size) {
  document.body.classList.remove('text-small', 'text-large');
  if (size === 'small') document.body.classList.add('text-small');
  else if (size === 'large') document.body.classList.add('text-large');
  // Update chips
  document.querySelectorAll('#dash-text-size .hud-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.textsize === size);
  });
  // Save
  const settings = JSON.parse(localStorage.getItem('dashSettings') || '{}');
  settings.textSize = size;
  localStorage.setItem('dashSettings', JSON.stringify(settings));
}

function setTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  document.getElementById('dash-theme-dark')?.classList.toggle('active', theme !== 'light');
  document.getElementById('dash-theme-light')?.classList.toggle('active', theme === 'light');
  const settings = JSON.parse(localStorage.getItem('dashSettings') || '{}');
  settings.darkMode = theme !== 'light';
  localStorage.setItem('dashSettings', JSON.stringify(settings));
}

function applyDashSettings(settings) {
  if (settings.darkMode === false) {
    document.documentElement.setAttribute('data-theme', 'light');
    document.getElementById('dash-theme-dark')?.classList.remove('active');
    document.getElementById('dash-theme-light')?.classList.add('active');
  } else {
    document.documentElement.removeAttribute('data-theme');
    document.getElementById('dash-theme-dark')?.classList.add('active');
    document.getElementById('dash-theme-light')?.classList.remove('active');
  }
  // Restore text size
  if (settings.textSize) {
    setTextSize(settings.textSize);
  }
}

// ─── Export Session ───────────────────────────────────────────────

function exportCurrentSession() {
  const sk = state.sessionKey || "main";
  const messages = state.messages || [];
  if (messages.length === 0) {
    alert("Nothing to export — this session is empty.");
    return;
  }

  const tab = state.tabSessions.find(t => t.key === sk);
  const label = tab?.label || sk;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const readableDate = now.toLocaleString();

  // Build clean HTML
  const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let msgHtml = '';
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'You' : 'Assistant';
    const cls = msg.role === 'user' ? 'user' : 'assistant';
    const text = esc(msg.text).replace(/\n/g, '<br>');
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
    msgHtml += `<div class="msg ${cls}"><div class="msg-header"><strong>${role}</strong><span class="time">${time}</span></div><div class="msg-body">${text}</div></div>\n`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(label)} — Session Export</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fff; color: #1a1a1a; padding: 24px; line-height: 1.6; }
  .header { max-width: 720px; margin: 0 auto 24px; padding-bottom: 16px; border-bottom: 1px solid #e0e0e0; }
  .header h1 { font-size: 18px; font-weight: 500; color: #1a1a1a; }
  .header p { font-size: 12px; color: #888; margin-top: 4px; }
  .messages { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
  .msg { padding: 12px 16px; border-radius: 10px; }
  .msg.user { background: #f5f5f5; border: 1px solid #e8e8e8; }
  .msg.assistant { background: transparent; }
  .msg-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .msg-header strong { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #888; }
  .time { font-size: 11px; color: #aaa; }
  .msg-body { font-size: 14px; white-space: pre-wrap; word-break: break-word; }
  .msg.user .msg-body { color: #1a1a1a; }
  .msg.assistant .msg-body { color: #333; }
  .footer { max-width: 720px; margin: 24px auto 0; padding-top: 16px; border-top: 1px solid #e0e0e0; text-align: center; font-size: 11px; color: #aaa; }
  @media print { body { padding: 0; } .msg { break-inside: avoid; } }
</style>
</head>
<body>
<div class="header">
  <h1>${esc(label)}</h1>
  <p>Exported ${esc(readableDate)} · ${messages.length} messages</p>
</div>
<div class="messages">
${msgHtml}
</div>
<div class="footer">Exported from usemyclaw.com</div>
</body>
</html>`;

  // Trigger download
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${label.replace(/[^a-zA-Z0-9-_ ]/g, '')}-${dateStr}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Sub-agents Panel ────────────────────────────────────────────

function updateSubagentsPanel() {
  const container = document.getElementById("hud-subagents-list");
  if (!container) return;
  if (!container.innerHTML.trim()) {
    container.innerHTML = '<div class="hud-empty-hint hud-searching">checking…</div>';
  }
}

async function loadSubagents() {
  const container = document.getElementById("hud-subagents-list");
  if (!container || !state.gateway?.connected) return;
  
  // Show searching state
  const current = container.querySelector('.hud-subagent-row');
  if (!current) container.innerHTML = '<div class="hud-empty-hint hud-searching">checking…</div>';
  
  try {
    const result = await state.gateway.request("sessions.list", {});
    const sessions = result?.sessions || [];
    const prefix = agentPrefix();
    const subs = sessions.filter(s => s.key.startsWith(prefix) && s.key.includes(":subagent:"));
    
    if (subs.length === 0) {
      container.innerHTML = '<div class="hud-empty-hint">none running</div>';
      return;
    }
    container.innerHTML = "";
    
    for (const sub of subs) {
      const id = sub.key.split(":subagent:")[1] || sub.key;
      const shortId = id.length > 8 ? id.slice(0, 8) : id;
      const isActive = sub.active || sub.running || false;
      const tokens = sub.totalTokens || 0;
      const tokStr = tokens > 1000 ? Math.round(tokens / 1000) + "k" : tokens + "";
      
      const row = document.createElement("div");
      row.className = "hud-subagent-row";
      row.innerHTML =
        '<span class="hud-status-dot ' + (isActive ? 'on' : 'off') + '"></span>' +
        '<span class="hud-subagent-id">' + shortId + '</span>' +
        '<span class="hud-subagent-tokens">' + tokStr + ' tok</span>' +
        '<button class="hud-subagent-kill" title="Kill sub-agent" onclick="killSubagent(\'' + id.replace(/'/g, "\\'") + '\')">✕</button>';
      container.appendChild(row);
    }
  } catch (err) {
    console.warn("Failed to load subagents:", err);
  }
}

function killSubagent(id) {
  sendControlAction('/kill ' + id);
  // Refresh after a short delay
  setTimeout(() => loadSubagents(), 2000);
}

// ─── Dock / Channel Switcher ─────────────────────────────────────

async function loadAvailableChannels() {
  if (!state.gateway?.connected) return;
  try {
    const result = await state.gateway.request("channels.status", {});
    const channels = result?.channels || result || {};
    const entries = Object.entries(channels).filter(([, v]) => v && typeof v === "object");
    const connected = entries
      .filter(([, ch]) => ch.connected || ch.status === "connected" || ch.status === "ok")
      .map(([key]) => key);
    state.availableChannels = connected;
    updateDockChip();
  } catch (err) {
    console.warn("Failed to load channels for dock:", err);
  }
}

function updateDockChip() {
  const el = document.getElementById("bar-dock");
  const sep = document.getElementById("bar-dock-sep");
  if (!el || !sep) return;
  
  // Only show dock if there are other channels available
  if (state.availableChannels.length === 0) {
    el.style.display = "none";
    sep.style.display = "none";
    return;
  }
  
  el.style.display = "";
  sep.style.display = "";
  const current = state.dockChannel || "here";
  el.textContent = "reply: " + current;
  el.classList.toggle("active", !!state.dockChannel);
}

document.addEventListener("DOMContentLoaded", () => {
  const dockEl = document.getElementById("bar-dock");
  if (dockEl) {
    dockEl.addEventListener("click", () => {
      if (state.availableChannels.length === 0) return;
      
      // Cycle: here → channel1 → channel2 → ... → here
      const options = ["", ...state.availableChannels];
      const currentIdx = options.indexOf(state.dockChannel);
      const nextIdx = (currentIdx + 1) % options.length;
      const next = options[nextIdx];
      
      if (next) {
        // Dock to that channel
        state.dockChannel = next;
        // Send dock command silently
        if (state.gateway?.connected) {
          const input = document.getElementById("message-input");
          if (input) {
            input.value = "/dock-" + next;
            input.dispatchEvent(new Event("input"));
            document.getElementById("send-btn")?.click();
          }
        }
      } else {
        // Back to "here" - no undock command exists, so we just track locally
        state.dockChannel = "";
      }
      updateDockChip();
    });
  }
});

function sendControlAction(message) {
  // Close dashboard on mobile
  closeDashboard();

  // Send the message as if user typed it
  const input = document.getElementById('message-input');
  if (input) {
    input.value = message;
    input.dispatchEvent(new Event('input'));
    document.getElementById('send-btn')?.click();
  }
}

function openTerminalPanel() {
  const panel = document.getElementById('terminal-panel');
  if (!panel) return;
  // Open the terminal section if not already open
  if (!panel.classList.contains('hud-open')) {
    const toggle = panel.querySelector('.hud-section-toggle');
    if (toggle) toggle.click();
  }
  // Expand to medium view for usability
  if (!panel.classList.contains('hud-expanded') && !panel.classList.contains('hud-fullscreen')) {
    const expandBtn = document.getElementById('terminal-expand-btn');
    if (expandBtn) expandBtn.click();
  }
}

function openTerminalWithCmd(cmd) {
  // Open terminal panel expanded, then the user can run the command
  // (We can't inject into the ttyd iframe due to cross-origin, but we can
  // open it and send the command through the agent instead)
  openTerminalPanel();
  sendControlAction('Run this command and show me the output: ' + cmd);
}

function openDashboard() {
  document.getElementById('dashboard')?.classList.add('open');
  document.getElementById('dashboard-overlay')?.classList.add('open');
}

function closeDashboard() {
  document.getElementById('dashboard')?.classList.remove('open');
  document.getElementById('dashboard-overlay')?.classList.remove('open');
}

// Dashboard event listeners (runs immediately)
(function initDashboard() {
  // Mobile menu button (desktop)
  document.getElementById('dash-menu-btn')?.addEventListener('click', () => {
    const dash = document.getElementById('dashboard');
    if (dash?.classList.contains('open')) closeDashboard();
    else openDashboard();
  });

  // Mobile hamburger bar dashboard button
  document.getElementById('hamburger-dash-btn')?.addEventListener('click', () => {
    const dash = document.getElementById('dashboard');
    if (dash?.classList.contains('open')) closeDashboard();
    else openDashboard();
  });

  // Overlay click to close
  document.getElementById('dashboard-overlay')?.addEventListener('click', closeDashboard);

  // Connect button
  document.getElementById('dash-connect-btn')?.addEventListener('click', () => {
    const url = document.getElementById('dash-gateway-url')?.value.trim();
    const token = document.getElementById('dash-token')?.value.trim();
    if (!url || !token) return;
    state.gatewayUrl = url;
    state.token = token;
    localStorage.setItem('connection', JSON.stringify({ gatewayUrl: url, token: token }));
    connectToGateway().catch(err => console.error('Connect failed:', err));
    updateDashboard();
  });

  // Disconnect button
  document.getElementById('dash-disconnect-btn')?.addEventListener('click', async () => {
    const ok = await confirmClose('Disconnect?', 'This will unpair your device. You\'ll need to re-enter your gateway URL and token to reconnect.');
    if (!ok) return;
    if (state.gateway) state.gateway.stop();
    localStorage.removeItem('connection');
    localStorage.removeItem('deviceIdentity');
    localStorage.removeItem('deviceApproved');
    state.gatewayUrl = '';
    state.token = '';
    document.getElementById('landing').style.display = '';
    document.querySelector('.app').style.display = 'none';
  });

  // Settings change listeners
  // STT toggle
  document.getElementById('dash-stt-toggle')?.addEventListener('change', () => {
    const sttConfig = document.getElementById('dash-stt-config');
    const checked = document.getElementById('dash-stt-toggle')?.checked;
    if (sttConfig) sttConfig.style.display = checked ? '' : 'none';
    saveDashSettings();
  });
  document.getElementById('dash-openai-key')?.addEventListener('change', saveDashSettings);
  
  // TTS mode chips
  document.querySelectorAll('#dash-tts-modes .hud-chip').forEach(chip => {
    chip.addEventListener('click', () => selectTTSMode(chip.dataset.tts));
  });
  // TTS provider chips
  document.querySelectorAll('#dash-tts-providers .hud-chip').forEach(chip => {
    chip.addEventListener('click', () => selectTTSProvider(chip.dataset.provider));
  });
  document.getElementById('dash-tts-key')?.addEventListener('input', onTTSKeyChange);

  // Apply saved settings on load
  const saved = JSON.parse(localStorage.getItem('dashSettings') || '{}');
  applyDashSettings(saved);

  // Responsive: show/hide menu button
  function updateDashLayout() {
    const isMobile = window.innerWidth <= 768;
    state.isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || isMobile;
    const menuBtn = document.getElementById('dash-menu-btn');
    const dashboard = document.getElementById('dashboard');
    if (menuBtn) menuBtn.style.display = isMobile ? '' : 'none';
    // On desktop, always show dashboard; on mobile, it's controlled by open/close
    if (!isMobile) {
      dashboard?.classList.remove('open');
      document.getElementById('dashboard-overlay')?.classList.remove('open');
    }
  }
  window.addEventListener('resize', updateDashLayout);
  updateDashLayout();
})();

// ─── Embed Panels (Browser + Terminal) ───────────────────────────────

(function initEmbedPanels() {
  const panels = {
    browser: {
      id: 'browser-panel',
      bodyId: 'browser-panel-body',
      headerId: 'browser-panel-header',
      dotId: 'browser-dot',
      expandId: 'browser-expand-btn',
      refreshId: 'browser-refresh-btn',
      closeId: 'browser-close-max-btn',
      storageKey: 'browserPanelOpen',
      iframe: null,
      getUrl() {
        try {
          const conn = JSON.parse(localStorage.getItem('connection') || '{}');
          const url = new URL(conn.gatewayUrl || '');
          return 'https://' + url.hostname + ':6080/embed.html';
        } catch { return null; }
      }
    },
    terminal: {
      id: 'terminal-panel',
      bodyId: 'terminal-panel-body',
      headerId: 'terminal-panel-header',
      dotId: 'terminal-dot',
      expandId: 'terminal-expand-btn',
      refreshId: 'terminal-refresh-btn',
      closeId: 'terminal-close-max-btn',
      storageKey: 'terminalPanelOpen',
      iframe: null,
      getUrl() {
        try {
          const conn = JSON.parse(localStorage.getItem('connection') || '{}');
          const url = new URL(conn.gatewayUrl || '');
          return 'https://' + url.hostname + ':7681';
        } catch { return null; }
      }
    },
  };

  const backdrop = document.getElementById('embed-backdrop');

  function getState(cfg) {
    const el = document.getElementById(cfg.id);
    if (!el) return 'closed';
    if (el.classList.contains('hud-fullscreen')) return 'full';
    if (el.classList.contains('hud-expanded')) return 'medium';
    if (el.classList.contains('hud-open')) return 'open';
    return 'closed';
  }

  function setState(cfg, state) {
    const el = document.getElementById(cfg.id);
    if (!el) return;
    el.classList.remove('hud-open', 'hud-expanded', 'hud-fullscreen');
    if (state !== 'closed') el.classList.add('hud-open');
    if (state === 'medium') el.classList.add('hud-expanded');
    if (state === 'full') el.classList.add('hud-fullscreen');
    updateExpandBtn(cfg);
    updateBackdrop();
  }

  function updateExpandBtn(cfg) {
    const btn = document.getElementById(cfg.expandId);
    if (!btn) return;
    const st = getState(cfg);
    if (st === 'full') { btn.textContent = '⤓'; btn.title = 'Minimize'; }
    else if (st === 'medium') { btn.textContent = '⛶'; btn.title = 'Full screen'; }
    else { btn.textContent = '⤢'; btn.title = 'Expand'; }
  }

  function updateBackdrop() {
    const anyExpanded = Object.values(panels).some(c =>
      getState(c) === 'medium' || getState(c) === 'full'
    );
    backdrop?.classList.toggle('visible', anyExpanded);
  }

  function updateDots(cfg, connected) {
    document.getElementById(cfg.dotId)?.classList.toggle('connected', connected);
  }

  // Preload iframes on connect — they load in the background so they're
  // instant when the user opens the panel. Iframes are never destroyed,
  // just hidden/shown via the section collapse.
  function preloadIframe(cfg) {
    if (cfg.iframe) return;
    const url = cfg.getUrl();
    if (!url) return;

    const body = document.getElementById(cfg.bodyId);
    if (!body) return;

    // Show loading spinner
    if (!body.querySelector('.hud-embed-loading')) {
      const el = document.createElement('div');
      el.className = 'hud-embed-loading';
      el.innerHTML = '<div class="hud-embed-spinner"></div><span class="hud-embed-loading-text">Connecting…</span>';
      body.appendChild(el);
    }

    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.opacity = '0';
    iframe.style.transition = 'opacity 0.3s';
    if (cfg === panels.browser) iframe.setAttribute('allow', 'clipboard-read; clipboard-write');

    let loaded = false;
    iframe.addEventListener('load', () => {
      loaded = true;
      cfg.ready = true;
      updateDots(cfg, true);
      const loader = body.querySelector('.hud-embed-loading');
      if (loader) { loader.style.opacity = '0'; loader.style.transition = 'opacity 0.3s'; setTimeout(() => loader.remove(), 300); }
      iframe.style.opacity = '1';
    });
    setTimeout(() => {
      if (!loaded) {
        updateDots(cfg, false);
        const txt = body.querySelector('.hud-embed-loading-text');
        if (txt) txt.textContent = 'Taking longer than usual…';
      }
    }, 8000);

    cfg.iframe = iframe;
    body.appendChild(iframe);
  }

  function preloadAll() {
    for (const cfg of Object.values(panels)) preloadIframe(cfg);
  }

  // Expose globally so dashboard init can trigger preload on connect
  window.preloadAllEmbeds = preloadAll;

  function toggle(cfg) {
    const st = getState(cfg);
    if (st === 'closed') {
      // Accordion: close all other sections first
      document.querySelectorAll('.hud-collapsible.hud-open').forEach(other => {
        if (other.id !== cfg.id) {
          other.classList.remove('hud-open');
        }
      });

      setState(cfg, 'open');
      if (!cfg.iframe) preloadIframe(cfg);
      const sectionMap = { 'browser-panel': 'agent-browser', 'terminal-panel': 'agent-terminal' };
      localStorage.setItem('openSection', sectionMap[cfg.id] || cfg.id);
    } else {
      setState(cfg, 'closed');
      localStorage.setItem('openSection', '');
    }
  }

  // Listen for accordion closes from toggleSection()
  const panelToSection = { 'browser-panel': 'agent-browser', 'terminal-panel': 'agent-terminal' };
  document.addEventListener('panel-close', (e) => {
    for (const cfg of Object.values(panels)) {
      if (e.detail === (panelToSection[cfg.id] || cfg.id)) {
        setState(cfg, 'closed');
      }
    }
  });

  function cycleExpand(cfg, e) {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    const st = getState(cfg);
    if (st === 'open') setState(cfg, 'medium');
    else if (st === 'medium') setState(cfg, 'full');
    else if (st === 'full') setState(cfg, 'open');
  }

  function closePanel(cfg, e) {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    setState(cfg, 'closed');
    destroyIframe(cfg);
    localStorage.setItem(cfg.storageKey, 'false');
  }

  function refresh(cfg, e) {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (cfg.iframe) { updateDots(cfg, false); cfg.iframe.src = cfg.iframe.src; }
  }

  // Wire up each panel
  for (const [key, cfg] of Object.entries(panels)) {
    // Header click = toggle section (uses existing toggleSection for open/close)
    document.getElementById(cfg.headerId)?.addEventListener('click', (e) => {
      if (e.target.closest('.hud-embed-action')) return;
      toggle(cfg);
    });
    document.getElementById(cfg.expandId)?.addEventListener('click', (e) => cycleExpand(cfg, e));
    document.getElementById(cfg.refreshId)?.addEventListener('click', (e) => refresh(cfg, e));
    document.getElementById(cfg.closeId)?.addEventListener('click', (e) => closePanel(cfg, e));
  }

  // Backdrop click = minimize to panel
  backdrop?.addEventListener('click', () => {
    for (const cfg of Object.values(panels)) {
      const st = getState(cfg);
      if (st === 'medium' || st === 'full') setState(cfg, 'open');
    }
  });

  // Escape = minimize expanded panels
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const cfg of Object.values(panels)) {
      const st = getState(cfg);
      if (st === 'full') { setState(cfg, 'medium'); return; }
      if (st === 'medium') { setState(cfg, 'open'); return; }
    }
  });

  // Iframes preloaded on connect — panel restore handled by restoreCollapsibleState()

  // ─── MindFeed Widget (always visible, above accordion) ──────────────

  const mfBody = document.getElementById('mindfeed-panel-body');
  const mfDot = document.getElementById('mindfeed-dot');
  const mfRefresh = document.getElementById('mindfeed-refresh-btn');
  const mfExpand = document.getElementById('mindfeed-expand-btn');
  let mfIframe = null;

  function mfGetUrl() {
    try {
      const conn = JSON.parse(localStorage.getItem('connection') || '{}');
      const url = new URL(conn.gatewayUrl || '');
      return 'https://' + url.hostname + ':8787';
    } catch { return null; }
  }

  function mfPreload() {
    if (mfIframe || !mfBody) return;
    const url = mfGetUrl();
    if (!url) return;

    if (!mfBody.querySelector('.hud-embed-loading')) {
      const el = document.createElement('div');
      el.className = 'hud-embed-loading';
      el.innerHTML = '<div class="hud-embed-spinner"></div><span class="hud-embed-loading-text">Connecting…</span>';
      mfBody.appendChild(el);
    }

    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.opacity = '0';
    iframe.style.transition = 'opacity 0.3s';

    let loaded = false;
    iframe.addEventListener('load', () => {
      loaded = true;
      mfDot?.classList.add('connected');
      const loader = mfBody.querySelector('.hud-embed-loading');
      if (loader) { loader.style.opacity = '0'; loader.style.transition = 'opacity 0.3s'; setTimeout(() => loader.remove(), 300); }
      iframe.style.opacity = '1';
    });
    setTimeout(() => {
      if (!loaded) {
        mfDot?.classList.remove('connected');
        const txt = mfBody.querySelector('.hud-embed-loading-text');
        if (txt) txt.textContent = 'Taking longer than usual…';
      }
    }, 8000);

    mfIframe = iframe;
    mfBody.appendChild(iframe);
  }

  const origPreloadAll = window.preloadAllEmbeds;
  window.preloadAllEmbeds = function() {
    origPreloadAll?.();
    mfPreload();
  };

  mfRefresh?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (mfIframe) { mfDot?.classList.remove('connected'); mfIframe.src = mfIframe.src; }
  });

  // Expand: open MindFeed as floating overlay
  mfExpand?.addEventListener('click', (e) => {
    e.stopPropagation();
    const widget = document.getElementById('mindfeed-widget');
    if (!widget) return;
    const isExpanded = widget.classList.contains('hud-mindfeed-expanded');
    if (isExpanded) {
      widget.classList.remove('hud-mindfeed-expanded');
      mfExpand.textContent = '⤢';
      mfExpand.title = 'Expand';
      backdrop?.classList.remove('visible');
    } else {
      widget.classList.add('hud-mindfeed-expanded');
      mfExpand.textContent = '⤓';
      mfExpand.title = 'Minimize';
      backdrop?.classList.add('visible');
    }
  });

  // Close button minimizes expanded mindfeed
  document.getElementById('mindfeed-close-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const widget = document.getElementById('mindfeed-widget');
    if (widget) widget.classList.remove('hud-mindfeed-expanded');
    if (mfExpand) { mfExpand.textContent = '⤢'; mfExpand.title = 'Expand'; }
    backdrop?.classList.remove('visible');
  });

  // Backdrop click minimizes expanded mindfeed too
  const origBackdropClick = backdrop?.onclick;
  backdrop?.addEventListener('click', () => {
    const widget = document.getElementById('mindfeed-widget');
    if (widget?.classList.contains('hud-mindfeed-expanded')) {
      widget.classList.remove('hud-mindfeed-expanded');
      if (mfExpand) { mfExpand.textContent = '⤢'; mfExpand.title = 'Expand'; }
    }
  });
})();

// ─── Initialize ──────────────────────────────────────────────────────

initApp();

if ("serviceWorker" in navigator && localStorage.getItem("connection")) {
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
    .then((reg) => {
      reg.update().catch(() => {});
      setInterval(() => reg.update().catch(() => {}), 60000);
    })
    .catch((err) => {
      console.error("Service worker registration failed:", err);
    });
}
