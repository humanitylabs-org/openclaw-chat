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
          nonce: nonce ?? undefined,
        };
      } catch (err) {
        console.error("Failed to sign device payload:", err);
      }
    }

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: CLIENT_ID,
        version: "0.1.0",
        platform: "web",
        mode: CLIENT_MODE,
      },
      role: ROLE,
      scopes: SCOPES,
      auth,
      device,
      caps: ["tool-events"],
    };

    this.request("connect", params)
      .then((payload) => {
        this.backoffMs = 800;
        this.opts.onHello?.(payload);
      })
      .catch(() => {
        this.ws?.close(4008, "connect failed");
      });
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

    // Handle events
    if (msg.type === "event") {
      // Handle challenge for device approval
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
  typingIndicator: $("typing-indicator"),
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

    // Show step 2 (device approval) before connecting
    ui.step1.classList.add("hidden");
    ui.step2.classList.remove("hidden");
    ui.requestId.textContent = state.deviceIdentity.deviceId.slice(0, 16);

    // Connect to gateway
    // If device is approved, onHello callback will advance to step 3
    // If not approved, connection will timeout or close with "pairing required"
    await connectToGateway();
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
    let helloReceived = false;

    state.gateway = new GatewayClient({
      url: state.gatewayUrl,
      token: state.token,
      deviceIdentity: state.deviceIdentity,
      onHello: (payload) => {
        console.log("Connected to gateway:", payload);
        helloReceived = true;
        
        // Device is approved if we received hello
        localStorage.setItem("deviceApproved", "true");
        
        // If in onboarding flow (step 2 visible), advance to step 3
        if (!ui.step2.classList.contains("hidden")) {
          ui.step2.classList.add("hidden");
          ui.step3.classList.remove("hidden");
        }
        
        resolve();
      },
      onClose: (info) => {
        console.log("Gateway connection closed:", info);
        updateConnectionStatus(false);
        
        // If we haven't received hello yet, this might be a pairing rejection
        if (!helloReceived && info.reason === "pairing required") {
          // Stay on step 2, show approval needed message
          showStatus("Device needs approval. Please approve in Control UI.", "info");
        }
      },
      onEvent: handleGatewayEvent,
    });

    state.gateway.start();

    // Timeout after 30 seconds (enough time for manual approval)
    setTimeout(() => {
      if (!helloReceived) {
        reject(new Error("Connection timeout - device may need approval"));
      }
    }, 30000);
  });
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
  if (connected) {
    ui.connectionStatus.classList.add("connected");
  } else {
    ui.connectionStatus.classList.remove("connected");
  }
}

// ─── Chat Functions ──────────────────────────────────────────────────

async function loadAgentInfo() {
  try {
    const result = await state.gateway.request("agents.list");
    const agents = result?.agents || [];
    
    if (agents.length > 0) {
      // Load saved agent ID or use first agent
      const savedAgentId = localStorage.getItem("activeAgentId");
      state.agent = agents.find(a => a.id === savedAgentId) || agents[0];
      
      ui.agentEmoji.textContent = state.agent.emoji || "🤖";
      ui.agentName.textContent = state.agent.name || "Assistant";
      ui.agentCreature.textContent = state.agent.creature || "AI assistant";
      
      // If multiple agents, make name clickable to switch
      if (agents.length > 1) {
        ui.agentName.style.cursor = "pointer";
        ui.agentName.style.textDecoration = "underline";
        ui.agentName.onclick = () => showAgentSwitcher(agents);
      }
    }
  } catch (err) {
    console.error("Failed to load agent info:", err);
  }
}

