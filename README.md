# OpenClaw Chat

A Progressive Web App (PWA) for chatting with OpenClaw AI assistants via Tailscale.

🚀 **Live Demo:** https://openclaw-chat.vercel.app

## Features

- 🔐 **Ed25519 device authentication** - Secure device-based auth matching the OpenClaw protocol
- 🌐 **Tailscale support** - Connect to your gateway over Tailscale
- 💬 **Real-time streaming** - Live message streaming via WebSocket
- 📱 **Mobile-first** - Responsive design, installable as PWA
- 🔊 **TTS playback** - Audio playback for voice responses (coming soon)
- 🤖 **Agent switching** - Switch between multiple agents (coming soon)

## Quick Start

### 1. Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/humanitylabs-org/openclaw-chat)

Or manually:

```bash
git clone https://github.com/humanitylabs-org/openclaw-chat.git
cd openclaw-chat
vercel --prod
```

### 2. Connect to Your Gateway

1. Open the deployed app
2. Enter your gateway URL (e.g., `https://your-server.tail1234.ts.net`)
3. Paste your auth token (from `~/.openclaw/openclaw.json`)
4. Click "Connect"
5. Approve the device in your gateway's Control UI
6. Start chatting!

## How It Works

OpenClaw Chat uses the same protocol as the ObsidianClaw plugin:

1. **WebSocket connection** to your OpenClaw gateway
2. **Ed25519 challenge-response auth** for device approval
3. **Streaming message protocol** with delta updates
4. **Tool call indicators** for transparency

All credentials are stored **locally** in your browser. Nothing is sent to external servers.

## Development

```bash
# Clone the repo
git clone https://github.com/humanitylabs-org/openclaw-chat.git
cd openclaw-chat

# Serve locally (needs a simple HTTP server)
python3 -m http.server 8000
# or
npx http-server -p 8000

# Open http://localhost:8000
```

## Architecture

- **Pure HTML/CSS/JavaScript** - No build step required
- **WebCrypto API** - Native Ed25519 signature generation
- **localStorage** - Persistent device identity and connection
- **Service Worker** - Offline caching for PWA

## Ported from ObsidianClaw

This app ports core functionality from the [ObsidianClaw plugin](https://github.com/oscarhenrycollins/obsidianclaw):

- WebSocket client (`ws-client.ts` → `app.js`)
- Device authentication (`device-auth.ts` → `app.js`)
- Message rendering (`chat-view.ts` → `index.html` + `app.js`)
- Streaming handler (100% compatible)

Excluded Obsidian-specific features:
- File browser (no vault access)
- Multi-server support (v1 = single server only)
- Obsidian API integrations

## Testing

Test against your own OpenClaw gateway:

```bash
# Get your Tailscale gateway URL
tailscale status

# Get your token
cat ~/.openclaw/openclaw.json | grep '"token"'
```

Then enter these in the app's onboarding flow.

## Security

- **Device identity** stored in browser localStorage
- **Ed25519 keypair** generated on first use
- **Token never logged** or sent to third parties
- **All traffic via Tailscale** (optional but recommended)

## Roadmap

- [x] WebSocket connection
- [x] Ed25519 device auth
- [x] Message streaming
- [x] Chat history loading
- [ ] TTS audio playback
- [ ] Agent switcher UI
- [ ] Tool step indicators
- [ ] Message reactions
- [ ] Voice input
- [ ] Dark/light theme toggle

## License

MIT

## Credits

Built by Oscar Collins for [HumanityLabs](https://humanitylabs.org).

Based on the [OpenClaw](https://github.com/humanitylabs-org/openclaw) project.
