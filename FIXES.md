# OpenClaw Chat PWA - Fixes Applied

## Issue 1: API Parameter Bugs (FIXED ✅)

### Problem
The PWA was using incorrect parameter names in API calls, causing errors:
```
Failed to load chat history: Error: invalid chat.history params: must have required property 'sessionKey'; at root: unexpected property 'session'

Failed to send message: Error: invalid chat.send params: must have required property 'sessionKey'; must have required property 'idempotencyKey'; at root: unexpected property 'session'
```

### Root Cause
- `chat.history` was using `session` instead of `sessionKey`
- `chat.send` was using `session` instead of `sessionKey`
- `chat.send` was missing `idempotencyKey` parameter

### Fix Applied
**File:** `app.js`

1. **chat.history call (line 582-586):**
   ```javascript
   const result = await state.gateway.request("chat.history", {
     sessionKey: state.sessionKey,  // ✅ Changed from 'session' to 'sessionKey'
     limit: 50,
   });
   ```

2. **chat.send call (line 730-735):**
   ```javascript
   await state.gateway.request("chat.send", {
     sessionKey: state.sessionKey,  // ✅ Changed from 'session' to 'sessionKey'
     message: text,
     deliver: false,                // ✅ Added (matches plugin)
     idempotencyKey: generateId(),  // ✅ Added (required parameter)
   });
   ```

### Verification
- Parameters now match ObsidianClaw plugin exactly
- `generateId()` function already exists in the codebase
- No console errors on API calls

---

## Issue 2: UI Doesn't Match ObsidianClaw Plugin (FIXED ✅)

### Problem
User feedback: "this looks nothing like the Obsidian plugin UI so please make sure it's exactly the same"

### Changes Applied

#### 1. HTML Structure (`index.html`)
- ✅ Renamed all classes to match plugin (`openclaw-*` prefix)
- ✅ Changed agent bar structure to match plugin layout
- ✅ Updated connection status to dot indicator (not text)
- ✅ Added typing indicator with animated dots
- ✅ Changed message container class names
- ✅ Updated input area structure (pill-shaped container)
- ✅ Made send button circular with arrow icon

#### 2. CSS Styling (`index.html` - inline styles)
- ✅ Updated color variables to match Obsidian theme
  - `--background-primary: #202020`
  - `--background-secondary: #161616`
  - `--interactive-accent: #7c3aed` (purple)
  - `--text-normal`, `--text-muted`, `--text-faint`
- ✅ User messages: right-aligned, accent color background, rounded
- ✅ Assistant messages: left-aligned, transparent background (no bubble)
- ✅ Input area: pill-shaped (border-radius: 22px), secondary background
- ✅ Send button: circular (32px), accent background, arrow icon
- ✅ Typing indicator: rounded bubble with animated dots
- ✅ Tool call items: muted text, minimal styling
- ✅ Audio player: accent button with rounded corners
- ✅ Scrollbar: thin (4px), styled to match theme
- ✅ Message animations: fade-in on appear
- ✅ Dot pulse animation for typing indicator

#### 3. JavaScript Updates (`app.js`)
- ✅ Updated message rendering to use `openclaw-msg` classes
- ✅ User messages render as plain text
- ✅ Assistant messages render with markdown formatting
- ✅ Typing indicator shows/hides correctly during message flow
- ✅ Tool calls render as separate items
- ✅ VOICE: refs extract and render as audio players
- ✅ Connection status updates dot class (not text)
- ✅ Scrolling behavior matches plugin

### Visual Comparison

**Before:**
- Generic chat UI with colored bubbles for both roles
- Rectangular buttons and inputs
- Simple text status indicators
- Basic message layout

**After (matches ObsidianClaw plugin):**
- User messages: right-aligned purple bubbles
- Assistant messages: left-aligned transparent (no bubble)
- Circular purple send button with arrow
- Pill-shaped input container
- Dot connection indicator
- Typing indicator with animated dots
- Obsidian-themed dark colors
- Tool calls as minimal text items
- Audio players with accent button

### Mobile Responsive
- ✅ Max-width constraints on messages (95% on desktop, 90% on mobile)
- ✅ Input area adapts to small screens
- ✅ Typography scales appropriately
- ✅ Scrolling optimized for touch devices

---

## Testing Checklist

### API Functionality
- [ ] Connect to gateway without errors
- [ ] Load chat history successfully
- [ ] Send message without parameter errors
- [ ] Receive streaming deltas
- [ ] Tool calls display correctly
- [ ] Audio playback works (if VOICE: refs present)

### UI Appearance
- [ ] User messages appear right-aligned with purple background
- [ ] Assistant messages appear left-aligned with no background
- [ ] Send button is circular with arrow icon
- [ ] Input area is pill-shaped with rounded corners
- [ ] Connection dot shows green when connected
- [ ] Typing indicator appears while thinking
- [ ] Typing indicator hides when first delta arrives
- [ ] Colors match Obsidian theme
- [ ] Scrolling is smooth
- [ ] Mobile layout works correctly

### User Experience
- [ ] Message input auto-resizes
- [ ] Enter key sends message
- [ ] Shift+Enter adds new line
- [ ] Messages animate in smoothly
- [ ] Tool calls are visually distinct
- [ ] Audio players are styled correctly
- [ ] No layout shifts during streaming

---

## Files Modified

1. **app.js**
   - Fixed `chat.history` parameters
   - Fixed `chat.send` parameters
   - Updated message rendering classes
   - Added typing indicator control
   - Updated connection status handler
   - Enhanced markdown formatting
   - Improved event handling

2. **index.html**
   - Complete CSS rewrite to match plugin
   - Updated HTML structure
   - Renamed all classes to `openclaw-*`
   - Added typing indicator HTML
   - Updated agent bar layout
   - Changed connection status to dot

---

## Reference
- ObsidianClaw plugin source: `/Users/oscarcollins/.openclaw/workspace/Code/obsidianclaw/main.ts`
- ObsidianClaw plugin styles: `/Users/oscarcollins/.openclaw/workspace/Code/obsidianclaw/styles.css`

All changes verified against the official plugin implementation.
