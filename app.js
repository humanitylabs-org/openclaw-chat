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

/** Generate a short tab title from conversation context */
function generateTabTitle(userText, assistantText) {
  // Try assistant response first — it's usually a better summary
  const title = titleFromAssistant(assistantText) || titleFromUser(userText);
  if (!title || title.length < 2) return null;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function cleanTextForTitle(text) {
  return (text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function capWords(text, maxWords, maxChars) {
  const words = text.split(/\s+/);
  let result = "";
  for (let i = 0; i < Math.min(words.length, maxWords); i++) {
    const next = result ? result + " " + words[i] : words[i];
    if (next.length > maxChars) break;
    result = next;
  }
  return result;
}

function titleFromAssistant(text) {
  if (!text) return null;
  const clean = cleanTextForTitle(text);
  if (!clean || clean.length < 5) return null;

  // If assistant starts with a greeting + topic, extract the topic part
  // e.g. "Hey! Here's the fix for the scroll issue" → "Scroll issue fix"
  // e.g. "Done. The deployment is live." → "Deployment live"
  // e.g. "I found 3 issues with..." → "3 issues with..."
  const sentences = clean.split(/[.!?\n]/).map(s => s.trim()).filter(s => s.length > 3);
  if (sentences.length === 0) return null;

  // Skip pure greetings as first sentence
  let sentence = sentences[0];
  if (/^(hey|hi|hello|sure|ok|okay|got it|alright|no problem|of course|absolutely)/i.test(sentence) && sentences.length > 1) {
    sentence = sentences[1];
  }

  // Strip leading filler
  sentence = sentence
    .replace(/^(here'?s?|i('ve| have)?|let me|i('ll| will)?|this is|that'?s?|the|so|well|basically|essentially)\s+/i, "")
    .replace(/^(a |an |the )/i, "")
    .trim();

  return capWords(sentence, 5, 30) || null;
}

function titleFromUser(text) {
  if (!text) return null;

  // Extract URL domain as fallback context
  const urlMatch = text.match(/https?:\/\/(?:www\.)?([^\/\s]+)/);
  const clean = cleanTextForTitle(text.replace(/https?:\/\/\S+/g, "")).trim();

  // If it's just a URL, use the domain
  if (!clean && urlMatch) {
    const domain = urlMatch[1].replace(/\.[^.]+$/, ""); // strip TLD
    return capWords(domain.replace(/[-_]/g, " "), 3, 25) || null;
  }

  // Handle questions — use the question itself
  const questionMatch = clean.match(/^(what|how|why|when|where|who|can|could|is|are|do|does|should|would|will)\s+(.+)/i);
  if (questionMatch) {
    const qBody = questionMatch[2].replace(/\?.*$/, "").trim();
    return capWords(qBody, 5, 30) || null;
  }

  // Handle imperative commands: "fix the scroll", "make it blue", "deploy to prod"
  const sentence = clean.split(/[.!?\n]/)[0].trim();
  const stripped = sentence
    .replace(/^(hey|hi|hello|please|can you|could you|i want to|i need to|i'd like to|let'?s|okay|ok)\s+/i, "")
    .replace(/^(a |an |the )/i, "")
    .trim();

  const result = capWords(stripped || sentence, 5, 30);
  // Add domain context if we have a URL
  if (result && urlMatch && result.length < 20) {
    const domain = urlMatch[1].replace(/\.[^.]+$/, "");
    const combined = result + " — " + domain;
    if (combined.length <= 30) return combined;
  }
  return result || null;
}

/** Auto-rename an "Untitled" tab — waits for assistant reply for better titles */
async function autoRenameTab(sessionKey, messageText) {
  if (sessionKey === "main") return;
  const tab = state.tabSessions.find(t => t.key === sessionKey);
  if (!tab || tab.label !== "Untitled") return;

  // Quick rename from user message first (instant feedback)
  const quickTitle = titleFromUser(messageText);
  if (quickTitle) {
    try {
      await state.gateway.request("sessions.patch", {
        key: `${agentPrefix()}${sessionKey}`,
        label: quickTitle,
      });
      tab.label = quickTitle;
      renderTabs();
    } catch { /* non-critical */ }
  }

  // Store user text so we can upgrade the title when assistant responds
  tab._pendingRenameUserText = messageText;
}

/** Upgrade tab title when assistant's first response arrives */
function upgradeTabTitle(sessionKey, assistantText) {
  const tab = state.tabSessions.find(t => t.key === sessionKey);
  if (!tab || !tab._pendingRenameUserText) return;
  const userText = tab._pendingRenameUserText;
  delete tab._pendingRenameUserText;

  const betterTitle = generateTabTitle(userText, assistantText);
  if (!betterTitle || betterTitle === tab.label) return;

  tab.label = betterTitle;
  renderTabs();
  state.gateway?.request("sessions.patch", {
    key: `${agentPrefix()}${sessionKey}`,
    label: betterTitle,
  }).catch(() => {});
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
    this.lastSeq = null;
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

    this.lastSeq = null;
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

      const seq = typeof msg.seq === "number" ? msg.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = this.lastSeq === null ? seq : Math.max(this.lastSeq, seq);
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

  // Agent/session defaults (from config)
  defaults: {
    model: "",
    fallbacks: [],
    thinking: "",
    reasoning: "",
    verbose: "",
    resetMode: "daily",
    resetAtHour: 4,
    resetIdleMinutes: 240,
    heartbeatEvery: "1h",
  },
  
  // Pending default changes (not yet applied to config)
  pendingDefaults: {},

  // Connection state for reconnect UX
  reconnecting: false,
  gatewayRestarting: false,
  
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

  // Unread tracking
  unreadCounts: {},  // { [sessionKey]: number }

  // Stream state (per-session)
  streams: new Map(),
  runToSession: new Map(),
  finalizedRuns: new Map(),
  historyInFlight: {}, // { [sessionKey]: boolean }
  historyPollTimer: null,
  historyPollSession: "",
  historyPollSettled: 0,
  streamEl: null,
  streamAssembler: null,
  gapRecoveryInFlight: false,

  // Attachments
  pendingAttachments: [],
  sending: false,
  processingQueue: false,

};

// ─── Agent prefix helper ─────────────────────────────────────────────

function agentPrefix() {
  return `agent:${state.activeAgent.id}:`;
}

// ─── Unread Tracking ─────────────────────────────────────────────────

/** Resolve an event's sessionKey to a tab key (e.g. "main", "tab-5"), or null if not a known tab */
function resolveTabKey(payloadSessionKey) {
  if (!payloadSessionKey) return null;
  const prefix = agentPrefix();
  const normalized = payloadSessionKey.startsWith(prefix)
    ? payloadSessionKey.slice(prefix.length)
    : payloadSessionKey;
  // Must be a known tab
  if (state.tabSessions.some(t => t.key === normalized)) return normalized;
  // Also check un-prefixed match
  for (const t of state.tabSessions) {
    if (payloadSessionKey === t.key || payloadSessionKey === `${prefix}${t.key}` || payloadSessionKey.endsWith(`:${t.key}`)) {
      return t.key;
    }
  }
  return null;
}

/** Increment unread count for a tab and update all UI indicators */
function markUnread(sessionKey) {
  if (!sessionKey || sessionKey === state.sessionKey) return; // active tab — don't mark
  state.unreadCounts[sessionKey] = (state.unreadCounts[sessionKey] || 0) + 1;
  updateUnreadBadges();
  updateDocumentTitle();
}

/** Clear unread count for a tab and update all UI indicators */
function clearUnread(sessionKey) {
  if (!state.unreadCounts[sessionKey]) return;
  delete state.unreadCounts[sessionKey];
  updateUnreadBadges();
  updateDocumentTitle();
}

/** Total unread across all tabs */
function totalUnread() {
  let n = 0;
  for (const k in state.unreadCounts) n += state.unreadCounts[k];
  return n;
}

/** Update document.title with unread count */
function updateDocumentTitle() {
  const n = totalUnread();
  const base = "My Claw";
  document.title = n > 0 ? `(${n}) ${base}` : base;
}

/** Update unread dot/badge on all rendered tab elements */
function updateUnreadBadges() {
  // Desktop tabs
  const tabEls = ui.tabBar?.querySelectorAll(".openclaw-tab");
  if (tabEls) {
    tabEls.forEach((el, i) => {
      const tab = state.tabSessions[i];
      if (!tab) return;
      let dot = el.querySelector(".oc-unread-dot");
      const count = state.unreadCounts[tab.key] || 0;
      if (count > 0) {
        if (!dot) {
          dot = document.createElement("span");
          dot.className = "oc-unread-dot";
          // Insert BEFORE the label (first child of tab-row)
          const row = el.querySelector(".openclaw-tab-row");
          if (row) row.insertBefore(dot, row.firstChild);
        }
        dot.textContent = count > 9 ? "9+" : String(count);
      } else if (dot) {
        dot.remove();
      }
    });
  }

  // Mobile tab switcher — show dot next to label if any tab has unread
  const switcherLabel = document.getElementById("tab-switcher-label");
  if (switcherLabel) {
    let switcherDot = switcherLabel.parentElement?.querySelector(".oc-unread-switcher-dot");
    const n = totalUnread();
    // Only show if there are unread on OTHER tabs (not the currently displayed one)
    const otherUnread = n - (state.unreadCounts[state.sessionKey] || 0);
    if (otherUnread > 0) {
      if (!switcherDot) {
        switcherDot = document.createElement("span");
        switcherDot.className = "oc-unread-switcher-dot";
        // Insert before the label, not after
        const switcherRow = switcherLabel.parentElement?.querySelector(".oc-tab-switcher-row");
        if (switcherRow) switcherRow.insertBefore(switcherDot, switcherLabel);
      }
      switcherDot.textContent = otherUnread > 9 ? "9+" : String(otherUnread);
    } else if (switcherDot) {
      switcherDot.remove();
    }
  }
}

/** Fire an OS notification for a background message */
function fireNotification(sessionKey, text) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (!document.hidden) return; // only when page is backgrounded

  const tab = state.tabSessions.find(t => t.key === sessionKey);
  const title = tab ? (tab.key === "main" ? "Home" : tab.label || "Untitled") : "New message";
  const body = text ? text.slice(0, 120) : "New message received";

  try {
    const n = new Notification(title, {
      body,
      icon: "/icon-192.png",
      tag: `openclaw-${sessionKey}`, // replaces previous notification for same tab
      renotify: true,
    });
    n.onclick = () => {
      window.focus();
      const t = state.tabSessions.find(t => t.key === sessionKey);
      if (t && t.key !== state.sessionKey) switchTab(t);
      n.close();
    };
  } catch {}
}

/** Request notification permission (called once on first connect) */
function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    // Don't prompt immediately — wait for user interaction
    // We'll request on first send instead
    return;
  }
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
      onGap: (info) => {
        console.warn("Gateway event gap detected:", info);
        void recoverFromEventGap(info);
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
  // Drain any queued messages from a previous session/page load
  setTimeout(() => processQueue(), 1000);
  // Immediately sync model from server (don't wait for first 15s interval)
  updateContextMeter();

  // Guard: only set up recurring timers/listeners once
  if (!state._chatInitialized) {
    state._chatInitialized = true;

  setInterval(() => updateContextMeter(), 15000);

  // Stale stream watchdog — clean up orphaned streams every 15s
  setInterval(() => {
    for (const [sk, ss] of state.streams) {
      const isStale = ss.lastDeltaTime && (Date.now() - ss.lastDeltaTime > 90000);
      // Background (startup) streams: clean up after 20s since they don't block anything
      const isBackgroundStale = ss.background && ss.runId?.startsWith("startup-")
        && (Date.now() - parseInt(ss.runId.split("-")[1])) > 20000;
      const isOrphanedStartup = !ss.lastDeltaTime && !ss.text && ss.runId?.startsWith("startup-")
        && (Date.now() - parseInt(ss.runId.split("-")[1])) > 45000;
      if (isStale || isBackgroundStale || isOrphanedStartup) {
        console.warn(`[watchdog] Cleaning up ${ss.background ? 'background' : 'stale'} stream for ${sk}`);
        finishStream(sk);
      }
    }
  }, 15000);

  // ─── Recover from app backgrounding (Android/iOS tab suspend) ──────
  // When the user switches to another app, the browser suspends JS and the
  // WebSocket can silently die. Stream events sent during suspension are lost.
  // When the user comes back, the UI is frozen with stale data.
  let lastHiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      lastHiddenAt = Date.now();
      return;
    }
    // Page is visible again — clear unread for current tab & update title
    clearUnread(state.sessionKey);

    // Page is visible again — recover
    const awayMs = Date.now() - lastHiddenAt;
    const wasAwayLong = awayMs > 3000; // more than 3 seconds in background

    if (!state.gateway || !state.gateway.connected) {
      // WS died while backgrounded — reconnection will happen via scheduleReconnect
      // but force it immediately instead of waiting for backoff
      if (state.gateway && !state.gateway.closed) {
        state.gateway.backoffMs = 100;
        // If WS is in a limbo state (not closed but not working), kill it
        if (state.gateway.ws) {
          try { state.gateway.ws.close(); } catch {}
        }
      }
      return;
    }

    if (wasAwayLong) {
      // Connection might still be alive but we missed stream events.
      // Refresh chat to get the final state.
      const activeStream = state.streams.get(state.sessionKey);
      if (activeStream) {
        // Was streaming when we left — check if it's still going or finished
        loadChatHistory({ background: true }).then(() => {
          // If history loaded and stream seems stale (no new deltas), clean up
          const ss = state.streams.get(state.sessionKey);
          if (ss && ss.lastDeltaTime && (Date.now() - ss.lastDeltaTime > 30000)) {
            // Stream has been silent for 30s+ — likely finished while backgrounded
            finishStream(state.sessionKey);
            loadChatHistory();
          }
        });
      } else {
        // Not streaming — just refresh to pick up any messages we missed
        loadChatHistory({ background: true });
      }
      updateContextMeter();
    }
  });

  } // end _chatInitialized guard
}

function updateConnectionStatus(connected) {
  if (connected) {
    state.reconnecting = false;
    state.gatewayRestarting = false;
    ui.sendBtn.classList.remove("oc-hidden");
    ui.messageInput.disabled = false;
    ui.messageInput.placeholder = "Message...";
    hideReconnectBanner();
  } else {
    stopHistoryInFlightPoll();
    ui.sendBtn.classList.add("oc-hidden");
    ui.messageInput.disabled = true;
    if (state.gatewayRestarting) {
      ui.messageInput.placeholder = "Gateway restarting…";
      showReconnectBanner("Gateway restarting — reconnecting…");
    } else {
      state.reconnecting = true;
      ui.messageInput.placeholder = "Reconnecting…";
      showReconnectBanner("Disconnected — reconnecting…");
    }
  }
  updateDashboard();
}

function showReconnectBanner(text) {
  let banner = document.getElementById("reconnect-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "reconnect-banner";
    banner.className = "oc-reconnect-banner";
    const container = ui.messagesContainer?.parentElement;
    if (container) container.insertBefore(banner, container.firstChild);
  }
  banner.textContent = text;
  banner.style.display = "";
}

function hideReconnectBanner() {
  const banner = document.getElementById("reconnect-banner");
  if (banner) banner.style.display = "none";
}

