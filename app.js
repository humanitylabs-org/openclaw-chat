// OpenClaw Chat PWA
// Ported from ObsidianClaw plugin

// ─── Utilities ───────────────────────────────────────────────────────

function generateId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
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
      "pkcs8",
      privBytes,
      { name: "Ed25519" },
      false,
      ["sign"]
    );
    return {
      deviceId: data.deviceId,
      publicKey: data.publicKey,
      privateKey: data.privateKey,
      cryptoKey
    };
  }

  // Generate new Ed25519 keypair
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const deviceId = await sha256Hex(pubRaw);
  const publicKey = toBase64Url(pubRaw);
  const privateKey = toBase64Url(privPkcs8);

  const identity = { deviceId, publicKey, privateKey, cryptoKey: keyPair.privateKey };
  localStorage.setItem("deviceIdentity", JSON.stringify({
    deviceId,
    publicKey,
    privateKey
  }));

  return identity;
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
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
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
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    for (const [, t] of this.pendingTimeouts) clearTimeout(t);
    this.pendingTimeouts.clear();
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("client stopped"));
  }

  async request(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    const id = generateId();
    const msg = { type: "req", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("request timeout"));
        }
      }, 30000);
      this.pendingTimeouts.set(id, t);
      this.ws.send(JSON.stringify(msg));
    });
  }

  doConnect() {
    if (this.closed) return;

    const url = normalizeGatewayUrl(this.opts.url);
    if (!url) {
      console.error("Invalid gateway URL");
      return;
    }

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
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    const CLIENT_ID = "pwa-client";
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
          deviceId: identity.deviceId,
          clientId: CLIENT_ID,
          clientMode: CLIENT_MODE,
          role: ROLE,
          scopes: SCOPES,
          signedAtMs,
          token: this.opts.token ?? null,
          nonce,
        });
        const signature = await signDevicePayload(identity, payload);
        device = {
          id: identity.deviceId,
          publicKey: identity.publicKey,
          signature,
          signedAt: signedAtMs,
        };
        if (nonce) device.nonce = nonce;
      } catch (err) {
        console.error("Failed to sign device payload:", err);
      }
    }

    const msg = {
      type: "connect",
      client: { id: CLIENT_ID, mode: CLIENT_MODE },
      role: ROLE,
      scopes: SCOPES,
      auth,
      device,
    };
    this.ws?.send(JSON.stringify(msg));
  }

  handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    // Handle responses
    if (msg.type === "res") {
      const p = this.pending.get(msg.id);
      if (p) {
        const t = this.pendingTimeouts.get(msg.id);
        if (t) clearTimeout(t);
        this.pending.delete(msg.id);
        this.pendingTimeouts.delete(msg.id);
        if (msg.ok) {
          p.resolve(msg.payload);
        } else {
          p.reject(new Error(msg.error?.message || "request failed"));
        }
      }
      return;
    }

    // Handle hello
    if (msg.type === "hello") {
      this.backoffMs = 800;
      this.opts.onHello?.(msg.payload);
      return;
    }

    // Handle challenge for device approval
    if (msg.type === "challenge") {
      this.connectNonce = msg.payload?.nonce || null;
      this.queueConnect();
      return;
    }

    // Handle events
    if (msg.type === "event") {
      this.opts.onEvent?.(msg);
    }
  }
}

// ─── App State ───────────────────────────────────────────────────────

const state = {
  gatewayUrl: "",
  token: "",
  deviceIdentity: null,
  gateway: null,
  sessionKey: "main",
  agent: null,
  messages: [],
  currentStreamingMessage: null,
};

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
  agentEmoji: $("agent-emoji"),
  agentName: $("agent-name"),
  agentCreature: $("agent-creature"),
  connectionStatus: $("connection-status"),
  messagesContainer: $("messages"),
  messageInput: $("message-input"),
  sendBtn: $("send-btn"),
};

// ─── Onboarding Flow ─────────────────────────────────────────────────

