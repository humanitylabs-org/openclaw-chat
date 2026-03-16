# Task: Rebuild usemyclaw.com - Kill File Server, Add Control Panel

## Overview
Rebuild the app from a 3-panel file-browser-centric layout to a 2-panel control-center layout. Remove all file server dependencies. Add a Control Panel section with gateway management actions.

## CRITICAL RULES
- Do NOT change the landing page section (`#landing` div and all its contents). It must remain exactly as-is.
- Do NOT change the landing page CSS in theme.css (everything under the "Landing Page" comment block).
- Do NOT change the inline `<script>` at the bottom that handles landing vs app switching.
- Keep the same design system: IBM Plex Sans/Mono, monochrome (#0B0B0D bg, #F2F2F2 accent), dark theme.
- Keep the existing WebSocket connection, device auth, chat functionality, tabs, model picker, streaming, attachments, voice playback - all of that stays.
- The chat is the core. Don't break it.

## What to REMOVE
1. **file-server.js** - delete entirely
2. **workspace.js** - delete entirely (this is the file tree, editor, file server connection, panel swipe system)
3. **All file-server related code in app.js** - `onChatConnected`, file server URL derivation, etc.
4. **Three-panel layout** (tree panel, editor panel, chat panel) - replace with new layout
5. **Panel dots navigation** (the 3 dots at bottom for mobile swipe between panels)
6. **Editor panel** - tab bar, toolbar, textarea editor, markdown preview, all editor CSS
7. **File tree panel** - tree search, tree content, tree items, tree settings with file server connection
8. **Onboarding overlay** that asks for gateway URL (the `onboard-overlay` created by workspace.js) - the connection form will be in the new settings/control panel
9. **Settings popup** (`tree-settings-popup`) - replaced by Control Panel section
10. Remove `<script src="/workspace.js">` from index.html
11. Remove `initWorkspace()` call (it's in the inline script at bottom - replace with new init)

## What to ADD

### New Layout Structure

**Desktop (>768px):**
```
[Sidebar 56px] [Main Content area] [Chat Panel 420px]
```

**Mobile (<=768px):**
- Bottom tab bar with 3 icons: Chat, Profile, Control Panel  
- Swipe or tap to switch between sections
- Chat is the default/home view

### Sidebar (desktop only)
A narrow vertical bar on the left with icon buttons:
- 💬 Chat (default active)
- 👤 Profile (agent profile cards)  
- ⚙️ Control Panel
- Subtle connection status dot at bottom

Clicking a sidebar icon changes what shows in the Main Content area. On Chat, the main content area is hidden and chat takes full width (or main content shows a "Chat is on the right" state).

### Agent Profile Section (Phase 2 - stub it out for now)
For now, create a placeholder section that says "Agent Profile - Coming Soon" with a brief description: "View and edit your bot's personality, memory, and preferences."

The plan is to use `agents.files.get` to fetch SOUL.md, USER.md, TOOLS.md, MEMORY.md and display them as cards. But don't implement this yet - just the placeholder.

### Control Panel Section
A clean grid of action cards. Each action card has:
- An icon/emoji
- A title
- A brief description
- A button that sends a specific message to the chat

**Cards to include:**

1. **Gateway Status**
   - Show: connection status (green/red), gateway version (from hello payload if available)
   - No action button, just info

2. **Restart Gateway**  
   - Button: "Restart"
   - Sends to chat: "Restart the gateway now."
   - Description: "Restart your OpenClaw gateway. Takes a few seconds."

3. **Update OpenClaw**
   - Button: "Check for Updates"  
   - Sends to chat: "Check if there's a newer version of OpenClaw available. If there is, update and restart."
   - Description: "Check for and install the latest version."

4. **Run Doctor**
   - Button: "Run Doctor"
   - Sends to chat: "Run openclaw doctor and show me the results. If there are any issues, explain what they mean in simple terms."
   - Description: "Check for common issues with your setup."

5. **Fix Issues**
   - Button: "Fix Issues"
   - Sends to chat: "Run openclaw doctor --fix and then restart the gateway. Tell me what was fixed."
   - Description: "Automatically fix common problems."

6. **Connection Info**
   - Show: current gateway URL (from state), device ID (truncated)
   - A "Disconnect" button that clears localStorage and returns to landing page

When any action button is clicked:
1. Switch to showing the chat panel (on mobile, switch to chat tab; on desktop, the chat is already visible on the right)
2. Send the message as if the user typed it
3. The bot's response appears in chat naturally

### Connection/Settings
The connection setup (gateway URL + token) should be accessible from:
1. The Control Panel section (Connection Info card has a "Change Connection" option)
2. When not connected, the Control Panel shows a connection form prominently at the top

Don't use the old onboarding overlay approach. Keep it in-page within the Control Panel.

## Files to modify

### index.html
- Remove the old `#onboarding` section
- Remove the old `#chat-container` internal structure references to panels
- Build new layout: sidebar + main + chat
- Keep the `#landing` div and all landing page HTML completely unchanged
- Keep the bottom inline script but update it: instead of `initWorkspace()`, call a new init function
- Update script tags: remove workspace.js, bump app.js version

### app.js  
- Remove all `workspace` references and `onChatConnected` function
- Remove file-server URL derivation
- Add Control Panel logic: `renderControlPanel()`, `sendControlAction(message)`
- Add Agent Profile placeholder: `renderAgentProfile()`
- Add sidebar navigation logic
- Add new `initApp()` that doesn't depend on workspace.js
- The `updateConnectionStatus()` function should update the sidebar status dot
- Connection form logic moves into Control Panel section

### theme.css
- Remove all file tree CSS (.tree-panel, .tree-item, .tree-search, etc.)
- Remove all editor CSS (.editor-tab-bar, .editor-textarea, .editor-preview, etc.)  
- Remove panel-container desktop/mobile CSS
- Remove panel-dots CSS
- Remove panel-resizer CSS
- Remove onboard-overlay CSS
- Remove tree-settings-popup CSS
- Add sidebar CSS
- Add control panel card grid CSS
- Add agent profile placeholder CSS
- Add bottom tab bar CSS (mobile)
- DO NOT touch the Landing Page CSS section

### sw.js
- Bump cache version to v9
- Remove workspace.js and file-server.js from urlsToCache

### Other
- Delete file-server.js
- Delete workspace.js  
- Delete FILE-SERVER-API.md
- Keep all other files (icons, manifest, etc.)

## Design Guidelines

### Control Panel Cards
```css
/* Dark cards on slightly lighter bg */
background: rgba(255, 255, 255, 0.02);
border: 1px solid rgba(255, 255, 255, 0.04);
border-radius: 12px;
padding: 20px;
```

### Action Buttons in Cards
```css
/* Match the app's existing button style */
background: var(--interactive-accent); /* #F2F2F2 */
color: var(--text-on-accent); /* #0B0B0D */
border-radius: 8px;
padding: 8px 16px;
font-size: 13px;
font-weight: 500;
```

### Sidebar (desktop)
```css
width: 56px;
background: rgba(20, 20, 22, 0.85);
border-right: 1px solid rgba(255, 255, 255, 0.04);
/* Icon buttons: 40x40, centered, rounded */
```

### Mobile Bottom Tab Bar
```css
/* Similar to panel-dots but with labeled icons */
height: 52px;
background: rgba(22, 22, 22, 0.9);
backdrop-filter: blur(12px);
border-top: 1px solid rgba(255, 255, 255, 0.04);
/* 3 items: Chat, Profile, Controls */
/* Active item: accent color */
/* Hide when keyboard is open */
```

## Testing
After making all changes:
1. The landing page should still work (check in incognito)
2. Existing chat connections should still work (tabs, streaming, model picker, etc.)
3. Control panel buttons should send messages to chat
4. Mobile layout should have bottom tab bar
5. Desktop layout should have sidebar + chat
6. No references to file-server.js or workspace.js should remain
7. No console errors on load

## Commit message
"Rebuild app: kill file server, add control panel, new sidebar layout

- Removed file server dependency entirely (file-server.js, workspace.js)
- Removed file tree panel and markdown editor
- Added Control Panel with gateway management actions
- Added sidebar navigation (desktop) and bottom tab bar (mobile)
- Control panel actions send messages through chat
- Agent Profile section stubbed out for Phase 2
- Connection settings moved into Control Panel
- Simplified architecture: one WebSocket connection, no extra services"