async function recoverFromEventGap(info) {
  if (state.gapRecoveryInFlight) return;
  state.gapRecoveryInFlight = true;
  stopHistoryInFlightPoll();

  const expected = Number.isFinite(info?.expected) ? info.expected : "?";
  const received = Number.isFinite(info?.received) ? info.received : "?";
  showReconnectBanner(`Event gap detected (expected ${expected}, got ${received}) — resyncing…`);

  // Drop all in-flight UI streams; source of truth is chat.history after resync.
  for (const [, ss] of state.streams) {
    if (ss?.compactTimer) clearTimeout(ss.compactTimer);
    if (ss?.workingTimer) clearTimeout(ss.workingTimer);
    if (ss?.runId && state.streamAssembler) state.streamAssembler.drop(ss.runId);
  }
  if (state.streamAssembler) state.streamAssembler.clear();
  state.streams.clear();
  state.runToSession.clear();
  state.streamEl = null;
  setSendButtonStopMode(false);
  hideBanner();
  ui.typingIndicator.classList.add("oc-hidden");

  // Invalidate all tab caches so subsequent tab switches are consistent.
  state.tabCache = {};

  try {
    await loadChatHistory({ background: true });
    // Best-effort: warm inactive tabs again after resync.
    prefetchAllTabs();
  } catch (err) {
    console.warn("Gap recovery history refresh failed:", err);
  } finally {
    if (state.gateway?.connected) hideReconnectBanner();
    state.gapRecoveryInFlight = false;
    setTimeout(() => processQueue(), 250);
  }
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
    const modelCfg = ad?.model;
    const model = typeof modelCfg === "string"
      ? modelCfg
      : (modelCfg?.primary || "");
    const fallbacks = normalizeFallbacks(
      Array.isArray(modelCfg?.fallbacks) ? modelCfg.fallbacks : [],
      model
    );
    const thinking = ad?.thinkingDefault || "";
    const reasoning = ad?.reasoningDefault || "";
    const verbose = ad?.verboseDefault || "";

    const resetCfg = parsed?.session?.reset || cfg?.session?.reset || {};
    const resetMode = resetCfg?.mode === "idle" ? "idle" : "daily";
    const parsedAtHour = Number(resetCfg?.atHour);
    const parsedIdleMinutes = Number(resetCfg?.idleMinutes);
    const resetAtHour = Number.isFinite(parsedAtHour) ? Math.max(0, Math.min(23, Math.round(parsedAtHour))) : 4;
    const resetIdleMinutes = Number.isFinite(parsedIdleMinutes) && parsedIdleMinutes > 0 ? Math.round(parsedIdleMinutes) : 240;

    const heartbeatCfg = ad?.heartbeat || {};
    const heartbeatEvery = heartbeatCfg?.every || "0m";

    state.defaults = {
      model: typeof model === "string" ? model : "",
      fallbacks,
      thinking,
      reasoning,
      verbose,
      resetMode,
      resetAtHour,
      resetIdleMinutes,
      heartbeatEvery,
    };
    
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
    updateSchedulePanel();
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

const MOBILE_TAB_MENU_BREAKPOINT = 768; // <= this uses mobile tab switcher

function updateTabMode() {
  // Defer to next frame — on iOS PWA cold start, layout isn't ready yet
  requestAnimationFrame(() => {
    const tabBar = ui.tabBar;
    const hamburgerBar = document.getElementById("hamburger-bar");
    const chatContainer = document.getElementById("chat-container");
    if (!tabBar || !hamburgerBar) return;
    const useMobileTabs = window.innerWidth > 0 && window.innerWidth <= MOBILE_TAB_MENU_BREAKPOINT;
    if (useMobileTabs) {
      tabBar.classList.add("oc-hamburger-mode");
      hamburgerBar.classList.add("oc-visible");
      chatContainer?.classList.add("oc-mobile-tabs");
      renderMobileTabSwitcher();
    } else {
      tabBar.classList.remove("oc-hamburger-mode");
      hamburgerBar.classList.remove("oc-visible");
      chatContainer?.classList.remove("oc-mobile-tabs");
    }
  });
}

function renderMobileTabSwitcher() {
  const label = document.getElementById("tab-switcher-label");
  const meterFill = document.getElementById("tab-switcher-meter-fill");
  const meterWrap = meterFill?.parentElement || null;
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

  const meterTitle = contextMeterTitle(current.model, current.used, current.max, current.pct || 0);
  if (meterFill) {
    meterFill.style.width = (current.pct || 0) + "%";
    meterFill.title = meterTitle;
  }
  if (meterWrap) {
    meterWrap.title = meterTitle;
  }
  label.title = meterTitle;

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

  // ── Mobile agent switcher (horizontal emoji row) ──
  if (state.isMobile && state.agents.length > 1) {
    const agentRow = document.createElement("div");
    agentRow.className = "oc-agent-row";
    for (const agent of state.agents) {
      const btn = document.createElement("button");
      btn.className = "oc-agent-pill" + (agent.id === state.activeAgent.id ? " oc-agent-active" : "");
      btn.title = agent.name;
      const emoji = document.createElement("span");
      emoji.className = "oc-agent-pill-emoji";
      emoji.textContent = agent.emoji || "🤖";
      btn.appendChild(emoji);
      const name = document.createElement("span");
      name.className = "oc-agent-pill-name";
      name.textContent = agent.name || agent.id;
      btn.appendChild(name);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (agent.id !== state.activeAgent.id) {
          dd.classList.remove("oc-open");
          switchAgent(agent);
        }
      });
      agentRow.appendChild(btn);
    }
    dd.appendChild(agentRow);
  }

  const currentKey = state.sessionKey || "main";
  for (const tab of state.tabSessions) {
    const isHome = tab.key === "main";
    const isCurrent = tab.key === currentKey;
    const item = document.createElement("div");
    item.className = `oc-hamburger-dropdown-item${isCurrent ? " oc-active" : ""}`;

    const label = document.createElement("span");
    label.className = "oc-dd-label";
    if (isHome) {
      label.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;opacity:0.7"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg> Home';
    } else {
      label.textContent = tab.label;
      label.title = "Double-click to rename";
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startHamburgerRename(label, tab, dd);
      });
    }
    item.appendChild(label);

    // Unread badge in dropdown — insert BEFORE the label
    const ddUnread = state.unreadCounts[tab.key] || 0;
    if (ddUnread > 0 && !isCurrent) {
      const badge = document.createElement("span");
      badge.className = "oc-unread-dot";
      badge.textContent = ddUnread > 9 ? "9+" : String(ddUnread);
      // Insert before label (label is already appended to item)
      item.insertBefore(badge, label);
    }

    const meter = document.createElement("div");
    meter.className = "oc-dd-meter";
    const fill = document.createElement("div");
    fill.className = "oc-dd-meter-fill";
    fill.style.width = tab.pct + "%";
    const meterTitle = contextMeterTitle(tab.model, tab.used, tab.max, tab.pct || 0);
    fill.title = meterTitle;
    meter.title = meterTitle;
    item.title = meterTitle;
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
    const pct = Math.min(100, Math.round((used / max) * 100));
    state.tabSessions.push({ key: "main", label: "Home", pct, used, max, model: mainSession.model || "" });
  } else {
    state.tabSessions.push({ key: "main", label: "Home", pct: 0, used: 0, max: 200000, model: state.currentModel || "" });
  }

  const others = convSessions
    .filter(s => {
      const sk = s.key.slice(prefix.length);
      return sk !== "main";
    })
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
    state.tabSessions.push({ key: sk, label, pct, used, max, model: s.model || "" });
  }

  // Ensure the active session always has a tab (sessions.list race condition)
  if (currentKey !== "main" && !state.tabSessions.find(t => t.key === currentKey)) {
    state.tabSessions.push({ key: currentKey, label: "Untitled", pct: 0, used: 0, max: 200000, model: "" });
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
      label.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
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
    // Unread badge — insert BEFORE label (first child) to match updateUnreadBadges()
    const unreadCount = state.unreadCounts[tab.key] || 0;
    if (unreadCount > 0 && !isCurrent) {
      const dot = document.createElement("span");
      dot.className = "oc-unread-dot";
      dot.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
      row.insertBefore(dot, row.firstChild);
    }

    tabEl.appendChild(row);

    const meter = document.createElement("div");
    meter.className = "openclaw-tab-meter";
    const fill = document.createElement("div");
    fill.className = "openclaw-tab-meter-fill";
    fill.style.width = tab.pct + "%";
    const meterTitle = contextMeterTitle(tab.model, tab.used, tab.max, tab.pct || 0);
    fill.title = meterTitle;
    meter.title = meterTitle;
    tabEl.title = meterTitle;
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
  const MAX_QUEUE = 5;
  if (!state.messageQueue[key]) state.messageQueue[key] = [];
  if (state.messageQueue[key].length >= MAX_QUEUE) return; // silently cap
  const entry = { text, timestamp: Date.now() };
  if (attachments && attachments.length > 0) {
    entry.attachments = attachments.map(a => ({ name: a.name, mimeType: a.mimeType, base64: a.base64, content: a.content }));
  }
  state.messageQueue[key].push(entry);
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
  const modelBar = document.querySelector('.openclaw-model-bar');
  if (!modelBar) return;

  // Remove old queue bar
  document.getElementById('oc-queue-bar')?.remove();

  const queue = state.messageQueue[state.sessionKey] || [];
  if (queue.length === 0) return;

  const key = state.sessionKey;
  const bar = document.createElement('div');
  bar.id = 'oc-queue-bar';
  bar.className = 'oc-queue-bar';

  // Collapsed header: "⏳ N queued" + expand toggle + clear all
  const header = document.createElement('div');
  header.className = 'oc-queue-header';
  header.innerHTML = `<span class="oc-queue-summary">⏳ <strong>${queue.length}</strong> queued</span>`;
  const actions = document.createElement('span');
  actions.className = 'oc-queue-actions';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'oc-queue-clear';
  clearBtn.textContent = 'Clear all';
  clearBtn.title = 'Remove all queued messages';
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    delete state.messageQueue[key];
    localStorage.setItem('messageQueue', JSON.stringify(state.messageQueue));
    renderQueuedMessages();
  });
  actions.appendChild(clearBtn);

  const chevron = document.createElement('span');
  chevron.className = 'oc-queue-chevron';
  chevron.textContent = '▾';
  actions.appendChild(chevron);
  header.appendChild(actions);

  // Item list (collapsed by default)
  const list = document.createElement('div');
  list.className = 'oc-queue-list';

  queue.forEach((msg, i) => {
    let fullText = msg.text || '';
    if (msg.attachments && msg.attachments.length > 0) {
      const names = msg.attachments.map(a => a.name).join(', ');
      fullText = fullText ? `📎 ${names} — ${fullText}` : `📎 ${names}`;
    }
    const esc = fullText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');

    const item = document.createElement('div');
    item.className = 'oc-queue-item';
    item.innerHTML = `
      <span class="oc-queue-num">${i + 1}</span>
      <span class="oc-queue-text">${esc}</span>
    `;
    const itemActions = document.createElement('span');
    itemActions.className = 'oc-queue-item-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'oc-queue-copy';
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy to clipboard';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(msg.text || '').then(() => {
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
      }).catch(() => {});
    });
    itemActions.appendChild(copyBtn);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'oc-queue-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeQueuedMessage(key, i);
    });
    itemActions.appendChild(removeBtn);
    item.appendChild(itemActions);
    list.appendChild(item);
  });

  // Toggle expand/collapse
  header.addEventListener('click', () => {
    const expanded = bar.classList.toggle('oc-queue-expanded');
    chevron.textContent = expanded ? '▴' : '▾';
  });

  bar.appendChild(header);
  bar.appendChild(list);
  modelBar.parentNode.insertBefore(bar, modelBar);
}

function processQueue() {
  // Lock: only one drain loop at a time
  if (state.processingQueue) return;
  const key = state.sessionKey;
  const queue = state.messageQueue[key];
  if (!queue || queue.length === 0) return;
  // Don't process if still streaming, transcript indicates an in-flight run,
  // or we're already sending.
  if (state.streams.has(key) || state.historyInFlight[key] || state.sending) {
    // Retry after current send/stream completes
    setTimeout(() => processQueue(), 800);
    return;
  }
  // Don't process if gateway is disconnected
  if (!state.gateway?.connected) return;

  state.processingQueue = true;

  // Pop item and flush localStorage BEFORE sending
  const next = queue.shift();
  if (queue.length === 0) delete state.messageQueue[key];
  localStorage.setItem('messageQueue', JSON.stringify(state.messageQueue));
  renderQueuedMessages();

  // Restore attachments if any
  if (next.attachments && next.attachments.length > 0) {
    state.pendingAttachments = next.attachments;
  }
  // Send and wait for completion before unlocking
  sendMessage(next.text || '').finally(() => {
    state.processingQueue = false;
    // Drain next queued message if any remain
    const remaining = state.messageQueue[key];
    if (remaining && remaining.length > 0) {
      setTimeout(() => processQueue(), 500);
    }
  });
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

  // Clear unread for the tab we're switching to
  clearUnread(tab.key);

  // Visual switch IMMEDIATELY — don't wait for history
  renderTabs();
  updateMobileTabLabelInstant(tab);
  restoreDraft();

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
  renderQueuedMessages();

  // Drain any queued messages if no active stream on this tab
  if (!state.streams.has(tab.key) && !state.sending) {
    setTimeout(() => processQueue(), 300);
  }

  // Context meter in background (don't block UI)
  updateContextMeter();
}

/** Instantly update the mobile tab switcher label + arrows without any network call */
function updateMobileTabLabelInstant(tab) {
  const label = document.getElementById("tab-switcher-label");
  const arrowLeft = document.getElementById("tab-arrow-left");
  const arrowRight = document.getElementById("tab-arrow-right");
  if (!label) return;

  if (tab.key === "main") {
    label.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-4px;opacity:0.8"><path d="M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3l9-8z"/></svg>';
    label.title = "";
    label.ondblclick = null;
  } else {
    label.textContent = tab.label || "Untitled";
    label.title = "Double-click to rename";
    label.ondblclick = (e) => {
      e.stopPropagation();
      startSwitcherRename(label, tab);
    };
  }

  // Update arrows based on current position in tabSessions
  const idx = state.tabSessions.findIndex(t => t.key === tab.key);
  if (arrowLeft) {
    arrowLeft.style.visibility = idx <= 0 ? "hidden" : "visible";
    arrowLeft.style.pointerEvents = idx <= 0 ? "none" : "auto";
  }
  if (arrowRight) {
    arrowRight.style.visibility = idx >= state.tabSessions.length - 1 ? "hidden" : "visible";
    arrowRight.style.pointerEvents = idx >= state.tabSessions.length - 1 ? "none" : "auto";
  }
}

async function resetTab(tab) {
  if (!state.gateway?.connected) return;
  delete state.tabCache[tab.key];
  const isHome = tab.key === "main";
  const title = isHome ? "Reset Home?" : `Reset "${tab.label}"?`;
  const msg = "You will be briefly disconnected while resetting. Just wait a few moments.";
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
  state.tabDeleteInProgress = true;
  delete state.tabCache[tab.key];
  finishStream(tab.key);

  // Actually delete the session on the gateway
  try {
    await deleteSessionWithFallback(state.gateway, `${agentPrefix()}${tab.key}`, true);
  } catch (err) {
    console.error("Failed to delete session:", err);
  }

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
  // Collect ALL known tab numbers: visible tabs + gateway sessions
  const nums = state.tabSessions
    .map(t => { const m = t.key.match(/^tab-(\d+)$/); return m ? parseInt(m[1]) : NaN; })
    .filter(n => !isNaN(n));
  // Also include cached gateway sessions to avoid key collisions
  for (const s of (state._cachedSessions || [])) {
    const m = s.key.match(/tab-(\d+)/);
    if (m) nums.push(parseInt(m[1]));
  }
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
    const modelCooldown = Date.now() - state.currentModelSetAt < 5000;
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
      const meterTitle = contextMeterTitle(session.model || state.currentModel || "", used, max, pct);
      activeFill.title = meterTitle;
      const activeMeter = activeFill.parentElement;
      if (activeMeter) activeMeter.title = meterTitle;
      const activeTabEl = activeFill.closest(".openclaw-tab");
      if (activeTabEl) activeTabEl.title = meterTitle;

      const activeTab = state.tabSessions.find(t => t.key === sk);
      if (activeTab) {
        activeTab.used = used;
        activeTab.max = max;
        activeTab.pct = pct;
        activeTab.model = session.model || activeTab.model || "";
      }

      const hamburgerBar = document.getElementById("hamburger-bar");
      if (hamburgerBar?.classList.contains("oc-visible")) {
        renderMobileTabSwitcher();
      }

      const mobileLabel = document.getElementById("tab-switcher-label");
      if (mobileLabel) mobileLabel.title = meterTitle;
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
    
    // Update subagents panel from same sessions data (reuse fetched sessions)
    loadSubagents(sessions);
  } catch { /* ignore */ }
}