async function initApp() {
  // Check if already connected
  const stored = localStorage.getItem("connection");
  if (stored) {
    const data = JSON.parse(stored);
    state.gatewayUrl = data.gatewayUrl;
    state.token = data.token;
    state.deviceIdentity = await getOrCreateDeviceIdentity();
    
    // Check if device is approved
    const approvalStatus = localStorage.getItem("deviceApproved");
    if (approvalStatus === "true") {
      await startChat();
      return;
    }
  }

  // Show onboarding
  ui.onboarding.style.display = "flex";
  ui.chatContainer.classList.remove("active");
}

ui.connectBtn.addEventListener("click", async () => {
  const gatewayUrl = ui.gatewayUrlInput.value.trim();
  const token = ui.tokenInput.value.trim();

  if (!gatewayUrl || !token) {
    showStatus("Please fill in both fields", "error");
    return;
  }

  ui.connectBtn.disabled = true;
  showStatus("Connecting...", "info");

  try {
    state.gatewayUrl = gatewayUrl;
    state.token = token;
    state.deviceIdentity = await getOrCreateDeviceIdentity();

    // Save connection
    localStorage.setItem("connection", JSON.stringify({ gatewayUrl, token }));

    // Connect to gateway
    await connectToGateway();

    // Show step 2 (device approval)
    ui.step1.classList.add("hidden");
    ui.step2.classList.remove("hidden");
    ui.requestId.textContent = state.deviceIdentity.deviceId.slice(0, 16);

    // Poll for device approval
    pollDeviceApproval();
  } catch (err) {
    console.error("Connection error:", err);
    showStatus("Connection failed: " + err.message, "error");
    ui.connectBtn.disabled = false;
  }
});

ui.startChatBtn.addEventListener("click", () => {
  startChat();
});

function showStatus(message, type) {
  ui.connectStatus.textContent = message;
  ui.connectStatus.className = `status-message ${type}`;
  ui.connectStatus.classList.remove("hidden");
}

async function connectToGateway() {
  return new Promise((resolve, reject) => {
    state.gateway = new GatewayClient({
      url: state.gatewayUrl,
      token: state.token,
      deviceIdentity: state.deviceIdentity,
      onHello: (payload) => {
        console.log("Connected to gateway:", payload);
        resolve();
      },
      onClose: (info) => {
        console.log("Gateway connection closed:", info);
        updateConnectionStatus(false);
      },
      onEvent: handleGatewayEvent,
    });

    state.gateway.start();

    // Timeout after 10 seconds
    setTimeout(() => reject(new Error("Connection timeout")), 10000);
  });
}

async function pollDeviceApproval() {
  const maxAttempts = 60; // 5 minutes (60 * 5s)
  let attempts = 0;

  const checkApproval = async () => {
    if (attempts >= maxAttempts) {
      showStatus("Approval timeout. Please try again.", "error");
      return;
    }

    try {
      const result = await state.gateway.request("device.status", {
        deviceId: state.deviceIdentity.deviceId,
      });

      if (result?.approved) {
        localStorage.setItem("deviceApproved", "true");
        ui.step2.classList.add("hidden");
        ui.step3.classList.remove("hidden");
        return;
      }
    } catch (err) {
      console.error("Device status check failed:", err);
    }

    attempts++;
    setTimeout(checkApproval, 5000); // Check every 5 seconds
  };

  checkApproval();
}

async function startChat() {
  ui.onboarding.style.display = "none";
  ui.chatContainer.classList.add("active");

  // Connect if not already connected
  if (!state.gateway || !state.gateway.connected) {
    state.deviceIdentity = await getOrCreateDeviceIdentity();
    await connectToGateway();
  }

  updateConnectionStatus(true);

  // Load agent info
  await loadAgentInfo();

  // Load chat history
  await loadChatHistory();
}

function updateConnectionStatus(connected) {
  ui.connectionStatus.textContent = connected ? "Connected" : "Disconnected";
  ui.connectionStatus.className = "connection-status" + (connected ? " connected" : "");
}

// ─── Chat Functions ──────────────────────────────────────────────────

async function loadAgentInfo() {
  try {
    const result = await state.gateway.request("agents.list");
    const agents = result?.agents || [];
    if (agents.length > 0) {
      state.agent = agents[0];
      ui.agentEmoji.textContent = state.agent.emoji || "🤖";
      ui.agentName.textContent = state.agent.name || "Assistant";
      ui.agentCreature.textContent = state.agent.creature || "AI assistant";
    }
  } catch (err) {
    console.error("Failed to load agent info:", err);
  }
}

