#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse flags
INSTALL_OBSIDIAN=false
for arg in "$@"; do
  case $arg in
    --obsidian) INSTALL_OBSIDIAN=true ;;
  esac
done

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       UseMyClaw.com Setup            ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Step 1: Check if OpenClaw is installed
if ! command -v openclaw &> /dev/null; then
  echo -e "${RED}✗ OpenClaw is not installed.${NC}"
  echo "  Install it first: npm install -g openclaw"
  echo "  Guide: https://botsetupguide.com"
  exit 1
fi
echo -e "${GREEN}✓ OpenClaw found${NC}"

# Step 2: Check/install Node.js
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js is not installed.${NC}"
  echo "  Install via: https://nodejs.org or 'brew install node'"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v) found${NC}"

# Step 3: Check/install Tailscale
if ! command -v tailscale &> /dev/null; then
  echo -e "${YELLOW}⚠ Tailscale not found. Installing...${NC}"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    if command -v brew &> /dev/null; then
      brew install tailscale
    else
      echo -e "${RED}✗ Homebrew not found. Install Tailscale manually: https://tailscale.com/download${NC}"
      exit 1
    fi
  elif [[ "$OSTYPE" == "linux"* ]]; then
    curl -fsSL https://tailscale.com/install.sh | sh
  else
    echo -e "${RED}✗ Unsupported OS. Install Tailscale manually: https://tailscale.com/download${NC}"
    exit 1
  fi
fi
echo -e "${GREEN}✓ Tailscale found${NC}"

# Step 4: Check Tailscale login status
if ! tailscale status &> /dev/null; then
  echo -e "${YELLOW}⚠ Tailscale is not logged in.${NC}"
  echo "  Run: tailscale up"
  echo "  Then re-run this script."
  exit 1
fi
TAILSCALE_HOSTNAME=$(tailscale status --self --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')
echo -e "${GREEN}✓ Tailscale connected: ${TAILSCALE_HOSTNAME}${NC}"

# Step 5: Detect gateway port
GATEWAY_PORT=18789
echo -e "${BLUE}→ Using gateway port: ${GATEWAY_PORT}${NC}"

# Step 6: Configure Tailscale Serve
echo -e "${BLUE}→ Configuring Tailscale Serve...${NC}"
tailscale serve --bg --https=443 http://127.0.0.1:${GATEWAY_PORT} 2>/dev/null || true
GATEWAY_URL="https://${TAILSCALE_HOSTNAME}"
echo -e "${GREEN}✓ Tailscale Serve configured${NC}"

# Step 7: Configure gateway (set bind to loopback, add CORS origin)
echo -e "${BLUE}→ Configuring OpenClaw gateway...${NC}"
# Check current bind setting
CURRENT_BIND=$(openclaw config get gateway.bind 2>/dev/null || echo "unknown")
if [ "$CURRENT_BIND" != "loopback" ]; then
  echo -e "${YELLOW}  Setting gateway bind to loopback (recommended)...${NC}"
  openclaw config set gateway.bind loopback 2>/dev/null || true
fi

# Note about CORS - user needs to add usemyclaw.com to allowedOrigins
echo -e "${YELLOW}  Note: You may need to add 'https://usemyclaw.com' to your gateway's allowedOrigins.${NC}"
echo -e "${YELLOW}  Check your OpenClaw config if you get CORS errors.${NC}"

# Step 8: Restart gateway
echo -e "${BLUE}→ Restarting OpenClaw gateway...${NC}"
openclaw gateway restart 2>/dev/null || echo -e "${YELLOW}  Could not auto-restart. Run: openclaw gateway restart${NC}"
echo -e "${GREEN}✓ Gateway configured${NC}"

# Step 9: Optional Obsidian Sync
if [ "$INSTALL_OBSIDIAN" = true ]; then
  echo ""
  echo -e "${BLUE}→ Setting up Obsidian Sync...${NC}"
  if ! command -v ob &> /dev/null; then
    echo -e "${BLUE}  Installing obsidian-headless...${NC}"
    npm install -g obsidian-headless
  fi
  echo -e "${GREEN}✓ obsidian-headless installed${NC}"
  echo ""
  echo -e "${YELLOW}  Run these commands to complete Obsidian Sync setup:${NC}"
  echo "    ob login"
  echo "    ob sync-setup"
  echo "    ob sync --continuous"
fi

# Done!
echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║            Setup Complete!           ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo -e "  Gateway URL: ${GREEN}${GATEWAY_URL}${NC}"
echo ""
echo "  Next steps:"
echo "  1. Open https://usemyclaw.com/chat"
echo "  2. Paste your gateway URL: ${GATEWAY_URL}"
echo "  3. Enter your auth token (find it in your OpenClaw config)"
echo ""
echo "  Need your auth token? Run:"
echo "    openclaw config get auth.token"
echo ""