// ─── Model Management ────────────────────────────────────────────────

function shortModelName(fullId) {
  const model = fullId.includes("/") ? fullId.split("/")[1] : fullId;
  return model.replace(/^claude-/, "");
}

function normalizeFallbacks(list, primaryModel = "") {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id) continue;
    if (primaryModel && id === primaryModel) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function contextMeterTitle(model, used, max, pct) {
  const modelName = shortModelName(model || "unknown");
  const usedSafe = Number.isFinite(Number(used)) ? Number(used) : 0;
  const maxSafe = Number.isFinite(Number(max)) ? Number(max) : 0;
  const pctSafe = Number.isFinite(Number(pct)) ? Number(pct) : 0;
  const ratio = maxSafe > 0
    ? `${usedSafe.toLocaleString()} / ${maxSafe.toLocaleString()} (${pctSafe}%)`
    : `${usedSafe.toLocaleString()} tokens`;
  return `${modelName}\n${ratio}`;
}

function updateModelLabel() {
  if (!state.currentModel) {
    ui.modelLabel.textContent = "";
    return;
  }
  ui.modelLabel.textContent = shortModelName(state.currentModel) + " ▾";
  updateDashboard();
}

// ─── Bar Controls (simple visibility toggles) ───────────────────────

function onOffLabel(enabled) {
  return enabled ? "on" : "off";
}

function updateBarControls() {
  const toolsEl = document.getElementById("bar-thinking");
  const reasonEl = document.getElementById("bar-reasoning");
  const stepsEl = document.getElementById("bar-verbose");

  const showToolUse = shouldShowToolEvents();
  const showSteps = shouldShowToolOutput();
  const showReasoning = effectiveReasoningLevel() !== "off";

  if (toolsEl) {
    toolsEl.textContent = "show tool use: " + onOffLabel(showToolUse);
    toolsEl.classList.toggle("active", showToolUse);
  }
  if (reasonEl) {
    reasonEl.textContent = "show reasoning: " + onOffLabel(showReasoning);
    reasonEl.classList.toggle("active", showReasoning);
  }
  if (stepsEl) {
    stepsEl.textContent = "show steps: " + onOffLabel(showSteps);
    stepsEl.classList.toggle("active", showSteps);
  }
}

async function setSessionControl(field, nextValue) {
  if (!state.gateway?.connected) return;
  const patch = {};
  patch[field] = nextValue || null;
  try {
    await state.gateway.request("sessions.patch", {
      key: `${agentPrefix()}${state.sessionKey}`,
      ...patch,
    });
    state[field] = nextValue;
    updateBarControls();

    // Visibility toggles should affect full history immediately,
    // even when no stream is currently active.
    if (field === "verboseLevel" || field === "reasoningLevel") {
      renderMessages({ preserveScroll: true });
    }

    // Keep streaming UI in sync with button changes.
    const ss = state.streams.get(state.sessionKey);
    if (ss) {
      if (field === "reasoningLevel" && ss.runId && state.streamAssembler) {
        const preview = state.streamAssembler.peek(ss.runId, shouldShowThinkingInStream());
        if (preview !== null) {
          ss.text = preview;
          updateStreamBubble();
        }
      }
      if (field === "verboseLevel") {
        restoreStreamUI();
      }
    }
  } catch (err) {
    console.error(`Failed to set ${field}:`, err);
  }
}

async function toggleShowToolUse() {
  const next = shouldShowToolEvents() ? "off" : "on";
  await setSessionControl("verboseLevel", next);
}

async function toggleShowSteps() {
  const next = shouldShowToolOutput() ? "on" : "full";
  await setSessionControl("verboseLevel", next);
}

async function toggleShowReasoning() {
  const next = effectiveReasoningLevel() === "off" ? "on" : "off";
  await setSessionControl("reasoningLevel", next);
}

document.getElementById("bar-thinking")?.addEventListener("click", () =>
  toggleShowToolUse());
document.getElementById("bar-reasoning")?.addEventListener("click", () =>
  toggleShowReasoning());
document.getElementById("bar-verbose")?.addEventListener("click", () =>
  toggleShowSteps());

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

async function openFallbackPicker(opts = {}) {
  let models = [];
  try {
    const result = await state.gateway?.request("models.list", {});
    models = result?.models || [];
  } catch { models = []; }

  const primaryModel = opts.primary || state.pendingDefaults.model || state.defaults.model || "";
  const selected = normalizeFallbacks(opts.current || [], primaryModel);

  const allModels = models
    .map((m) => ({
      provider: m.provider || "unknown",
      id: m.id || "",
      name: m.name || m.id || "",
      fullId: `${m.provider}/${m.id}`,
    }))
    .filter((m) => !!m.id && m.fullId !== primaryModel)
    .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));

  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

  const box = document.createElement("div");
  box.className = "modal";

  function render() {
    box.innerHTML = "";

    const title = document.createElement("h3");
    title.textContent = "Fallbacks";
    box.appendChild(title);

    const selectedLabel = document.createElement("div");
    selectedLabel.className = "openclaw-picker-footer";
    selectedLabel.style.marginTop = "0";
    selectedLabel.textContent = "Order matters: top runs first";
    box.appendChild(selectedLabel);

    const selectedList = document.createElement("div");
    selectedList.className = "openclaw-picker-list";

    if (selected.length === 0) {
      const empty = document.createElement("div");
      empty.className = "openclaw-picker-row";
      empty.style.opacity = "0.65";
      empty.textContent = "No fallbacks selected";
      selectedList.appendChild(empty);
    } else {
      selected.forEach((fullId, idx) => {
        const row = document.createElement("div");
        row.className = "openclaw-picker-row active";

        const left = document.createElement("div");
        left.className = "openclaw-picker-row-left";
        left.innerHTML = `<span class="openclaw-picker-dot">${idx + 1}.</span><span>${shortModelName(fullId)}</span>`;

        const right = document.createElement("div");
        right.className = "openclaw-picker-row-right";

        const upBtn = document.createElement("button");
        upBtn.className = "openclaw-picker-back";
        upBtn.style.padding = "2px 8px";
        upBtn.style.fontSize = "12px";
        upBtn.textContent = "↑";
        upBtn.disabled = idx === 0;
        upBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (idx <= 0) return;
          const tmp = selected[idx - 1];
          selected[idx - 1] = selected[idx];
          selected[idx] = tmp;
          render();
        });

        const downBtn = document.createElement("button");
        downBtn.className = "openclaw-picker-back";
        downBtn.style.padding = "2px 8px";
        downBtn.style.fontSize = "12px";
        downBtn.textContent = "↓";
        downBtn.disabled = idx === selected.length - 1;
        downBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (idx >= selected.length - 1) return;
          const tmp = selected[idx + 1];
          selected[idx + 1] = selected[idx];
          selected[idx] = tmp;
          render();
        });

        const removeBtn = document.createElement("button");
        removeBtn.className = "openclaw-picker-back";
        removeBtn.style.padding = "2px 8px";
        removeBtn.style.fontSize = "12px";
        removeBtn.textContent = "remove";
        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          selected.splice(idx, 1);
          render();
        });

        right.appendChild(upBtn);
        right.appendChild(downBtn);
        right.appendChild(removeBtn);

        row.appendChild(left);
        row.appendChild(right);
        selectedList.appendChild(row);
      });
    }

    box.appendChild(selectedList);

    const availableLabel = document.createElement("div");
    availableLabel.className = "openclaw-picker-footer";
    availableLabel.textContent = "Available models";
    box.appendChild(availableLabel);

    const availableList = document.createElement("div");
    availableList.className = "openclaw-picker-list";

    for (const m of allModels) {
      const isSelected = selected.includes(m.fullId);
      const row = document.createElement("div");
      row.className = `openclaw-picker-row${isSelected ? " active" : ""}`;
      row.innerHTML = `
        <div class="openclaw-picker-row-left">
          ${isSelected ? '<span class="openclaw-picker-dot">● </span>' : ""}
          <span>${m.name}</span>
        </div>
        <div class="openclaw-picker-row-right">
          <span class="openclaw-picker-meta">${m.provider}</span>
        </div>
      `;
      row.addEventListener("click", () => {
        const i = selected.indexOf(m.fullId);
        if (i >= 0) selected.splice(i, 1);
        else selected.push(m.fullId);
        render();
      });
      availableList.appendChild(row);
    }

    box.appendChild(availableList);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.marginTop = "10px";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "openclaw-picker-back";
    cancelBtn.style.flex = "1";
    cancelBtn.style.padding = "8px 10px";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => modal.remove());

    const saveBtn = document.createElement("button");
    saveBtn.className = "hud-defaults-apply";
    saveBtn.style.flex = "1";
    saveBtn.style.margin = "0";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => {
      opts.onSave?.(selected.slice(), modal);
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    box.appendChild(actions);
  }

  render();
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

function messagesEquivalent(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;

  const normalize = (m) => {
    if (!m || typeof m !== "object") return "";
    if (m.role === "toolResult") {
      return JSON.stringify({
        role: "toolResult",
        toolName: str(m.toolName),
        toolCallId: str(m.toolCallId),
        detail: str(m.detail),
        isError: !!m.isError,
      });
    }
    return JSON.stringify({
      role: str(m.role),
      text: str(m.text),
      images: Array.isArray(m.images) ? m.images : [],
      hasToolBlocks: !!m.hasToolBlocks,
      isReasoning: !!m.isReasoning,
      contentBlocks: Array.isArray(m.contentBlocks) ? m.contentBlocks : [],
    });
  };

  for (let i = 0; i < a.length; i++) {
    if (normalize(a[i]) !== normalize(b[i])) return false;
  }
  return true;
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
    const assistantHasText = (content) => {
      if (typeof content === "string") return !!content.trim();
      if (!Array.isArray(content)) return false;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) return true;
      }
      return false;
    };
    const assistantHasToolCalls = (content) => {
      if (!Array.isArray(content)) return false;
      return content.some((block) => block && typeof block === "object" && (block.type === "toolCall" || block.type === "tool_use"));
    };

    // Transcript-first in-flight detection for refresh/reopen recovery.
    // If the latest transcript entry is a toolResult or an assistant tool-call frame
    // without final text yet, treat as potentially still running.
    const runTail = messages.filter((m) => m?.role === "user" || m?.role === "assistant" || m?.role === "toolResult");
    const last = runTail.length > 0 ? runTail[runTail.length - 1] : null;
    let maybeInFlight = false;
    if (last?.role === "toolResult") {
      maybeInFlight = true;
    } else if (last?.role === "assistant") {
      maybeInFlight = assistantHasToolCalls(last.content) && !assistantHasText(last.content);
    }

    // Transcript-first: remember toolCall metadata by call id so corresponding
    // toolResult rows can reuse the exact label/args from the same run.
    const toolCallMetaById = new Map();

    let parsed = messages
      .filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult")
      .map(m => {
        if (m.role === "toolResult") {
          const toolCallId = str(m.toolCallId);
          const meta = toolCallMetaById.get(toolCallId);
          return {
            role: "toolResult",
            toolName: str(m.toolName, str(meta?.name)),
            toolArgs: meta?.args || {},
            toolCallId,
            detail: summarizeToolResult(m?.details ?? m?.content ?? m),
            isError: !!m.isError,
            timestamp: m.timestamp ?? 0,
          };
        }

        if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const block of m.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type !== "tool_use" && block.type !== "toolCall") continue;
            const id = str(block.id, str(block.toolCallId));
            if (!id) continue;
            toolCallMetaById.set(id, {
              name: str(block.name),
              args: block.input || block.arguments || {},
            });
          }
        }

        const { text, images } = extractContent(m.content);
        const runId = str(m.runId, str(m?.meta?.runId, str(m?.metadata?.runId)));
        const hasToolBlocks = Array.isArray(m.content)
          && m.content.some((b) => b?.type === "tool_use" || b?.type === "toolCall");
        return {
          role: m.role,
          text,
          images,
          timestamp: m.timestamp ?? 0,
          contentBlocks: Array.isArray(m.content) ? m.content : undefined,
          runId,
          hasToolBlocks,
          isReasoning: m.role === "assistant" && /^reasoning\s*:/i.test((text || "").trim()),
        };
      })
      .filter(m => {
        if (m.role === "toolResult") return true;
        return (m.text.trim() || m.images.length > 0 || m.hasToolBlocks) && !m.text.startsWith("HEARTBEAT");
      });

    // Strip injected system messages from user messages
    parsed = parsed.map(m => {
      if (m.role === "toolResult") return m;
      if (m.role === "user") {
        m.text = stripSystemMessages(m.text);
      }
      return m;
    }).filter(m => {
      if (m.role === "toolResult") return true;
      return m.text.trim() || m.images.length > 0 || m.hasToolBlocks;
    });

    // Hide system-generated startup messages (not real user input)
    if (parsed.length > 0 && parsed[0].role === "user") {
      const firstText = parsed[0].text.trim();
      const isSystemStartup =
        firstText.startsWith("A new session was started") ||
        firstText.startsWith("Read HEARTBEAT") ||
        firstText.startsWith("Execute your Session Startup") ||
        /^\[?(system|openclaw)\]?\s/i.test(firstText) ||
        firstText.startsWith("You are starting a new") ||
        firstText === "/new" || firstText === "/reset";
      if (isSystemStartup) {
        parsed = parsed.slice(1);
      }
    }

    state.historyInFlight[targetKey] = maybeInFlight;

    const previous = (targetKey === state.sessionKey)
      ? state.messages
      : (state.tabCache[targetKey]?.messages || []);
    const changed = !messagesEquivalent(parsed, previous);

    // Cache the result
    state.tabCache[targetKey] = { messages: parsed, timestamp: Date.now() };

    // Only update UI if this is still the active tab
    if (targetKey === state.sessionKey) {
      state.messages = parsed;
      if (!background) hideLoading();
      if (!background || changed) {
        renderMessages({ preserveScroll: background });
      }

      // If a run was already in-flight before this page connected, keep polling
      // transcript history until the final assistant message lands.
      if (!state.streams.has(targetKey) && maybeInFlight) {
        startHistoryInFlightPoll(targetKey);
      } else if (!maybeInFlight) {
        stopHistoryInFlightPoll(targetKey);
      }
    }
  } catch (err) {
    if (!background && targetKey === state.sessionKey) hideLoading();
    console.error("Failed to load chat history:", err);
  }
}