async function loadChatHistory() {
  try {
    const result = await state.gateway.request("chat.history", {
      session: state.sessionKey,
      limit: 50,
    });

    const messages = result?.messages || [];
    state.messages = messages;
    renderMessages();
  } catch (err) {
    console.error("Failed to load chat history:", err);
  }
}

function renderMessages() {
  ui.messagesContainer.innerHTML = "";
  for (const msg of state.messages) {
    appendMessage(msg);
  }
  scrollToBottom();
}

function appendMessage(msg) {
  const div = document.createElement("div");
  div.className = `message ${msg.role}`;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  const content = document.createElement("div");
  content.className = "message-content";

  if (typeof msg.content === "string") {
    content.innerHTML = formatMarkdown(msg.content);
  } else if (Array.isArray(msg.content)) {
    // Handle content blocks
    for (const block of msg.content) {
      if (block.type === "text") {
        const p = document.createElement("p");
        p.textContent = block.text || "";
        content.appendChild(p);
      }
    }
  }

  bubble.appendChild(content);
  div.appendChild(bubble);
  ui.messagesContainer.appendChild(div);
}

function formatMarkdown(text) {
  // Very basic markdown formatting
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

function scrollToBottom() {
  ui.messagesContainer.scrollTop = ui.messagesContainer.scrollHeight;
}

// ─── Send Message ────────────────────────────────────────────────────

async function sendMessage(text) {
  if (!text.trim()) return;

  // Add user message
  const userMsg = {
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
  state.messages.push(userMsg);
  appendMessage(userMsg);

  // Clear input
  ui.messageInput.value = "";
  ui.sendBtn.disabled = true;

  // Create placeholder for assistant response
  const assistantMsg = {
    role: "assistant",
    content: "",
    timestamp: Date.now(),
  };
  state.messages.push(assistantMsg);
  state.currentStreamingMessage = assistantMsg;

  const msgDiv = document.createElement("div");
  msgDiv.className = "message assistant";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  const content = document.createElement("div");
  content.className = "message-content";
  bubble.appendChild(content);
  msgDiv.appendChild(bubble);
  ui.messagesContainer.appendChild(msgDiv);

  try {
    await state.gateway.request("chat.send", {
      session: state.sessionKey,
      message: text,
    });
  } catch (err) {
    console.error("Failed to send message:", err);
    content.textContent = "Error sending message: " + err.message;
  }

  ui.sendBtn.disabled = false;
}

function handleGatewayEvent(msg) {
  if (!msg.event) return;

  if (msg.event === "chat.message") {
    // Full message received
    const message = msg.payload;
    if (state.currentStreamingMessage) {
      state.currentStreamingMessage.content = message.content;
      state.currentStreamingMessage = null;
      renderMessages();
    }
  } else if (msg.event === "chat.delta") {
    // Streaming delta
    if (state.currentStreamingMessage && msg.payload?.delta) {
      if (typeof state.currentStreamingMessage.content === "string") {
        state.currentStreamingMessage.content += msg.payload.delta;
      } else {
        state.currentStreamingMessage.content = msg.payload.delta;
      }
      
      // Update the last message bubble
      const lastBubble = ui.messagesContainer.lastElementChild?.querySelector(".message-content");
      if (lastBubble) {
        lastBubble.innerHTML = formatMarkdown(state.currentStreamingMessage.content);
      }
      scrollToBottom();
    }
  } else if (msg.event === "chat.tool") {
    // Tool call indicator
    console.log("Tool call:", msg.payload);
  }
}

// ─── Input Handlers ──────────────────────────────────────────────────

ui.sendBtn.addEventListener("click", () => {
  sendMessage(ui.messageInput.value);
});

ui.messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(ui.messageInput.value);
  }
});

ui.messageInput.addEventListener("input", () => {
  // Auto-resize textarea
  ui.messageInput.style.height = "auto";
  ui.messageInput.style.height = ui.messageInput.scrollHeight + "px";
});

// ─── Initialize ──────────────────────────────────────────────────────

initApp();

// Register service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((err) => {
    console.error("Service worker registration failed:", err);
  });
}