function showAgentSwitcher(agents) {
  const current = state.agent?.id;
  const options = agents.map(a => 
    `<div class="agent-option ${a.id === current ? 'active' : ''}" data-id="${a.id}">
      <span class="agent-emoji">${a.emoji || '🤖'}</span>
      <div>
        <div class="agent-name">${a.name || 'Assistant'}</div>
        <div class="agent-creature">${a.creature || 'AI assistant'}</div>
      </div>
      ${a.id === current ? '<span class="checkmark">✓</span>' : ''}
    </div>`
  ).join('');
  
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal">
      <h3>Switch Agent</h3>
      <div class="agent-list">${options}</div>
      <button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
    </div>
  `;
  
  // Add click handlers
  modal.querySelectorAll('.agent-option').forEach(el => {
    el.onclick = () => {
      const agentId = el.dataset.id;
      switchAgent(agents.find(a => a.id === agentId));
      modal.remove();
    };
  });
  
  document.body.appendChild(modal);
}

async function switchAgent(agent) {
  state.agent = agent;
  localStorage.setItem("activeAgentId", agent.id);
  
  ui.agentEmoji.textContent = agent.emoji || "🤖";
  ui.agentName.textContent = agent.name || "Assistant";
  ui.agentCreature.textContent = agent.creature || "AI assistant";
  
  // Reload chat history for new agent
  await loadChatHistory();
}

async function loadChatHistory() {
  try {
    const result = await state.gateway.request("chat.history", {
      sessionKey: state.sessionKey,
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
  const cls = msg.role === "user" ? "openclaw-msg-user" : "openclaw-msg-assistant";
  const bubble = document.createElement("div");
  bubble.className = `openclaw-msg ${cls}`;

  // Render content
  let displayText = "";
  if (typeof msg.content === "string") {
    displayText = msg.content;
  } else if (Array.isArray(msg.content)) {
    // Handle content blocks
    for (const block of msg.content) {
      if (block.type === "text") {
        displayText += (block.text || "");
      }
    }
  }

  if (displayText) {
    const textDiv = document.createElement("div");
    textDiv.className = "openclaw-msg-text";
    
    // Format markdown for assistant, plain text for user
    if (msg.role === "assistant") {
      textDiv.innerHTML = formatMarkdown(displayText);
    } else {
      textDiv.textContent = displayText;
    }
    
    bubble.appendChild(textDiv);
  }

  ui.messagesContainer.appendChild(bubble);
}

function formatMarkdown(text) {
  // Extract and remove VOICE: references (will be rendered separately)
  const voiceRefs = [];
  text = text.replace(/VOICE:([^\s]+)/g, (match, path) => {
    voiceRefs.push(path);
    return "";
  });

  // Very basic markdown formatting
  let formatted = text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");

  // Add audio players after text
  if (voiceRefs.length > 0) {
    for (const path of voiceRefs) {
      const audioUrl = constructAudioUrl(path);
      formatted += `<div class="openclaw-audio-player">
        <button class="openclaw-audio-play-btn" onclick="playTTS('${audioUrl}')">▶ Play audio</button>
      </div>`;
    }
  }

  return formatted;
}

function constructAudioUrl(path) {
  // Convert gateway URL to HTTP/HTTPS
  let baseUrl = state.gatewayUrl;
  if (baseUrl.startsWith("ws://")) {
    baseUrl = "http://" + baseUrl.slice(5);
  } else if (baseUrl.startsWith("wss://")) {
    baseUrl = "https://" + baseUrl.slice(6);
  }
  // Remove trailing slash and add path
  baseUrl = baseUrl.replace(/\/+$/, "");
  return `${baseUrl}/${path.replace(/^\/+/, "")}`;
}

// Global audio player
let currentAudio = null;

window.playTTS = function(url) {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  currentAudio = new Audio(url);
  currentAudio.play().catch(err => {
    console.error("Failed to play audio:", err);
    alert("Failed to play audio. Check console for details.");
  });
};

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

  // Show typing indicator
  ui.typingIndicator.classList.remove("hidden");
  scrollToBottom();

  // Create placeholder for assistant response
  const assistantMsg = {
    role: "assistant",
    content: "",
    timestamp: Date.now(),
  };
  state.messages.push(assistantMsg);
  state.currentStreamingMessage = assistantMsg;

  try {
    await state.gateway.request("chat.send", {
      sessionKey: state.sessionKey,
      message: text,
      deliver: false,
      idempotencyKey: generateId(),
    });
  } catch (err) {
    console.error("Failed to send message:", err);
    ui.typingIndicator.classList.add("hidden");
    assistantMsg.content = "Error sending message: " + err.message;
    renderMessages();
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
      ui.typingIndicator.classList.add("hidden");
      renderMessages();
    }
  } else if (msg.event === "chat.delta") {
    // Streaming delta
    if (state.currentStreamingMessage && msg.payload?.delta) {
      // Hide typing indicator on first delta
      ui.typingIndicator.classList.add("hidden");
      
      if (typeof state.currentStreamingMessage.content === "string") {
        state.currentStreamingMessage.content += msg.payload.delta;
      } else {
        state.currentStreamingMessage.content = msg.payload.delta;
      }
      
      // Update the last message bubble
      const lastBubble = ui.messagesContainer.lastElementChild;
      if (lastBubble) {
        const textDiv = lastBubble.querySelector(".openclaw-msg-text");
        if (textDiv) {
          textDiv.innerHTML = formatMarkdown(state.currentStreamingMessage.content);
        } else {
          const newTextDiv = document.createElement("div");
          newTextDiv.className = "openclaw-msg-text";
          newTextDiv.innerHTML = formatMarkdown(state.currentStreamingMessage.content);
          lastBubble.appendChild(newTextDiv);
        }
      }
      scrollToBottom();
    }
  } else if (msg.event === "chat.tool") {
    // Tool call indicator
    console.log("Tool call:", msg.payload);
    
    // Hide typing indicator
    ui.typingIndicator.classList.add("hidden");
    
    // Add tool indicator to UI
    const toolDiv = document.createElement("div");
    toolDiv.className = "openclaw-tool-item";
    toolDiv.textContent = `🔧 ${msg.payload?.name || "Tool call"}`;
    ui.messagesContainer.appendChild(toolDiv);
    scrollToBottom();
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