function stopHistoryInFlightPoll(sessionKey) {
  if (state.historyPollSession && sessionKey && state.historyPollSession !== sessionKey) return;
  const endedSession = state.historyPollSession;
  if (state.historyPollTimer) {
    clearInterval(state.historyPollTimer);
    state.historyPollTimer = null;
  }
  state.historyPollSession = "";
  state.historyPollSettled = 0;

  // When transcript polling settles for the active tab, try draining queue.
  if (endedSession && endedSession === state.sessionKey) {
    setTimeout(() => processQueue(), 50);
  }
}

function startHistoryInFlightPoll(sessionKey) {
  if (!sessionKey) return;
  if (state.historyPollTimer && state.historyPollSession === sessionKey) return;
  stopHistoryInFlightPoll();

  state.historyPollSession = sessionKey;
  state.historyPollSettled = 0;
  state.historyPollTimer = setInterval(async () => {
    if (state.sessionKey !== sessionKey) {
      stopHistoryInFlightPoll(sessionKey);
      return;
    }
    if (state.streams.has(sessionKey)) {
      stopHistoryInFlightPoll(sessionKey);
      return;
    }

    await loadChatHistory({ background: true, sessionKey });
    const stillInFlight = !!state.historyInFlight[sessionKey];
    if (stillInFlight) {
      state.historyPollSettled = 0;
      return;
    }
    state.historyPollSettled += 1;
    if (state.historyPollSettled >= 3) stopHistoryInFlightPoll(sessionKey);
  }, 1200);
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

// Strip system-injected messages from user message text
// These are OpenClaw gateway notifications (exec completed, etc.) that get
// prepended to user messages. They start with "System: [" or "[System Message]"
function stripSystemMessages(text) {
  if (!text) return text;
  // Split into lines and filter out system lines + their trailing blank lines
  const lines = text.split("\n");
  const cleaned = [];
  let skipBlanks = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Match system message patterns:
    // "System: [2026-03-26 13:20:19 UTC] Exec completed..."
    // "[System Message] ..."
    // "System: [timestamp] ..."
    if (/^System:\s*\[/i.test(trimmed) || /^\[System Message\]/i.test(trimmed)) {
      skipBlanks = true;
      continue;
    }
    if (skipBlanks && trimmed === "") continue;
    skipBlanks = false;
    cleaned.push(line);
  }

  return cleaned.join("\n").trim();
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

function isReasoningAssistantMessage(msg) {
  if (!msg || msg.role !== "assistant") return false;
  if (msg.isReasoning) return true;
  const direct = str(msg.text).trim();
  if (direct && /^reasoning\s*:/i.test(direct)) return true;

  const blocks = Array.isArray(msg.contentBlocks) ? msg.contentBlocks : [];
  if (blocks.length > 0) {
    let merged = "";
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") merged += block.text;
    }
    if (merged.trim() && /^reasoning\s*:/i.test(merged.trim())) return true;
  }
  return false;
}

function renderMessages(opts = {}) {
  const forceBottom = !!opts.forceBottom;
  const prevTop = ui.messagesContainer.scrollTop;
  const wasNearBottom = isNearBottom(ui.messagesContainer);

  // Sync cache with current messages
  if (state.sessionKey && state.messages.length > 0) {
    state.tabCache[state.sessionKey] = { messages: [...state.messages], timestamp: Date.now() };
  }
  ui.messagesContainer.innerHTML = "";
  state.streamEl = null;
  for (const msg of state.messages) {
    if (msg.role === "assistant" && isReasoningAssistantMessage(msg) && effectiveReasoningLevel() === "off") {
      continue;
    }

    if (msg.role === "toolResult") {
      if (shouldShowToolEvents()) {
        const { label, url } = buildToolLabel(msg.toolName || "", msg.toolArgs || {});
        appendToolCall(label, url, false, {
          toolCallId: msg.toolCallId || "",
          detail: shouldShowToolOutput() ? (msg.detail || "") : "",
          isError: !!msg.isError,
          noScroll: true,
        });
      }
      continue;
    }

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
            if (shouldShowToolEvents()) {
              const { label, url } = buildToolLabel(block.name || "", block.input || block.arguments || {});
              appendToolCall(label, url, false, { noScroll: true });
            }
          }
        }
        continue;
      }
    }

    appendMessage(msg);
  }

  if (forceBottom || wasNearBottom) {
    scrollToBottom();
  } else {
    ui.messagesContainer.scrollTop = prevTop;
  }
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
    const copyBtn = `<button class="oc-code-copy" style="position:absolute;top:4px;right:4px;padding:2px 8px;font-size:11px;background:var(--background-modifier-hover,rgba(255,255,255,0.1));border:1px solid var(--background-modifier-border,rgba(255,255,255,0.1));border-radius:3px;color:var(--text-muted,#999);cursor:pointer;opacity:0;transition:opacity 0.15s">Copy</button>`;
    codeBlocks.push(`<pre class="oc-code-block" style="position:relative;margin:6px 0;background:var(--background-secondary,#141416);border:1px solid var(--background-modifier-border,rgba(255,255,255,0.06));border-radius:4px;overflow-x:auto">${langLabel}${copyBtn}<code style="display:block;padding:8px 12px;font-size:12px;line-height:1.6;background:none">${escapeHtmlChat(code)}</code></pre>`);
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

  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => safeImage(alt, url));

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => safeLink(text, url));

  html = html.replace(/^[\-\*]\s+(.+)$/gm, "<li>$1</li>");

  html = html.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="ol-item" value="$1">$2</li>');

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

/** Sanitize a URL — only allow http(s), mailto, and # (anchor) protocols */
function sanitizeUrl(url) {
  const trimmed = url.trim();
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const parsed = new URL(trimmed, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return trimmed;
    }
  } catch {}
  return "";
}

/** Build a safe <a> element and return its outerHTML */
function safeLink(text, url) {
  const sanitized = sanitizeUrl(url);
  if (!sanitized) return escapeHtmlChat(text);
  const a = document.createElement("a");
  a.href = sanitized;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a.outerHTML;
}

/** Build a safe <img> element and return its outerHTML */
function safeImage(alt, url) {
  const sanitized = sanitizeUrl(url);
  if (!sanitized) return escapeHtmlChat(alt || "");
  const img = document.createElement("img");
  img.src = sanitized;
  img.alt = alt || "";
  img.style.cssText = "max-width:100%;border-radius:4px";
  return img.outerHTML;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    ui.messagesContainer.scrollTop = ui.messagesContainer.scrollHeight;
  });
}

function isNearBottom(el, threshold = 48) {
  if (!el) return true;
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
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
    case "web_search": {
      const q = str(a?.query);
      return { label: `🔍 Searching "${q.length > 40 ? q.slice(0, 40) + "…" : q}"` };
    }
    case "web_fetch": {
      const rawUrl = str(a?.url);
      try { return { label: `🌐 Fetching ${new URL(rawUrl).hostname}`, url: rawUrl }; }
      catch { return { label: "🌐 Fetching page", url: rawUrl || undefined }; }
    }
    case "browser": return { label: "🌐 Using browser" };
    case "image": return { label: "👁️ Viewing image" };
    case "memory_search": {
      const q = str(a?.query);
      return { label: `🧠 Searching "${q.length > 40 ? q.slice(0, 40) + "…" : q}"` };
    }
    case "memory_get": {
      const p = str(a?.path);
      return { label: `🧠 Reading ${p.split("/").pop() || "memory"}` };
    }
    case "message": return { label: "💬 Sending message" };
    case "tts": return { label: "🔊 Speaking" };
    case "session_status": return { label: "📊 Checking status" };
    case "sessions_spawn": return { label: "🤖 Spawning sub-agent" };
    case "sessions_list": return { label: "📋 Listing sessions" };
    case "sessions_history": return { label: "📜 Reading history" };
    case "sessions_send": return { label: "📨 Sending to session" };
    case "subagents": return { label: "🤖 Managing sub-agents" };
    case "process": return { label: "⚙️ Managing process" };
    case "nodes": return { label: "📡 Checking nodes" };
    case "canvas": return { label: "🖼️ Using canvas" };
    case "agents_list": return { label: "📋 Listing agents" };
    default: return { label: toolName ? `⚡ ${toolName}` : "Working" };
  }
}

function findToolItemEl(toolCallId) {
  if (!toolCallId) return null;
  const items = ui.messagesContainer.querySelectorAll(".openclaw-tool-item[data-tool-call-id]");
  for (const el of items) {
    if (el.dataset.toolCallId === toolCallId) return el;
  }
  return null;
}

function setToolDots(el, active) {
  const existing = el.querySelector(".openclaw-tool-dots");
  if (!active) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const dots = document.createElement("span");
  dots.className = "openclaw-tool-dots";
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "openclaw-dot";
    dots.appendChild(dot);
  }
  el.appendChild(dots);
}

function appendToolCall(label, url, active = false, opts = {}) {
  const toolCallId = str(opts.toolCallId);
  const detail = str(opts.detail);
  const isError = !!opts.isError;
  const noScroll = !!opts.noScroll;

  let el = toolCallId ? findToolItemEl(toolCallId) : null;
  if (!el) {
    el = document.createElement("div");
    ui.messagesContainer.appendChild(el);
  }

  el.className = "openclaw-tool-item" + (active ? " openclaw-tool-active" : "") + (isError ? " openclaw-tool-error" : "");
  if (toolCallId) el.dataset.toolCallId = toolCallId;
  else delete el.dataset.toolCallId;

  el.innerHTML = "";
  const title = document.createElement(url ? "a" : "span");
  if (url) {
    title.href = url;
    title.className = "openclaw-tool-link";
    title.addEventListener("click", (e) => { e.preventDefault(); window.open(url, "_blank"); });
  }
  title.textContent = label;
  el.appendChild(title);

  if (detail) {
    const detailEl = document.createElement("div");
    detailEl.className = "openclaw-tool-output";
    detailEl.textContent = detail;
    el.appendChild(detailEl);
  }

  setToolDots(el, active);
  if (!noScroll) scrollToBottom();
}

function deactivateLastToolItem() {
  const items = ui.messagesContainer.querySelectorAll(".openclaw-tool-active");
  const last = items[items.length - 1];
  if (!last) return;
  last.classList.remove("openclaw-tool-active");
  setToolDots(last, false);
}

function summarizeToolResult(result, maxLen = 280) {
  let text = "";

  if (typeof result === "string") {
    text = result;
  } else if (result && typeof result === "object") {
    if (Array.isArray(result.content)) {
      const parts = [];
      for (const c of result.content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
      }
      text = parts.join("\n");
    }
    if (!text && typeof result.text === "string") text = result.text;
    if (!text) {
      try { text = JSON.stringify(result); } catch { text = ""; }
    }
  }

  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

function effectiveReasoningLevel() {
  return (state.reasoningLevel || state.defaults.reasoning || "off").toLowerCase();
}

function effectiveVerboseLevel() {
  return (state.verboseLevel || state.defaults.verbose || "off").toLowerCase();
}

function shouldShowThinkingInStream() {
  return effectiveReasoningLevel() === "stream";
}

function shouldShowToolEvents() {
  return effectiveVerboseLevel() !== "off";
}

function shouldShowToolOutput() {
  return effectiveVerboseLevel() === "full";
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

function resolveFinalAssistantText({ finalText, streamedText, errorMessage }) {
  const f = str(finalText).trim();
  if (f) return f;
  const s = str(streamedText).trim();
  if (s) return s;
  const e = str(errorMessage).trim();
  if (e) return e;
  return "(no output)";
}

function composeThinkingAndContent({ thinkingText, contentText, showThinking }) {
  const parts = [];
  if (showThinking && str(thinkingText).trim()) parts.push(`[thinking]\n${str(thinkingText).trim()}`);
  if (str(contentText).trim()) parts.push(str(contentText).trim());
  return parts.join("\n\n").trim();
}

function extractThinkingFromMessage(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
  }
  return parts.join("\n").trim();
}

function extractContentFromMessage(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) {
    if (message.stopReason === "error" && typeof message.errorMessage === "string") return message.errorMessage.trim();
    return "";
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      const t = block.text.trim();
      if (t) parts.push(t);
    }
  }
  if (parts.length > 0) return parts.join("\n").trim();
  if (message.stopReason === "error" && typeof message.errorMessage === "string") return message.errorMessage.trim();
  return "";
}

function extractTextBlocksAndSignals(message) {
  if (!message || typeof message !== "object") {
    return { textBlocks: [], sawNonTextContentBlocks: false };
  }
  const content = message.content;
  if (typeof content === "string") {
    const t = content.trim();
    return { textBlocks: t ? [t] : [], sawNonTextContentBlocks: false };
  }
  if (!Array.isArray(content)) {
    return { textBlocks: [], sawNonTextContentBlocks: false };
  }
  const textBlocks = [];
  let sawNonTextContentBlocks = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      const t = block.text.trim();
      if (t) textBlocks.push(t);
      continue;
    }
    if (typeof block.type === "string" && block.type !== "thinking") sawNonTextContentBlocks = true;
  }
  return { textBlocks, sawNonTextContentBlocks };
}

function isDroppedBoundaryTextBlockSubset({ streamedTextBlocks, finalTextBlocks }) {
  if (!Array.isArray(streamedTextBlocks) || !Array.isArray(finalTextBlocks)) return false;
  if (finalTextBlocks.length === 0 || finalTextBlocks.length >= streamedTextBlocks.length) return false;
  if (finalTextBlocks.every((block, i) => streamedTextBlocks[i] === block)) return true;
  const suffixStart = streamedTextBlocks.length - finalTextBlocks.length;
  return finalTextBlocks.every((block, i) => streamedTextBlocks[suffixStart + i] === block);
}

function shouldPreserveBoundaryDroppedText(params) {
  if (params.boundaryDropMode === "off") return false;
  const sawNonText = params.boundaryDropMode === "streamed-or-incoming"
    ? (params.streamedSawNonTextContentBlocks || params.incomingSawNonTextContentBlocks)
    : params.streamedSawNonTextContentBlocks;
  if (!sawNonText) return false;
  return isDroppedBoundaryTextBlockSubset({
    streamedTextBlocks: params.streamedTextBlocks,
    finalTextBlocks: params.nextContentBlocks,
  });
}

class UiStreamAssembler {
  constructor() {
    this.runs = new Map();
  }

  getOrCreateRun(runId) {
    let state = this.runs.get(runId);
    if (!state) {
      state = {
        thinkingText: "",
        contentText: "",
        contentBlocks: [],
        sawNonTextContentBlocks: false,
        displayText: "",
      };
      this.runs.set(runId, state);
    }
    return state;
  }

  updateRunState(state, message, showThinking, opts = {}) {
    const thinkingText = extractThinkingFromMessage(message);
    const contentText = extractContentFromMessage(message);
    const { textBlocks, sawNonTextContentBlocks } = extractTextBlocksAndSignals(message);

    if (thinkingText) state.thinkingText = thinkingText;
    if (contentText) {
      const nextContentBlocks = textBlocks.length > 0 ? textBlocks : [contentText];
      if (!shouldPreserveBoundaryDroppedText({
        boundaryDropMode: opts.boundaryDropMode || "off",
        streamedSawNonTextContentBlocks: state.sawNonTextContentBlocks,
        incomingSawNonTextContentBlocks: sawNonTextContentBlocks,
        streamedTextBlocks: state.contentBlocks,
        nextContentBlocks,
      })) {
        state.contentText = contentText;
        state.contentBlocks = nextContentBlocks;
      }
    }
    if (sawNonTextContentBlocks) state.sawNonTextContentBlocks = true;
    state.displayText = composeThinkingAndContent({
      thinkingText: state.thinkingText,
      contentText: state.contentText,
      showThinking,
    });
  }

