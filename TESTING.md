# Testing Guide

## Local Testing Against OpenClaw Gateway

### Prerequisites

1. **OpenClaw Gateway Running**
   ```bash
   ps aux | grep openclaw-gateway
   ```
   Should show the gateway process running.

2. **Get Your Gateway URL**
   
   For local testing:
   ```bash
   # Check gateway port (default 18789)
   cat ~/.openclaw/openclaw.json | grep -A2 '"gateway"'
   ```
   
   For Tailscale:
   ```bash
   # Get your Tailscale IP
   tailscale status | grep $(hostname)
   ```

3. **Get Your Auth Token**
   ```bash
   cat ~/.openclaw/openclaw.json | grep '"token"' | tail -1
   ```

### Testing Steps

1. **Open the App**
   - Production: https://openclaw-chat.vercel.app
   - Local: Open `index.html` in browser (needs HTTP server)
     ```bash
     # Option 1: Python
     python3 -m http.server 8000
     
     # Option 2: Node.js
     npx http-server -p 8000
     
     # Then open http://localhost:8000
     ```

2. **Enter Connection Details**
   
   **For Local Testing:**
   - Gateway URL: `http://localhost:18789` or `http://127.0.0.1:18789`
   - Token: (paste from command above)
   
   **For Tailscale Testing:**
   - Gateway URL: `https://your-machine.tailXXXX.ts.net` (your Tailscale hostname)
   - Token: (same token)
   
   **For Remote Testing:**
   - Gateway URL: `https://your-server.tail1234.ts.net`
   - Token: (remote server token)

3. **Approve Device**
   - After clicking "Connect", you'll see a device approval request ID
   - Open the OpenClaw Control UI:
     ```bash
     # If running locally
     open http://localhost:18789
     
     # Or via Tailscale
     open https://your-machine.tailXXXX.ts.net
     ```
   - Navigate to the Devices page
   - Approve the pending device request

4. **Start Chatting**
   - Once approved, click "Open chat"
   - Send a test message: "Hello!"
   - Verify streaming works
   - Test TTS if available

## Success Criteria Checklist

- [ ] **PWA Installability**
  - Desktop: Click install icon in address bar
  - Mobile: "Add to Home Screen" option appears
  - App launches in standalone mode

- [ ] **Looks Identical to ObsidianClaw Plugin**
  - Chat bubbles match styling
  - Agent bar with emoji and name
  - Connection status indicator
  - Same color scheme (#1a1a1a background, #6366f1 accent)

- [ ] **WebSocket Connection**
  - Connects via Tailscale URL + token
  - Connection status shows "Connected" (green)
  - Reconnects automatically on disconnect
  - No errors in browser console

- [ ] **Message Streaming**
  - Messages stream character by character
  - Delta updates render correctly
  - Markdown formatting works (bold, italic, code)
  - Scrolls to bottom automatically

- [ ] **TTS Audio**
  - VOICE: references convert to Play buttons
  - Audio plays when clicked
  - URL constructed correctly from gateway URL

- [ ] **Mobile Responsive**
  - UI scales properly on small screens
  - Touch targets are adequate (44px min)
  - Keyboard doesn't break layout
  - Messages are readable

- [ ] **Onboarding Intuitive**
  - Clear instructions
  - URL validation
  - Error messages helpful
  - Approval flow clear

- [ ] **No Console Errors**
  - Open DevTools → Console
  - Should see connection logs but no errors
  - WebSocket connection successful

## Common Issues

### "Connection failed: Connection timeout"
- Check gateway is running: `ps aux | grep openclaw-gateway`
- Check port: `cat ~/.openclaw/openclaw.json | grep '"port"'`
- Check firewall: Gateway port must be accessible

### "Invalid gateway URL"
- Must start with http://, https://, ws://, or wss://
- For local: `http://localhost:18789`
- For Tailscale: `https://your-machine.tailXXXX.ts.net`

### Device approval never completes
- Check Control UI is accessible
- Make sure you're approving the correct device ID
- Check browser console for errors

### Messages don't stream
- Check WebSocket connection in Network tab
- Verify gateway version supports streaming
- Check for console errors

### TTS doesn't play
- Check VOICE: URL is constructed correctly
- Verify audio file exists on gateway
- Check browser autoplay policy (may need user interaction first)

## Testing on Mobile

1. **Deploy to Vercel** (already done: https://openclaw-chat.vercel.app)

2. **Access from Mobile**
   - Open URL on phone
   - Should see install prompt
   - Add to home screen

3. **Connect via Tailscale**
   - Install Tailscale on phone
   - Use Tailscale gateway URL
   - Test all features

## Testing Different Scenarios

### Scenario 1: First-time User
1. Fresh browser (incognito)
2. Enter invalid URL → should show error
3. Enter valid URL + token → should connect
4. Device approval flow → should work
5. Chat should load

### Scenario 2: Returning User
1. Close app
2. Reopen (should remember connection)
3. If device approved, should skip onboarding
4. Should load chat history

### Scenario 3: Offline/Reconnect
1. Disconnect network
2. Connection status → "Disconnected"
3. Reconnect network
4. Should auto-reconnect within ~15s
5. Messages should continue working

### Scenario 4: Multiple Messages
1. Send several messages quickly
2. All should queue and send
3. Responses should stream
4. No race conditions or duplicate messages

## Performance Testing

1. **Load Time**
   - Should be < 1s on good connection
   - Service worker caches assets

2. **Message Rendering**
   - Streaming should be smooth
   - No lag when appending text
   - Scrolling should be instant

3. **Memory Usage**
   - Open DevTools → Performance
   - Monitor memory during long session
   - Should not grow unbounded

## Security Testing

1. **Credentials**
   - Token stored in localStorage
   - Not visible in network requests (only in WS handshake)
   - Device keys stored securely

2. **HTTPS**
   - Vercel deployment uses HTTPS
   - WSS connection for secure WebSocket

3. **No Data Leaks**
   - Check Network tab
   - No external requests except to gateway
   - No analytics or tracking

## Browser Compatibility

Test on:
- [ ] Chrome/Edge (desktop)
- [ ] Firefox (desktop)
- [ ] Safari (desktop)
- [ ] Chrome (Android)
- [ ] Safari (iOS)

## Next Steps After Testing

1. Fix any bugs found
2. Add missing features (agent switcher, better TTS UI)
3. Improve error handling
4. Add loading states
5. Write E2E tests