  ingestDelta(runId, message, showThinking) {
    const state = this.getOrCreateRun(runId);
    const previousDisplayText = state.displayText;
    this.updateRunState(state, message, showThinking, { boundaryDropMode: "streamed-or-incoming" });
    if (!state.displayText || state.displayText === previousDisplayText) return null;
    return state.displayText;
  }

  finalize(runId, message, showThinking, errorMessage) {
    const state = this.getOrCreateRun(runId);
    const streamedDisplayText = state.displayText;
    const streamedTextBlocks = [...state.contentBlocks];
    const streamedSawNonTextContentBlocks = state.sawNonTextContentBlocks;

    this.updateRunState(state, message, showThinking, { boundaryDropMode: "streamed-only" });
    const finalComposed = state.displayText;
    const finalText = resolveFinalAssistantText({
      finalText: streamedSawNonTextContentBlocks && isDroppedBoundaryTextBlockSubset({
        streamedTextBlocks,
        finalTextBlocks: state.contentBlocks,
      })
        ? streamedDisplayText
        : finalComposed,
      streamedText: streamedDisplayText,
      errorMessage,
    });

    this.runs.delete(runId);
    return finalText;
  }

  drop(runId) {
    if (!runId) return;
    this.runs.delete(runId);
  }

  peek(runId, showThinking) {
    const state = this.runs.get(runId);
    if (!state) return null;
    return composeThinkingAndContent({
      thinkingText: state.thinkingText,
      contentText: state.contentText,
      showThinking,
    });
  }

  clear() {
    this.runs.clear();
  }
}

function noteFinalizedRun(runId) {
  if (!runId) return;
  state.finalizedRuns.set(runId, Date.now());
  if (state.finalizedRuns.size <= 200) return;
  const keepUntil = Date.now() - 10 * 60 * 1000;
  for (const [id, ts] of state.finalizedRuns) {
    if (state.finalizedRuns.size <= 150) break;
    if (ts < keepUntil) state.finalizedRuns.delete(id);
  }
  while (state.finalizedRuns.size > 150) {
    const oldest = state.finalizedRuns.keys().next().value;
    if (!oldest) break;
    state.finalizedRuns.delete(oldest);
  }
}

if (!state.streamAssembler) state.streamAssembler = new UiStreamAssembler();

function extractDeltaText(msg) {
  if (typeof msg === "string") return msg;
  if (!msg) return "";
  return extractContentFromMessage(msg) || str(msg.text);
}

function resolveStreamSession(payload) {
  const sk = str(payload.sessionKey);
  if (sk) {
    const prefix = agentPrefix();
    const normalized = sk.startsWith(prefix) ? sk.slice(prefix.length) : sk;
    if (state.streams.has(normalized)) return normalized;
    // sessionKey is explicit but no matching stream — don't guess
    // (prevents heartbeat/background events from leaking into the active tab)
    return null;
  }
  // No sessionKey — try runId, then single-stream fallback
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
    if (ss.runId) {
      state.runToSession.delete(ss.runId);
      if (state.streamAssembler) state.streamAssembler.drop(ss.runId);
    }
    state.streams.delete(sk);
  }
  if (sk === state.sessionKey) {
    hideBanner();
    state.streamEl = null;
    setSendButtonStopMode(false);
    ui.typingIndicator.classList.add("oc-hidden");
    const typingText = ui.typingIndicator.querySelector(".openclaw-typing-text");
    if (typingText) typingText.textContent = "Thinking";
  }
  // Always try to drain queue for the finished session (even if user switched tabs)
  setTimeout(() => processQueue(), 500);
}

function restoreStreamUI() {
  const ss = state.streams.get(state.sessionKey);
  if (!ss) return;
  setSendButtonStopMode(!ss.background);
  for (const item of ss.items) {
    if (item.type === "tool" && shouldShowToolEvents()) {
      appendToolCall(item.label, item.url, !!item.active, {
        toolCallId: item.id,
        detail: shouldShowToolOutput() ? (item.detail || "") : "",
        isError: !!item.isError,
      });
    }
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
  if (!visibleText) {
    if (state.streamEl) {
      state.streamEl.remove();
      state.streamEl = null;
    }
    return;
  }
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

// ─── Gateway Event Handlers ─────────────────────────────────────────

function handleGatewayEvent(msg) {
  if (!msg.event) return;

  if (msg.event === "chat") {
    handleChatEvent(msg.payload);
  } else if (msg.event === "stream" || msg.event === "agent") {
    handleStreamEvent(msg.payload);
  }
}

function matchActiveSessionKey(payload) {
  const sk = str(payload.sessionKey);
  if (!sk) return null;
  const prefix = agentPrefix();
  const active = state.sessionKey;
  if (sk === active || sk === `${prefix}${active}` || sk.endsWith(`:${active}`)) return active;
  return null;
}

function getToolEntry(ss, toolCallId) {
  if (!ss?.items) return null;
  if (toolCallId) {
    for (let i = ss.items.length - 1; i >= 0; i--) {
      const item = ss.items[i];
      if (item?.type === "tool" && item.id === toolCallId) return item;
    }
  }
  for (let i = ss.items.length - 1; i >= 0; i--) {
    const item = ss.items[i];
    if (item?.type === "tool" && item.active) return item;
  }
  return null;
}

function fallbackStatusLabel(data, phase) {
  const selected = [str(data?.selectedProvider), str(data?.selectedModel)].filter(Boolean).join("/");
  const active = [str(data?.activeProvider, str(data?.toProvider)), str(data?.activeModel, str(data?.toModel))].filter(Boolean).join("/");
  const reason = str(data?.reasonSummary, str(data?.reason));
  if (phase === "fallback_cleared") {
    return selected ? `✅ Primary model restored (${selected})` : "✅ Primary model restored";
  }
  const target = active || selected || "alternate model";
  return reason
    ? `↪️ Fallback to ${target} (${reason})`
    : `↪️ Fallback to ${target}`;
}

function handleStreamEvent(payload) {
  const stream = str(payload.stream);
  const eventState = str(payload.state);
  const payloadData = payload.data;

  let sessionKey = resolveStreamSession(payload);
  let isActiveTab = sessionKey === state.sessionKey;

  if (!sessionKey || !state.streams.has(sessionKey)) {
    if (stream === "compaction" || eventState === "compacting") {
      const cPhase = str(payloadData?.phase);
      if (isActiveTab || !sessionKey) {
        if (cPhase === "end") setTimeout(() => hideBanner(), 2000);
        else showBanner("Compacting context...");
      }
    }
    // Auto-create stream for startup/reset events on active session
    // Mark as background so it doesn't block user sends
    const matched = matchActiveSessionKey(payload);
    if (matched && (stream === "tool" || stream === "lifecycle" || stream === "fallback" || eventState === "lifecycle")) {
      const runId = str(payload.runId, str(payloadData?.runId));
      const ss = {
        runId: runId || "startup-" + Date.now(),
        text: null,
        toolCalls: [],
        items: [],
        splitPoints: [],
        lastDeltaTime: 0,
        compactTimer: null,
        workingTimer: null,
        background: true,  // not user-initiated — don't block sending
      };
      state.streams.set(matched, ss);
      if (runId) state.runToSession.set(runId, matched);
      sessionKey = matched;
      isActiveTab = true;
      hideLoading(); // replace static "Loading…" with live tool activity
      // Don't set stop mode for background streams — user should still be able to send
    } else {
      return;
    }
  }

  const ss = state.streams.get(sessionKey);
  const incomingRunId = str(payload.runId, str(payloadData?.runId));
  if (incomingRunId) {
    ss.runId = incomingRunId;
    state.runToSession.set(incomingRunId, sessionKey);
  }

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
  const toolCallId = str(payloadData?.toolCallId, str(payload.toolCallId));

  if (stream === "fallback" || (stream === "lifecycle" && (phase === "fallback" || phase === "fallback_cleared"))) {
    const label = fallbackStatusLabel(payloadData, phase);
    const fallbackId = `fallback-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    ss.items.push({ type: "tool", id: fallbackId, label, active: false, detail: "", isError: false });
    if (isActiveTab) {
      if (shouldShowToolEvents()) appendToolCall(label, undefined, false, { toolCallId: fallbackId });
      showBanner(label);
      setTimeout(() => hideBanner(), 3500);
    }
    return;
  }

  if ((stream === "tool" || toolName) && (phase === "start" || eventState === "tool_use")) {
    if (ss.compactTimer) { clearTimeout(ss.compactTimer); ss.compactTimer = null; }
    if (ss.workingTimer) { clearTimeout(ss.workingTimer); ss.workingTimer = null; }
    if (ss.text) ss.splitPoints.push(ss.text.length);

    const resolvedToolCallId = toolCallId || `tool-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const { label, url } = buildToolLabel(toolName, (payloadData?.args || payload.args));
    ss.toolCalls.push(label);
    const item = { type: "tool", id: resolvedToolCallId, label, url, active: true, detail: "", isError: false };
    ss.items.push(item);
    if (isActiveTab) {
      if (shouldShowToolEvents()) appendToolCall(label, url, true, { toolCallId: resolvedToolCallId });
      if (typingText) typingText.textContent = shouldShowToolEvents() ? label : "Thinking";
      ui.typingIndicator.classList.remove("oc-hidden");
    }
  } else if ((stream === "tool" || toolName) && phase === "update") {
    const detail = summarizeToolResult(payloadData?.partialResult);
    const item = getToolEntry(ss, toolCallId);
    if (item && detail) item.detail = detail;
    if (item) item.active = true;
    if (isActiveTab && shouldShowToolEvents() && shouldShowToolOutput() && item && detail) {
      appendToolCall(item.label, item.url, true, {
        toolCallId: item.id,
        detail,
        isError: !!item.isError,
      });
      ui.typingIndicator.classList.remove("oc-hidden");
      if (typingText) typingText.textContent = item.label;
    }
  } else if ((stream === "tool" || toolName) && phase === "result") {
    const item = getToolEntry(ss, toolCallId);
    const detail = shouldShowToolOutput() ? summarizeToolResult(payloadData?.result) : "";
    const isError = !!payloadData?.isError;
    if (item) {
      item.active = false;
      if (detail) item.detail = detail;
      item.isError = isError;
    }
    if (isActiveTab) {
      if (shouldShowToolEvents() && item) {
        appendToolCall(item.label, item.url, false, {
          toolCallId: item.id,
          detail: item.detail || "",
          isError,
        });
      } else {
        deactivateLastToolItem();
      }
      if (typingText) typingText.textContent = "Thinking";
      ui.typingIndicator.classList.remove("oc-hidden");
      scrollToBottom();
    }
  } else if (stream === "compaction" || eventState === "compacting") {
    if (phase === "end") {
      if (isActiveTab) setTimeout(() => hideBanner(), 2000);
    } else {
      ss.toolCalls.push("Compacting memory");
      ss.items.push({
        type: "tool",
        id: `compact-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        label: "Compacting memory",
        active: false,
        detail: "",
        isError: false,
      });
      if (isActiveTab) {
        appendToolCall("Compacting memory");
        ui.typingIndicator.classList.add("oc-hidden");
        showBanner("Compacting context...");
      }
    }
  } else if (stream === "lifecycle") {
    if (!isActiveTab) return;
    if (phase === "start") {
      if (typingText) typingText.textContent = "Thinking";
      ui.typingIndicator.classList.remove("oc-hidden");
    } else if (phase === "end") {
      if (typingText) typingText.textContent = "Thinking";
    } else if (phase === "error") {
      if (typingText) typingText.textContent = "Error";
      ui.typingIndicator.classList.remove("oc-hidden");
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
    } else {
      // Not the active tab or a known stream — check if it's any known tab (for unread tracking)
      const tabKey = resolveTabKey(payloadSk);
      if (tabKey) {
        const chatState = str(payload.state);
        if (chatState === "final") {
          const text = extractDeltaText(payload.message);
          const silent = !text || text.trim() === "HEARTBEAT_OK" || text.trim() === "NO_REPLY";
          if (!silent) {
            markUnread(tabKey);
            fireNotification(tabKey, text);
          }
          // Invalidate cache so next switch loads fresh history
          delete state.tabCache[tabKey];
        }
      }
      return;
    }
  }

  const ss = state.streams.get(eventSessionKey);
  const isActiveTab = eventSessionKey === state.sessionKey;
  const chatState = str(payload.state);
  const runId = str(payload.runId, str(ss?.runId));

  if (runId && state.finalizedRuns.has(runId) && (chatState === "delta" || chatState === "final")) {
    return;
  }

  if (!ss && (chatState === "final" || chatState === "aborted" || chatState === "error")) {
    if (runId) {
      noteFinalizedRun(runId);
      if (state.streamAssembler) state.streamAssembler.drop(runId);
    }
    if (isActiveTab) {
      hideBanner();
      loadChatHistory();
      // Drain queue — stream may have been cleaned up before final arrived
      setTimeout(() => processQueue(), 500);
    } else {
      // Non-active tab got a final without a stream — mark unread (unless heartbeat/silent)
      const text = extractDeltaText(payload.message);
      const silent = !text || text.trim() === "HEARTBEAT_OK" || text.trim() === "NO_REPLY";
      if (!silent) {
        markUnread(eventSessionKey);
        fireNotification(eventSessionKey, text);
      }
      delete state.tabCache[eventSessionKey];
    }
    return;
  }

  if (chatState === "delta" && ss) {
    if (ss.compactTimer) { clearTimeout(ss.compactTimer); ss.compactTimer = null; }
    if (ss.workingTimer) { clearTimeout(ss.workingTimer); ss.workingTimer = null; }
    ss.lastDeltaTime = Date.now();
    const text = runId && state.streamAssembler
      ? state.streamAssembler.ingestDelta(runId, payload.message, shouldShowThinkingInStream())
      : extractDeltaText(payload.message);
    if (text) {
      ss.text = text;
      if (isActiveTab) {
        ui.typingIndicator.classList.add("oc-hidden");
        hideBanner();
        updateStreamBubble();
      }
    }
  } else if (chatState === "final") {
    let finalText = "";
    if (runId && state.streamAssembler) {
      finalText = state.streamAssembler.finalize(runId, payload.message, shouldShowThinkingInStream(), str(payload.errorMessage));
    } else {
      finalText = extractDeltaText(payload.message) || str(payload.errorMessage);
    }
    if (finalText && finalText !== "(no output)") ss && (ss.text = finalText);
    if (runId) noteFinalizedRun(runId);

    // Upgrade tab title from assistant's response (better than user's choppy words)
    if (ss?.text) {
      const sk = eventSessionKey.startsWith(agentPrefix()) ? eventSessionKey.slice(agentPrefix().length) : eventSessionKey;
      upgradeTabTitle(sk, ss.text);
    }
    finishStream(eventSessionKey);
    if (isActiveTab) {
      loadChatHistory().then(() => updateContextMeter());
    } else {
      // Non-active tab finished streaming — mark unread (unless heartbeat/silent)
      const finalText = ss?.text || "";
      const silent = !finalText || finalText.trim() === "HEARTBEAT_OK" || finalText.trim() === "NO_REPLY";
      if (!silent) {
        markUnread(eventSessionKey);
        fireNotification(eventSessionKey, finalText);
      }
      delete state.tabCache[eventSessionKey];
    }
  } else if (chatState === "aborted") {
    if (runId && state.streamAssembler) {
      const partial = state.streamAssembler.finalize(runId, payload.message, shouldShowThinkingInStream(), str(payload.errorMessage));
      if (partial && partial !== "(no output)") ss && (ss.text = partial);
    }
    if (runId) noteFinalizedRun(runId);
    if (isActiveTab && ss?.text) {
      state.messages.push({ role: "assistant", text: ss.text, images: [], timestamp: Date.now() });
    }
    finishStream(eventSessionKey);
    if (isActiveTab) renderMessages();
  } else if (chatState === "error") {
    if (runId && state.streamAssembler) state.streamAssembler.drop(runId);
    if (runId) noteFinalizedRun(runId);
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

  // Request notification permission on first user interaction
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }

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
    background: false,
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
    if (state.streamAssembler) state.streamAssembler.drop(runId);
    setSendButtonStopMode(false);
    renderMessages();
  } finally {
    state.sending = false;
  }
}

async function abortMessage() {
  const sk = state.sessionKey;
  const ss = state.streams.get(sk);
  if (!ss) return;

  // Immediately save any partial text before cleanup
  if (ss.text) {
    state.messages.push({ role: "assistant", text: ss.text, images: [], timestamp: Date.now() });
  }

  // Clean up client-side UI right away (don't wait for server)
  finishStream(sk);
  renderMessages();

  // Send abort to server (best-effort)
  if (state.gateway?.connected) {
    try {
      await state.gateway.request("chat.abort", {
        sessionKey: `${agentPrefix()}${sk}`,
        runId: ss.runId,
      });
    } catch (err) {
      console.warn("chat.abort failed:", err);
    }
  }
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

/** Shared hidden sizer for autoResize — avoids reflowing the real textarea */
let _autoResizeSizer = null;
function autoResize() {
  const el = ui.messageInput;
  // Use a hidden off-screen sizer to measure the needed height.
  // This avoids collapsing the real textarea, which causes mobile layout vibration.
  if (!_autoResizeSizer) {
    _autoResizeSizer = document.createElement("textarea");
    _autoResizeSizer.setAttribute("aria-hidden", "true");
    _autoResizeSizer.setAttribute("tabindex", "-1");
    Object.assign(_autoResizeSizer.style, {
      position: "fixed",
      left: "-9999px",
      top: "0",
      visibility: "hidden",
      overflow: "hidden",
      height: "0",
      minHeight: "0",
      maxHeight: "none",
      padding: "0",
      border: "0",
      boxSizing: "border-box",
    });
    document.body.appendChild(_autoResizeSizer);
  }
  // Copy layout-affecting styles from the real textarea
  const cs = getComputedStyle(el);
  _autoResizeSizer.style.width = cs.width;
  _autoResizeSizer.style.font = cs.font;
  _autoResizeSizer.style.letterSpacing = cs.letterSpacing;
  _autoResizeSizer.style.wordSpacing = cs.wordSpacing;
  _autoResizeSizer.style.lineHeight = cs.lineHeight;
  _autoResizeSizer.style.padding = cs.padding;
  _autoResizeSizer.style.border = cs.border;
  _autoResizeSizer.style.boxSizing = cs.boxSizing;
  _autoResizeSizer.style.wordBreak = cs.wordBreak;
  _autoResizeSizer.style.overflowWrap = cs.overflowWrap;
  _autoResizeSizer.style.whiteSpace = cs.whiteSpace;
  _autoResizeSizer.value = el.value;
  _autoResizeSizer.style.height = "0";
  const newHeight = Math.min(_autoResizeSizer.scrollHeight, 120) + "px";
  // Only update if changed — avoids unnecessary reflow
  if (el.style.height !== newHeight) {
    el.style.height = newHeight;
  }
}

// ─── Input Handlers ──────────────────────────────────────────────────

function handleSendOrQueue() {
  const text = ui.messageInput.value.trim();
  const ss = state.streams.get(state.sessionKey);
  // Only treat as "streaming" if it's a user-initiated stream (not background/startup)
  let isStreaming = !!ss && !ss.background;

  // Safety: if stream exists but is stale (no delta for 60s), clean it up
  if (isStreaming) {
    if (ss.lastDeltaTime && (Date.now() - ss.lastDeltaTime > 60000)) {
      console.warn("[queue] Cleaning up stale stream (no delta for 60s+)");
      finishStream(state.sessionKey);
      isStreaming = false;
    }
  }

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

// ─── Code block event delegation (replaces inline handlers) ──────
ui.messagesContainer.addEventListener("click", (e) => {
  const copyBtn = e.target.closest(".oc-code-copy");
  if (!copyBtn) return;
  const pre = copyBtn.closest("pre");
  if (!pre) return;
  const code = pre.querySelector("code");
  if (!code) return;
  navigator.clipboard.writeText(code.innerText).then(() => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  }).catch(() => {});
});
ui.messagesContainer.addEventListener("mouseenter", (e) => {
  if (e.target.classList?.contains("oc-code-block")) {
    const btn = e.target.querySelector(".oc-code-copy");
    if (btn) btn.style.opacity = "1";
  }
}, true);
ui.messagesContainer.addEventListener("mouseleave", (e) => {
  if (e.target.classList?.contains("oc-code-block")) {
    const btn = e.target.querySelector(".oc-code-copy");
    if (btn) btn.style.opacity = "0";
  }
}, true);

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || window.innerWidth <= 768;
state.isMobile = isMobile;

// ─── Keep input pinned when virtual keyboard opens (iOS/Android) ────
if (isMobile && window.visualViewport) {
  const inputArea = document.querySelector('.openclaw-input-area');
  const chatContainer = document.getElementById('chat-container');
  let wasKeyboardOpen = false;
  const onViewportResize = () => {
    const vv = window.visualViewport;
    const keyboardOpen = vv.height < window.innerHeight * 0.75;
    if (keyboardOpen) {
      // Keyboard is open: constrain chat to visible viewport
      // iOS Safari/PWA shows a 44px form accessory bar (arrows + checkmark)
      // above the keyboard that overlaps our input — account for it
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const accessoryBarHeight = isIOS ? 44 : 0;
      inputArea.style.paddingBottom = accessoryBarHeight ? accessoryBarHeight + 'px' : '0px';
      chatContainer.style.height = vv.height + 'px';
      // Prevent browser from scrolling the page down (causes blank space on Android)
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      // Keep messages scrolled to bottom
      scrollToBottom();
    } else {
      // Keyboard closed: restore
      inputArea.style.paddingBottom = '';
      chatContainer.style.height = '';
      window.scrollTo(0, 0);
      if (wasKeyboardOpen) scrollToBottom();
    }
    wasKeyboardOpen = keyboardOpen;
  };
  window.visualViewport.addEventListener('resize', onViewportResize);
  window.visualViewport.addEventListener('scroll', onViewportResize);

  // Also catch focus events — Android sometimes scrolls before visualViewport fires
  ui.messageInput.addEventListener('focus', () => {
    setTimeout(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }, 100);
    setTimeout(() => {
      window.scrollTo(0, 0);
      scrollToBottom();
    }, 300);
  });
}

ui.messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    // Mobile: Enter always creates a newline (user taps Send button)
    // Desktop: Enter sends, Shift+Enter creates newline
    // Detect mobile dynamically — not the stale const from page load
    const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
      || ("ontouchstart" in window && window.innerWidth <= 1024);
    if (!mobile && !e.shiftKey) {
      e.preventDefault();
      handleSendOrQueue();
    }
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
  let swipeWrapper = null;

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

  // Collect all content elements below the header that should swipe together
  function getSwipeContentElements() {
    const chatArea = ui.messagesContainer.parentElement;
    if (!chatArea) return [];
    return Array.from(chatArea.children).filter(el => {
      // Skip the top bar and hamburger bar (header stays fixed)
      if (el.classList.contains("openclaw-top-bar")) return false;
      // Skip the incoming pane (translated separately)
      if (el.classList.contains("oc-swipe-incoming")) return false;
      return true;
    });
  }

  function createSwipeWrapper() {
    removeSwipeWrapper();
    const chatArea = ui.messagesContainer.parentElement;
    if (!chatArea) return null;

    const wrapper = document.createElement("div");
    wrapper.className = "oc-swipe-wrapper";
    wrapper.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column;position:relative;overflow:hidden;";

    // Move all content elements (messages, typing, input, banner) into the wrapper
    const contentEls = getSwipeContentElements();
    // Insert wrapper where the first content element is
    if (contentEls.length > 0) {
      chatArea.insertBefore(wrapper, contentEls[0]);
    } else {
      chatArea.appendChild(wrapper);
    }
    for (const el of contentEls) {
      wrapper.appendChild(el);
    }
    return wrapper;
  }

  function removeSwipeWrapper() {
    if (!swipeWrapper || !swipeWrapper.parentNode) { swipeWrapper = null; return; }
    const chatArea = swipeWrapper.parentNode;
    // Move children back to chatArea, before the wrapper
    while (swipeWrapper.firstChild) {
      chatArea.insertBefore(swipeWrapper.firstChild, swipeWrapper);
    }
    chatArea.removeChild(swipeWrapper);
    swipeWrapper = null;
    // Ensure top-bar stays first child (swipe DOM shuffling can displace it)
    const topBar = chatArea.querySelector(".openclaw-top-bar");
    if (topBar && topBar !== chatArea.firstElementChild) {
      chatArea.insertBefore(topBar, chatArea.firstElementChild);
    }
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

    // Move the entire swipe wrapper (messages + typing + input) as one unit
    if (swipeWrapper) {
      swipeWrapper.style.transform = `translateX(${clampedDelta}px)`;
    }

    // Move incoming pane (absolutely positioned inside the wrapper)
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
    if (swipeWrapper) {
      swipeWrapper.style.transform = "";
      swipeWrapper.style.transition = "";
      swipeWrapper.style.willChange = "";
    }
    removeIncomingPane();
    removeSwipeWrapper();
    const switcherLabel = document.getElementById("tab-switcher-label");
    if (switcherLabel) {
      switcherLabel.style.opacity = "";
      switcherLabel.style.transform = "";
      switcherLabel.style.transition = "";
    }
  }

  function animateSwipe(commit, deltaX, targetTab) {
    const w = getContainerWidth();
    const duration = commit ? "250ms" : "200ms";
    const easing = commit ? "cubic-bezier(0.2, 0.9, 0.3, 1)" : "cubic-bezier(0.4, 0, 0.2, 1)";
    const destX = commit ? (deltaX < 0 ? -w : w) : 0;

    if (swipeWrapper) {
      swipeWrapper.style.transition = `transform ${duration} ${easing}`;
      swipeWrapper.style.transform = `translateX(${destX}px)`;
    }

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

    const animTarget = swipeWrapper || ui.messagesContainer;
    const onEnd = () => {
      animTarget.removeEventListener("transitionend", onEnd);
      resetSwipeStyles();
      if (commit && targetTab) {
        switchTab(targetTab);
      }
    };
    animTarget.addEventListener("transitionend", onEnd);
    // Safety timeout in case transitionend doesn't fire
    setTimeout(onEnd, commit ? 300 : 250);
  }

  if (ui.messagesContainer) {
    // Container needs relative positioning for the incoming pane
    const chatArea = ui.messagesContainer.parentElement;

    ui.messagesContainer.addEventListener("touchstart", (e) => {
      if (!state.isMobile) return;
      if (e.target.closest("textarea, input, a, button, .openclaw-tool-item")) return;
      // Don't intercept swipes starting inside horizontally-scrollable code blocks
      const scrollable = e.target.closest("pre, code, .openclaw-file-viewer-body");
      if (scrollable && scrollable.scrollWidth > scrollable.clientWidth) return;
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
          // Create wrapper around all content below header
          swipeWrapper = createSwipeWrapper();
          if (swipeWrapper) {
            swipeWrapper.style.willChange = "transform";
            // Create incoming pane inside the wrapper
            const target = getSwipeTarget(deltaX);
            if (target) {
              incomingPane = createIncomingPane(target.tab, deltaX < 0);
              swipeWrapper.appendChild(incomingPane);
            }
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



  // Refresh server panel on connection change
  updateServerPanel();

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

    // Load dynamic sections
    loadAgentSwitcher();
    loadAgentFiles();
    loadCronJobs();

    // Store health data for server panel
    state._health = health || {};

    // Gather session list
    try {
      const sessResult = await state.gateway.request("sessions.list", {});
      const sessions = sessResult?.sessions || [];
      state._sessionCount = sessions.length;
      // Categorize sessions
      let tabs = 0, cron = 0, telegram = 0, subagent = 0, other = 0;
      for (const s of sessions) {
        const k = s.key || '';
        if (k.includes(':tab-') || k.endsWith(':main')) tabs++;
        else if (k.includes(':cron:')) cron++;
        else if (k.includes(':telegram:')) telegram++;
        else if (k.includes(':subagent:')) subagent++;
        else other++;
      }
      state._sessionBreakdown = { tabs, cron, telegram, subagent, other };
    } catch {
      state._sessionCount = state._cachedSessions?.length || 0;
      state._sessionBreakdown = null;
    }

    // Gather channel status
    try {
      const chResult = await state.gateway.request('channels.status', {});
      const channels = chResult?.channels || chResult || {};
      const entries = Object.entries(channels).filter(([, v]) => v && typeof v === 'object');
      state._channels = entries.map(([key, ch]) => ({
        name: ch.label || ch.name || key,
        connected: !!(ch.connected || ch.enabled || /^(connected|ok)$/i.test(ch.status || '') || /^(connected|ok)$/i.test(ch.state || '')),
      }));
    } catch { state._channels = []; }

    // Check for update — npm registry
    const currentVersion = state.serverVersion;
    state._latestVersion = null;
    if (currentVersion) {
      const snap = state.snapshot || {};
      const upd = snap.updateAvailable;
      if (upd?.latestVersion && upd.latestVersion !== currentVersion) {
        state._latestVersion = upd.latestVersion;
      }
      try {
        const resp = await fetch('https://registry.npmjs.org/openclaw/latest', { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const pkg = await resp.json();
          if (pkg.version && pkg.version !== currentVersion) {
            state._latestVersion = pkg.version;
          } else {
            state._latestVersion = null;
          }
        }
      } catch { /* use snapshot result */ }
    }

    // Render the server panel
    updateServerPanel();

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
    updateServerPanel(); // render what we have
    const dash = document.getElementById('dashboard');
    if (dash) {
      dash.classList.remove('dash-loading');
      dash.classList.add('dash-loaded');
    }
  }
}

function updateServerPanel() {
  const el = document.getElementById('hud-server-panel');
  if (!el) return;

  const connected = state.gateway?.connected;
  const version = state.serverVersion;
  const latest = state._latestVersion;
  const sessionCount = state._sessionCount || 0;
  const channels = state._channels || [];
  const connectedChannels = channels.filter(c => c.connected);

  // Host
  let hostDisplay = '—';
  let hostFull = '';
  if (state.gatewayUrl) {
    try {
      const hostname = new URL(state.gatewayUrl.replace(/^ws/, 'http')).hostname;
      hostDisplay = hostname.split('.')[0];
      hostFull = hostname;
    } catch {
      hostDisplay = state.gatewayUrl.replace(/^wss?:\/\//, '').replace(/\/+$/, '');
    }
  }

  // Uptime from health
  let uptimeDisplay = '';
  const health = state._health || {};
  if (health.uptime || health.uptimeSeconds) {
    const secs = health.uptime || health.uptimeSeconds;
    if (secs > 86400) uptimeDisplay = Math.floor(secs / 86400) + 'd ' + Math.floor((secs % 86400) / 3600) + 'h';
    else if (secs > 3600) uptimeDisplay = Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
    else uptimeDisplay = Math.floor(secs / 60) + 'm';
  }

  // Channel chips
  const channelChips = connectedChannels.length > 0
    ? connectedChannels.map(c => '<span class="hud-server-chip">' + escapeHtmlChat(c.name) + '</span>').join(' ')
    : '<span class="hud-server-chip hud-server-chip-none">webchat only</span>';

  // Version row
  let versionHtml = '';
  if (version) {
    versionHtml = '<div class="hud-settings-row">' +
      '<span class="hud-settings-label">Version</span>' +
      '<span class="hud-settings-value">v' + escapeHtmlChat(version);
    if (latest) {
      versionHtml += ' · <span class="hud-server-update-hint">v' + escapeHtmlChat(latest) + '</span>';
    } else {
      versionHtml += ' <span style="opacity:0.4">✓</span>';
    }
    versionHtml += '</span></div>';
  }

  let html =
    '<div class="hud-settings-row">' +
      '<span class="hud-settings-label">Host</span>' +
      '<span class="hud-settings-value hud-text-truncate" title="' + escapeHtmlChat(hostFull) + '">' + escapeHtmlChat(hostDisplay) + '</span>' +
    '</div>' +
    versionHtml +
    (uptimeDisplay ? '<div class="hud-settings-row"><span class="hud-settings-label">Uptime</span><span class="hud-settings-value">' + uptimeDisplay + '</span></div>' : '');

  // Session breakdown — grouped into active vs background
  const bd = state._sessionBreakdown;

  if (bd) {
    // Active conversations
    const activeParts = [];
    if (bd.tabs) activeParts.push(bd.tabs + ' webchat');
    if (bd.telegram) activeParts.push(bd.telegram + ' telegram');
    const activeStr = activeParts.length ? activeParts.join(', ') : '0';

    // Background processes
    const bgParts = [];
    if (bd.cron) bgParts.push(bd.cron + ' cron');
    if (bd.subagent) bgParts.push(bd.subagent + ' sub-agent');
    if (bd.other) bgParts.push(bd.other + ' other');

    html +=
      '<div class="hud-settings-row">' +
        '<span class="hud-settings-label">Chats</span>' +
        '<span class="hud-settings-value">' + activeStr + '</span>' +
      '</div>';
    if (bgParts.length) {
      html +=
        '<div class="hud-settings-row">' +
          '<span class="hud-settings-label">Background</span>' +
          '<span class="hud-settings-value" style="opacity:0.6">' + bgParts.join(', ') + '</span>' +
        '</div>';
    }
  } else {
    html +=
      '<div class="hud-settings-row">' +
        '<span class="hud-settings-label">Sessions</span>' +
        '<span class="hud-settings-value">' + sessionCount + ' active</span>' +
      '</div>';
  } +
    '<div class="hud-settings-row">' +
      '<span class="hud-settings-label">Channels</span>' +
      '<span class="hud-settings-value hud-server-chips">' + channelChips + '</span>' +
    '</div>';

  // Update button (only if update available)
  if (latest) {
    html += '<button class="hud-defaults-apply" onclick="sendControlAction(\'Check for OpenClaw updates. If available, update and restart.\')">update to v' + escapeHtmlChat(latest) + '</button>';
  }

  html += '<div class="hud-settings-divider"></div>';

  // Action buttons
  html +=
    '<div class="hud-settings-actions">' +
      '<button class="hud-server-action" onclick="sendControlAction(\'Run openclaw doctor. Summarize results.\')" title="Health check">🩺 check-up</button>' +
      '<button class="hud-server-action" onclick="sendControlAction(\'Security audit: firewall, SSH, ports, updates. Brief summary.\')">🛡️ security</button>' +
      '<button class="hud-server-action" onclick="sendControlAction(\'Restart the gateway. Confirm when back.\')">restart</button>' +
    '</div>' +
    '<div class="hud-settings-actions">' +
      '<button class="hud-server-action" onclick="sendControlAction(\'Optimize my agent startup speed. Audit AGENTS.md startup sequence — remove instructions to re-read files already injected in the system prompt (SOUL.md, USER.md, TOOLS.md, IDENTITY.md, HEARTBEAT.md). Then check MEMORY.md size — if over 16k chars, restructure it: move deep project details to memory/projects/ files, keep concise summaries in MEMORY.md. Goal: MEMORY.md under 16k so it fits in the system prompt without truncation, eliminating the need to re-read it. Report what you changed and the before/after size.\')" title="Speed up session boot time">⚡ optimize</button>' +
      '<button class="hud-server-action" onclick="openTerminalPanel()" title="Open terminal">⌨ terminal</button>' +
      '<button class="hud-server-action" onclick="openTerminalWithCmd(\'journalctl -u openclaw --no-pager -n 50\')" title="View recent logs">📋 logs</button>' +
    '</div>' +
    '<div class="hud-settings-divider"></div>' +
    '<button class="hud-disconnect-btn" onclick="confirmDisconnect()">Disconnect</button>';

  el.innerHTML = html;
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

  // Simple toggle — no accordion, all sections independent
  const isOpen = !wasOpen;
  if (isOpen) el.classList.add('hud-open');
  else el.classList.remove('hud-open');

  // Remember open sections
  const openSections = JSON.parse(localStorage.getItem('openSectionsSet') || '[]');
  const set = new Set(openSections);
  if (isOpen) set.add(sectionId); else set.delete(sectionId);
  localStorage.setItem('openSectionsSet', JSON.stringify([...set]));
  // Keep legacy key for compat
  localStorage.setItem('openSection', isOpen ? sectionId : '');
}

function restoreCollapsibleState() {
  // Migrate from old formats
  const legacy = localStorage.getItem('openSections');
  if (legacy) localStorage.removeItem('openSections');
  localStorage.removeItem('browserPanelOpen');
  localStorage.removeItem('terminalPanelOpen');
  localStorage.removeItem('mindfeedPanelOpen');

  // Restore multiple open sections
  const openSet = JSON.parse(localStorage.getItem('openSectionsSet') || '[]');
  // Also check legacy single key
  const legacySingle = localStorage.getItem('openSection') || '';
  const allOpen = new Set([...openSet, ...(legacySingle ? [legacySingle] : [])]);

  for (const id of allOpen) {
    const el = document.querySelector(`.hud-collapsible[data-section="${id}"]`);
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
    const errP = document.createElement("p");
    errP.style.cssText = "color:var(--text-faint);text-align:center;padding:30px;";
    errP.textContent = `Failed to load: ${err.message || 'unknown error'}`;
    body.innerHTML = "";
    body.appendChild(errP);
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

const RESET_IDLE_MINUTES_OPTIONS = [60, 120, 240, 480, 720, 1440, 2880, 10080];
const HEARTBEAT_OPTIONS = [
  { value: "0m", label: "off" },
  { value: "30m", label: "30 min" },
  { value: "1h", label: "1 hour" },
  { value: "2h", label: "2 hours" },
  { value: "4h", label: "4 hours" },
];

// ─── AI Model panel (requires session reset) ────────────────────────
function updateDefaultsPanel() {
  const el = document.getElementById("hud-defaults-panel");
  const section = document.getElementById("hud-defaults-section");
  if (!el) return;
  const d = state.defaults;
  if (section) section.style.display = d.model ? "" : "none";
  if (!d.model) return;

  const pendingModel = state.pendingDefaults.model;
  const modelDisplay = shortModelName(pendingModel || d.model);
  const modelPending = pendingModel && pendingModel !== d.model;
  const pendingPrimary = pendingModel || d.model;
  const defaultFallbacks = normalizeFallbacks(d.fallbacks || [], d.model);
  const effectiveFallbacks = normalizeFallbacks(
    ("fallbacks" in state.pendingDefaults) ? state.pendingDefaults.fallbacks : defaultFallbacks,
    pendingPrimary
  );
  const fallbacksPending = "fallbacks" in state.pendingDefaults;
  const fallbackDisplay = effectiveFallbacks.length
    ? effectiveFallbacks.map(shortModelName).join(" → ")
    : "none";

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
      '<select class="hud-defaults-select" data-default-key="' + key + '"' + cls + '>' + optionsHtml + '</select>' +
    '</div>';
  }

  let html =
    '<div class="hud-defaults-row">' +
      '<span class="hud-defaults-label">Model</span>' +
      '<span class="hud-defaults-value hud-defaults-editable' + (modelPending ? ' hud-defaults-pending' : '') + '" id="hud-default-model">' + modelDisplay + '</span>' +
    '</div>' +
    '<div class="hud-defaults-row">' +
      '<span class="hud-defaults-label">Fallbacks</span>' +
      '<span class="hud-defaults-value hud-defaults-editable' + (fallbacksPending ? ' hud-defaults-pending' : '') + '" id="hud-default-fallbacks">' + fallbackDisplay + '</span>' +
    '</div>' +
    renderSelect("thinking", "Think") +
    renderSelect("verbose", "Verbose");

  html += '<div style="margin-top:6px;font-size:11px;line-height:1.35;color:var(--text-muted);opacity:0.85">Saved live. Affects new tabs. Current tab may keep its model override.</div>';

  if (hasModelPending()) {
    html += '<button class="hud-defaults-apply" id="hud-defaults-apply" onclick="applyPendingDefaults()">save</button>';
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

        // Keep fallback list valid if primary changes.
        const nextPrimary = state.pendingDefaults.model || d.model;
        const fallbackSource = ("fallbacks" in state.pendingDefaults)
          ? state.pendingDefaults.fallbacks
          : defaultFallbacks;
        const normalized = normalizeFallbacks(fallbackSource, nextPrimary);
        if (sameStringArray(normalized, defaultFallbacks)) {
          delete state.pendingDefaults.fallbacks;
        } else {
          state.pendingDefaults.fallbacks = normalized;
        }

        updateDefaultsPanel();
        updateBarControls();
        modal.remove();
      }
    });
  });

  // Wire up fallback click
  document.getElementById("hud-default-fallbacks")?.addEventListener("click", () => {
    openFallbackPicker({
      primary: state.pendingDefaults.model || d.model,
      current: effectiveFallbacks,
      onSave: (fallbacks, modal) => {
        const nextPrimary = state.pendingDefaults.model || d.model;
        const normalized = normalizeFallbacks(fallbacks, nextPrimary);
        if (sameStringArray(normalized, defaultFallbacks)) {
          delete state.pendingDefaults.fallbacks;
        } else {
          state.pendingDefaults.fallbacks = normalized;
        }
        updateDefaultsPanel();
        updateBarControls();
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

function hasModelPending() {
  return ["model", "fallbacks", "thinking", "verbose"].some(k => k in state.pendingDefaults);
}

// ─── Schedule panel (reset + heartbeat) ──────────────────────────────
function updateSchedulePanel() {
  const el = document.getElementById("hud-schedule-panel");
  if (!el) return;
  const d = state.defaults;

  const pendingResetMode = state.pendingDefaults.resetMode;
  const pendingResetAtHour = state.pendingDefaults.resetAtHour;
  const pendingResetIdle = state.pendingDefaults.resetIdleMinutes;
  const pendingHeartbeat = state.pendingDefaults.heartbeatEvery;

  const resetMode = (pendingResetMode ?? d.resetMode) === "idle" ? "idle" : "daily";
  const resetAtHour = Number.isFinite(Number(pendingResetAtHour ?? d.resetAtHour))
    ? Math.max(0, Math.min(23, Math.round(Number(pendingResetAtHour ?? d.resetAtHour))))
    : 4;
  const resetIdleMinutes = Number.isFinite(Number(pendingResetIdle ?? d.resetIdleMinutes)) && Number(pendingResetIdle ?? d.resetIdleMinutes) > 0
    ? Math.round(Number(pendingResetIdle ?? d.resetIdleMinutes))
    : 240;
  const heartbeatEvery = pendingHeartbeat ?? d.heartbeatEvery ?? "0m";

  const resetModePending = "resetMode" in state.pendingDefaults;
  const resetHourPending = "resetAtHour" in state.pendingDefaults;
  const resetIdlePending = "resetIdleMinutes" in state.pendingDefaults;
  const heartbeatPending = "heartbeatEvery" in state.pendingDefaults;

  const resetModeHtml =
    '<div class="hud-defaults-row">' +
      '<span class="hud-defaults-label">Session reset</span>' +
      '<select class="hud-defaults-select hud-schedule-select' + (resetModePending ? ' hud-defaults-pending' : '') + '" data-schedule-key="resetMode">' +
        '<option value="daily"' + (resetMode === 'daily' ? ' selected' : '') + '>daily</option>' +
        '<option value="idle"' + (resetMode === 'idle' ? ' selected' : '') + '>idle only</option>' +
      '</select>' +
    '</div>';

  const resetDetailHtml = resetMode === 'daily'
    ? '<div class="hud-defaults-row">' +
        '<span class="hud-defaults-label">Reset hour (UTC)</span>' +
        '<select class="hud-defaults-select hud-schedule-select' + (resetHourPending ? ' hud-defaults-pending' : '') + '" data-schedule-key="resetAtHour">' +
          Array.from({ length: 24 }, (_, h) => {
            const hh = String(h).padStart(2, '0') + ':00';
            return '<option value="' + h + '"' + (h === resetAtHour ? ' selected' : '') + '>' + hh + '</option>';
          }).join('') +
        '</select>' +
      '</div>'
    : '<div class="hud-defaults-row">' +
        '<span class="hud-defaults-label">Idle timeout</span>' +
        '<select class="hud-defaults-select hud-schedule-select' + (resetIdlePending ? ' hud-defaults-pending' : '') + '" data-schedule-key="resetIdleMinutes">' +
          RESET_IDLE_MINUTES_OPTIONS.map(mins => {
            const label = mins >= 1440
              ? (mins % 1440 === 0 ? (mins / 1440) + 'd' : mins + 'm')
              : mins + 'm';
            return '<option value="' + mins + '"' + (mins === resetIdleMinutes ? ' selected' : '') + '>' + label + '</option>';
          }).join('') +
        '</select>' +
      '</div>';

  const heartbeatHtml =
    '<div class="hud-defaults-row">' +
      '<span class="hud-defaults-label">Check-in</span>' +
      '<select class="hud-defaults-select hud-schedule-select' + (heartbeatPending ? ' hud-defaults-pending' : '') + '" data-schedule-key="heartbeatEvery">' +
        HEARTBEAT_OPTIONS.map(opt =>
          '<option value="' + opt.value + '"' + (opt.value === heartbeatEvery ? ' selected' : '') + '>' + opt.label + '</option>'
        ).join('') +
      '</select>' +
    '</div>';

  let html = resetModeHtml + resetDetailHtml +
    '<div class="hud-settings-divider" style="margin:6px 0"></div>' +
    heartbeatHtml;

  if (hasSchedulePending()) {
    html += '<button class="hud-defaults-apply" id="hud-schedule-apply" onclick="applyScheduleChanges()">save</button>';
  }

  el.innerHTML = html;

  // Wire up schedule selects
  el.querySelectorAll('.hud-schedule-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const key = sel.dataset.scheduleKey;
      const numericKeys = new Set(["resetAtHour", "resetIdleMinutes"]);
      const val = numericKeys.has(key) ? Number(sel.value) : sel.value;
      const cur = state.defaults[key];
      const same = numericKeys.has(key)
        ? Number(val) === Number(cur)
        : String(val ?? "") === String(cur ?? "");

      if (same) {
        delete state.pendingDefaults[key];
      } else {
        state.pendingDefaults[key] = val;
      }

      if (key === "resetMode") {
        if (val === "daily") delete state.pendingDefaults.resetIdleMinutes;
        if (val === "idle") delete state.pendingDefaults.resetAtHour;
      }

      updateSchedulePanel();
      updateBarControls();
    });
  });
}

function hasSchedulePending() {
  return ["resetMode", "resetAtHour", "resetIdleMinutes", "heartbeatEvery"].some(k => k in state.pendingDefaults);
}

async function applyScheduleChanges() {
  if (!hasSchedulePending() || !state.gateway?.connected) return;

  const applyBtn = document.getElementById("hud-schedule-apply");
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = "saving…"; }

  try {
    const getResult = await state.gateway.request("config.get", {});
    const hash = getResult?.hash || "";

    const rawPatch = {};

    // Reset config
    const hasResetPending = ["resetMode", "resetAtHour", "resetIdleMinutes"].some(k => k in state.pendingDefaults);
    if (hasResetPending) {
      const resetMode = (state.pendingDefaults.resetMode ?? state.defaults.resetMode) === "idle" ? "idle" : "daily";
      const resetAtHour = Number.isFinite(Number(state.pendingDefaults.resetAtHour ?? state.defaults.resetAtHour))
        ? Math.max(0, Math.min(23, Math.round(Number(state.pendingDefaults.resetAtHour ?? state.defaults.resetAtHour))))
        : 4;
      const resetIdleMinutes = Number.isFinite(Number(state.pendingDefaults.resetIdleMinutes ?? state.defaults.resetIdleMinutes)) && Number(state.pendingDefaults.resetIdleMinutes ?? state.defaults.resetIdleMinutes) > 0
        ? Math.round(Number(state.pendingDefaults.resetIdleMinutes ?? state.defaults.resetIdleMinutes))
        : 240;
      rawPatch.session = {
        reset: resetMode === "daily"
          ? { mode: "daily", atHour: resetAtHour }
          : { mode: "idle", idleMinutes: resetIdleMinutes }
      };
    }

    // Heartbeat config
    if ("heartbeatEvery" in state.pendingDefaults) {
      rawPatch.agents = { defaults: { heartbeat: { every: state.pendingDefaults.heartbeatEvery } } };
    }

    if (Object.keys(rawPatch).length === 0) {
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = "save"; }
      return;
    }

    const raw = JSON.stringify(rawPatch);
    // Schedule changes may trigger a gateway restart — prepare for it
    state.gatewayRestarting = true;
    await state.gateway.request("config.patch", { raw, baseHash: hash });

    // Update local state
    for (const key of ["resetMode", "resetAtHour", "resetIdleMinutes", "heartbeatEvery"]) {
      if (key in state.pendingDefaults) {
        state.defaults[key] = state.pendingDefaults[key];
        delete state.pendingDefaults[key];
      }
    }

    // If gateway didn't restart (no WS drop within 2s), clear the flag
    setTimeout(() => { state.gatewayRestarting = false; }, 2000);

    updateSchedulePanel();
    updateBarControls();
  } catch (err) {
    state.gatewayRestarting = false;
    console.warn("Failed to apply schedule:", err);
    if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = "save"; }
  }
}

function hasPendingDefaults() {
  return hasModelPending() || hasSchedulePending();
}

async function applyPendingDefaults() {
  if (!hasModelPending() || !state.gateway?.connected) return;

  const configKeys = {
    thinking: "thinkingDefault",
    verbose: "verboseDefault",
  };

  const applyBtn = document.getElementById("hud-defaults-apply");
  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = "saving…";
  }

  try {
    const getResult = await state.gateway.request("config.get", {});
    const hash = getResult?.hash || "";

    const agentDefaultsPatch = {};
    for (const [key, val] of Object.entries(state.pendingDefaults)) {
      if (configKeys[key]) agentDefaultsPatch[configKeys[key]] = val || null;
    }
    if (state.pendingDefaults.model || ("fallbacks" in state.pendingDefaults)) {
      const nextPrimary = state.pendingDefaults.model || state.defaults.model || "";
      const nextFallbacks = normalizeFallbacks(
        ("fallbacks" in state.pendingDefaults) ? state.pendingDefaults.fallbacks : state.defaults.fallbacks,
        nextPrimary
      );
      agentDefaultsPatch.model = {
        primary: nextPrimary,
        fallbacks: nextFallbacks,
      };
    }

    if (Object.keys(agentDefaultsPatch).length === 0) {
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = "save"; }
      return;
    }

    const raw = JSON.stringify({ agents: { defaults: agentDefaultsPatch } });
    state.gatewayRestarting = true;
    await state.gateway.request("config.patch", { raw, baseHash: hash });

    // Update local state
    for (const key of ["model", "fallbacks", "thinking", "verbose"]) {
      if (key in state.pendingDefaults) {
        state.defaults[key] = state.pendingDefaults[key];
        delete state.pendingDefaults[key];
      }
    }

    // Ensure local defaults stay normalized against current primary.
    state.defaults.fallbacks = normalizeFallbacks(state.defaults.fallbacks, state.defaults.model);

    // If gateway didn't restart within 2s, clear the flag
    setTimeout(() => { state.gatewayRestarting = false; }, 2000);

    await updateContextMeter();
    await renderTabs();
    updateDefaultsPanel();
    updateBarControls();
  } catch (err) {
    state.gatewayRestarting = false;
    hideLoading();
    console.warn("Failed to apply defaults:", err);
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = "save";
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
    if (btn) { btn.disabled = false; btn.textContent = 'save'; }
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

async function loadSubagents(prefetchedSessions) {
  const container = document.getElementById("hud-subagents-list");
  if (!container || !state.gateway?.connected) return;
  
  // Show searching state
  const current = container.querySelector('.hud-subagent-row');
  if (!current) container.innerHTML = '<div class="hud-empty-hint hud-searching">checking…</div>';
  
  try {
    let sessions;
    if (prefetchedSessions) {
      sessions = prefetchedSessions;
    } else {
      const result = await state.gateway.request("sessions.list", {});
      sessions = result?.sessions || [];
    }
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

async function confirmDisconnect() {
  const ok = await confirmClose('Disconnect?', 'This will unpair your device. You\'ll need to re-enter your gateway URL and token to reconnect.');
  if (!ok) return;
  document.getElementById('dash-disconnect-btn')?.click();
}

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

const MOBILE_DRAWER_BREAKPOINT = 768;           // <= this: dashboard is overlay drawer
const DESKTOP_EXPANDED_BREAKPOINT = 1200;       // > this: dashboard default expanded

function isMobileViewport() {
  return window.innerWidth <= MOBILE_DRAWER_BREAKPOINT;
}

function setDesktopDashboardCollapsed(collapsed) {
  const dashboard = document.getElementById('dashboard');
  if (!dashboard || isMobileViewport()) return;
  dashboard.classList.toggle('oc-collapsed', !!collapsed);
  updateDashboardToggleButtons();
}

function updateDashboardToggleButtons() {
  const collapsed = document.getElementById('dashboard')?.classList.contains('oc-collapsed');
  const dashBtn = document.getElementById('dash-menu-btn');
  const burgerBtn = document.getElementById('hamburger-dash-btn');
  if (dashBtn) {
    dashBtn.title = collapsed ? 'Show control panel' : 'Hide control panel';
  }
  if (burgerBtn) {
    burgerBtn.title = collapsed ? 'Show control panel' : 'Hide control panel';
  }
}

function openDashboard() {
  document.getElementById('dashboard')?.classList.add('open');
  document.getElementById('dashboard-overlay')?.classList.add('open');
  updateDashboardToggleButtons();
}

function closeDashboard() {
  document.getElementById('dashboard')?.classList.remove('open');
  document.getElementById('dashboard-overlay')?.classList.remove('open');
  updateDashboardToggleButtons();
}

// Dashboard event listeners (runs immediately)
(function initDashboard() {
  let lastDashMode = null; // "mobile" or "desktop"

  // Menu button: mobile opens drawer, desktop toggles collapsed side panel
  document.getElementById('dash-menu-btn')?.addEventListener('click', () => {
    const dash = document.getElementById('dashboard');
    if (isMobileViewport()) {
      if (dash?.classList.contains('open')) closeDashboard();
      else openDashboard();
      return;
    }
    const collapsed = dash?.classList.contains('oc-collapsed');
    setDesktopDashboardCollapsed(!collapsed);
  });

  // Hamburger bar dashboard button: same behavior as main menu button
  document.getElementById('hamburger-dash-btn')?.addEventListener('click', () => {
    const dash = document.getElementById('dashboard');
    if (isMobileViewport()) {
      if (dash?.classList.contains('open')) closeDashboard();
      else openDashboard();
      return;
    }
    const collapsed = dash?.classList.contains('oc-collapsed');
    setDesktopDashboardCollapsed(!collapsed);
  });

  // Overlay click to close
  document.getElementById('dashboard-overlay')?.addEventListener('click', closeDashboard);

  // Connect button — runs full bootstrap (not just connectToGateway)
  document.getElementById('dash-connect-btn')?.addEventListener('click', () => {
    const url = document.getElementById('dash-gateway-url')?.value.trim();
    const token = document.getElementById('dash-token')?.value.trim();
    if (!url || !token) return;
    state.gatewayUrl = url;
    state.token = token;
    localStorage.setItem('connection', JSON.stringify({ gatewayUrl: url, token: token }));
    startChat().catch(err => console.error('Connect failed:', err));
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

  // Responsive: simple rules
  // - Tabs:   <= MOBILE_TAB_MENU_BREAKPOINT => mobile tab switcher, else desktop tabs
  // - Panel:  <= MOBILE_DRAWER_BREAKPOINT => drawer (collapsed by default)
  //           >  MOBILE_DRAWER_BREAKPOINT => inline panel (collapsed by default on tablet,
  //                                          expanded by default on desktop > DESKTOP_EXPANDED_BREAKPOINT)
  function updateDashLayout(initial = false) {
    const width = window.innerWidth;
    const isMobile = isMobileViewport();
    const mode = isMobile ? 'mobile' : 'desktop';

    state.isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || isMobile;

    const menuBtn = document.getElementById('dash-menu-btn');
    const dashboard = document.getElementById('dashboard');
    const overlay = document.getElementById('dashboard-overlay');

    // Menu/toggle button is always available; CSS handles hamburger-specific hiding
    if (menuBtn) menuBtn.style.display = 'flex';

    if (mode === 'mobile') {
      // Drawer mode: collapsed by default
      dashboard?.classList.remove('oc-collapsed');
      if (initial || lastDashMode !== 'mobile') {
        dashboard?.classList.remove('open');
        overlay?.classList.remove('open');
      }
    } else {
      // Inline panel mode: default based on viewport class
      dashboard?.classList.remove('open');
      overlay?.classList.remove('open');

      if (initial || lastDashMode !== 'desktop') {
        const shouldBeExpandedByDefault = width > DESKTOP_EXPANDED_BREAKPOINT;
        dashboard?.classList.toggle('oc-collapsed', !shouldBeExpandedByDefault);
      }
    }

    lastDashMode = mode;
    updateTabMode(); // keep tab mode synced with viewport changes
    updateDashboardToggleButtons();
  }
  window.addEventListener('resize', () => updateDashLayout(false));
  updateDashLayout(true);
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

  const mobilePortal = document.getElementById('mobile-panel-portal');

  function setState(cfg, newState) {
    const el = document.getElementById(cfg.id);
    if (!el) return;
    const isMobile = window.innerWidth <= 768;
    const wasExpanded = el.classList.contains('hud-expanded') || el.classList.contains('hud-fullscreen');
    const willExpand = newState === 'medium' || newState === 'full';

    el.classList.remove('hud-open', 'hud-expanded', 'hud-fullscreen');
    if (newState !== 'closed') el.classList.add('hud-open');
    if (newState === 'medium') el.classList.add('hud-expanded');
    if (newState === 'full') el.classList.add('hud-fullscreen');

    // Mobile: move panel to/from portal to escape dashboard's transform
    if (isMobile && mobilePortal) {
      if (willExpand && !wasExpanded) {
        // Save original parent so we can move it back
        cfg._originalParent = el.parentNode;
        cfg._originalNext = el.nextSibling;
        mobilePortal.appendChild(el);
      } else if (!willExpand && wasExpanded) {
        // Move back to dashboard
        if (cfg._originalParent) {
          if (cfg._originalNext) {
            cfg._originalParent.insertBefore(el, cfg._originalNext);
          } else {
            cfg._originalParent.appendChild(el);
          }
        }
        cfg._originalParent = null;
        cfg._originalNext = null;
      }
    }

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
      // Simple toggle — no accordion
      setState(cfg, 'open');
      if (!cfg.iframe) preloadIframe(cfg);
      else if (cfg.iframe) { cfg.iframe.src = cfg.iframe.src; } // refresh on open
    } else {
      setState(cfg, 'closed');
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
    const mobile = state.isMobile;
    if (mobile) {
      // On mobile: open → fullscreen, fullscreen → open
      if (st === 'open' || st === 'medium') {
        setState(cfg, 'full');
        // Close mobile dashboard drawer so it doesn't sit behind
        const dash = document.querySelector('.dashboard');
        const overlay = document.getElementById('dashboard-overlay');
        dash?.classList.remove('open');
        overlay?.classList.remove('open');
      } else if (st === 'full') {
        setState(cfg, 'open');
      }
    } else {
      if (st === 'open') setState(cfg, 'medium');
      else if (st === 'medium') setState(cfg, 'full');
      else if (st === 'full') setState(cfg, 'open');
    }
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
  let mfOriginalParent = null, mfOriginalNext = null;

  function mfCollapse() {
    const widget = document.getElementById('mindfeed-widget');
    if (!widget) return;
    widget.classList.remove('hud-mindfeed-expanded');
    if (mfExpand) { mfExpand.textContent = '⤢'; mfExpand.title = 'Expand'; }
    backdrop?.classList.remove('visible');
    // Move back from portal on mobile
    if (mfOriginalParent && mobilePortal?.contains(widget)) {
      if (mfOriginalNext) mfOriginalParent.insertBefore(widget, mfOriginalNext);
      else mfOriginalParent.appendChild(widget);
    }
    mfOriginalParent = null;
    mfOriginalNext = null;
  }

  mfExpand?.addEventListener('click', (e) => {
    e.stopPropagation();
    const widget = document.getElementById('mindfeed-widget');
    if (!widget) return;
    const isExpanded = widget.classList.contains('hud-mindfeed-expanded');
    if (isExpanded) {
      mfCollapse();
    } else {
      // Move to portal on mobile to escape dashboard transform
      const isMobile = window.innerWidth <= 768;
      if (isMobile && mobilePortal) {
        mfOriginalParent = widget.parentNode;
        mfOriginalNext = widget.nextSibling;
        mobilePortal.appendChild(widget);
        // Close dashboard drawer
        const dash = document.querySelector('.dashboard');
        const overlay = document.getElementById('dashboard-overlay');
        dash?.classList.remove('open');
        overlay?.classList.remove('open');
      }
      widget.classList.add('hud-mindfeed-expanded');
      mfExpand.textContent = '⤓';
      mfExpand.title = 'Minimize';
      backdrop?.classList.add('visible');
    }
  });

  // Close button minimizes expanded mindfeed
  document.getElementById('mindfeed-close-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    mfCollapse();
  });

  // Backdrop click minimizes expanded mindfeed too
  const origBackdropClick = backdrop?.onclick;
  backdrop?.addEventListener('click', () => {
    const widget = document.getElementById('mindfeed-widget');
    if (widget?.classList.contains('hud-mindfeed-expanded')) {
      mfCollapse();
    }
  });
})();

// ─── Initialize ──────────────────────────────────────────────────────

initApp().catch((err) => {
  console.error("initApp failed:", err);
  // Show connect UI so the page isn't a blank white screen
  updateConnectionStatus(false);
  updateDashboard();
});

// Clean up any old service worker (was causing stale cache issues)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    if (regs.length > 0) {
      regs.forEach((r) => r.unregister());
    }
  });
}
