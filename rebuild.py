#!/usr/bin/env python3
"""Rebuild index.html according to TASK.md specifications."""

with open('index.html.bak', 'r') as f:
    lines = f.readlines()

# Find key line numbers (1-indexed in grep, 0-indexed here)
# We'll work with the content as a string for easier manipulation
content = ''.join(lines)

# === STEP 1: Remove CSS sections from <style> ===

import re

# Remove the Onboarding CSS section (lines 61-165 approximately)
# From "/* ─── Onboarding" to just before "/* ─── Chat Container"
content = re.sub(
    r'    /\* ─── Onboarding ─+.*?(?=    /\* ─── Chat Container)',
    '',
    content,
    flags=re.DOTALL
)

# Remove the mobile onboarding adjustment
content = re.sub(
    r'      \.onboarding \{ padding: 1rem; \}\n      \.onboarding-step \{ padding: 1\.5rem; \}\n',
    '',
    content
)

# Remove Three-Panel Layout through Panel dots sections
# From "/* ─── Three-Panel Layout" to just before "/* ─── File Tree"
content = re.sub(
    r'    /\* ─── Three-Panel Layout ─+.*?(?=    /\* ─── File Tree)',
    '',
    content,
    flags=re.DOTALL
)

# Remove File Tree section through Onboarding overlay
# From "/* ─── File Tree" to just before "/* ─── Editor Panel"
content = re.sub(
    r'    /\* ─── File Tree ─+.*?(?=    /\* ─── Editor Panel)',
    '',
    content,
    flags=re.DOTALL
)

# Remove Editor Panel section through editor-mode-indicator
# From "/* ─── Editor Panel" to just before "/* ─── Light Theme"
content = re.sub(
    r'    /\* ─── Editor Panel ─+.*?(?=    /\* ─── Light Theme)',
    '',
    content,
    flags=re.DOTALL
)

# In Light Theme section, remove tree/editor/panel/fs-dot/settings overrides
# Remove body[data-theme="light"] .tree-*, .editor-*, .panel-dots, .fs-dot lines
light_theme_removals = [
    r'    body\[data-theme="light"\] \.tree-panel \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.tree-item \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.tree-item:hover \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.tree-item\.active \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.tree-dir \.tree-name \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.tree-arrow \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.tree-arrow\.open \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.tree-icon-btn:hover,\n    body\[data-theme="light"\] \.tree-refresh-btn:hover \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.tree-search input \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.tree-search input:focus \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.tree-settings \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.tree-settings-input input \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.fs-dot \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.editor-textarea \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.editor-preview code \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.editor-preview \.code-block \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.editor-preview mark \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.panel-dots \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.panel-dots \.dot \{[^}]+\}\n',
    r'    body\[data-theme="light"\] \.panel-dots \.dot\.active \{[^}]+\}\n',
]

for pattern in light_theme_removals:
    content = re.sub(pattern, '', content)

# === STEP 2: Rebuild the .app div ===

# Extract the existing chat container inner HTML
chat_match = re.search(
    r'(<div id="chat-container" class="openclaw-chat-container">.*?</div>\s*</div>\s*</div>\s*</div>)',
    content,
    flags=re.DOTALL
)

# Let me find it more carefully - get everything from chat-container to its closing
# The chat container is inside the .app div
# Let me extract it by finding the markers
chat_start = content.find('<div id="chat-container" class="openclaw-chat-container">')
if chat_start == -1:
    print("ERROR: Could not find chat-container")
    exit(1)

# Find the closing of chat-container - it's followed by </div> for .app
# Count the divs to find the right closing
depth = 0
i = chat_start
chat_html = ''
started = False
while i < len(content):
    if content[i:i+4] == '<div':
        depth += 1
        started = True
    elif content[i:i+6] == '</div>':
        depth -= 1
        if started and depth == 0:
            chat_html = content[chat_start:i+6]
            break
    i += 1

print(f"Chat HTML length: {len(chat_html)}")

# Find the confirm overlay
confirm_start = content.find('<div class="oc-confirm-overlay"')
confirm_end = content.find('</div>', content.find('</div>', content.find('</div>', confirm_start) + 1) + 1) + 6
confirm_html = content[confirm_start:confirm_end]

# Build new .app div
new_app = '''  <div class="app" style="display:none;">
    <!-- Sidebar (desktop) -->
    <nav class="sidebar" id="sidebar">
      <div class="sidebar-top">
        <button class="sidebar-btn active" data-section="chat" title="Chat">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        </button>
        <button class="sidebar-btn" data-section="profile" title="Agent Profile">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </button>
        <button class="sidebar-btn" data-section="controls" title="Control Panel">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <div class="sidebar-bottom">
        <div class="sidebar-status" id="sidebar-status" title="Disconnected"></div>
      </div>
    </nav>

    <!-- Main content area -->
    <div class="main-content" id="main-content">
      <!-- Profile section (placeholder) -->
      <div class="section-view" id="section-profile" style="display:none;">
        <div class="section-scroll">
          <div class="section-header">
            <h2>Agent Profile</h2>
            <p>View and edit your bot's personality, memory, and preferences.</p>
          </div>
          <div class="coming-soon-card">
            <div class="coming-soon-icon">👤</div>
            <h3>Coming Soon</h3>
            <p>Personality cards, memory viewer, and visual settings editor are on the way.</p>
          </div>
        </div>
      </div>

      <!-- Control Panel section -->
      <div class="section-view" id="section-controls" style="display:none;">
        <div class="section-scroll">
          <div class="section-header">
            <h2>Control Panel</h2>
            <p>Manage your OpenClaw gateway and check on your setup.</p>
          </div>

          <!-- Connection form (shown when not connected) -->
          <div class="control-connect" id="control-connect" style="display:none;">
            <div class="control-card">
              <h3>🔗 Connect to your OpenClaw</h3>
              <p>Enter your gateway details to get started.</p>
              <div class="control-field">
                <label>Gateway URL</label>
                <input type="text" id="ctrl-gateway-url" placeholder="https://your-server.tail1234.ts.net">
              </div>
              <div class="control-field">
                <label>Auth Token</label>
                <input type="password" id="ctrl-token" placeholder="Paste your token">
              </div>
              <button class="control-action-btn" id="ctrl-connect-btn">Connect</button>
              <p class="control-hint">🔒 Stored locally. Never sent to our servers.</p>
            </div>
          </div>

          <!-- Controls grid (shown when connected) -->
          <div class="controls-grid" id="controls-grid">
            <div class="control-card control-status-card" id="control-status-card">
              <div class="control-card-header">
                <span class="control-card-icon">📡</span>
                <h3>Gateway Status</h3>
              </div>
              <div class="control-status-row">
                <span class="control-dot" id="control-dot"></span>
                <span id="control-status-text">Checking...</span>
              </div>
              <div class="control-meta" id="control-meta"></div>
            </div>

            <div class="control-card">
              <div class="control-card-header">
                <span class="control-card-icon">🔄</span>
                <h3>Restart Gateway</h3>
              </div>
              <p>Restart your OpenClaw gateway. Takes a few seconds.</p>
              <button class="control-action-btn" onclick="sendControlAction('Restart the OpenClaw gateway now. Confirm when it\\'s back up.')">Restart</button>
            </div>

            <div class="control-card">
              <div class="control-card-header">
                <span class="control-card-icon">⬆️</span>
                <h3>Update OpenClaw</h3>
              </div>
              <p>Check for and install the latest version.</p>
              <button class="control-action-btn" onclick="sendControlAction('Check if there\\'s a newer version of OpenClaw available. If there is, update it and restart the gateway. Tell me what version I was on and what I updated to.')">Check for Updates</button>
            </div>

            <div class="control-card">
              <div class="control-card-header">
                <span class="control-card-icon">🩺</span>
                <h3>Run Doctor</h3>
              </div>
              <p>Check for common issues with your setup.</p>
              <button class="control-action-btn" onclick="sendControlAction('Run openclaw doctor and show me the results. If there are any issues, explain what they mean in simple terms.')">Run Doctor</button>
            </div>

            <div class="control-card">
              <div class="control-card-header">
                <span class="control-card-icon">🔧</span>
                <h3>Fix Issues</h3>
              </div>
              <p>Automatically fix common problems.</p>
              <button class="control-action-btn" onclick="sendControlAction('Run openclaw doctor --fix and then restart the gateway. Tell me what was fixed.')">Fix Issues</button>
            </div>

            <div class="control-card">
              <div class="control-card-header">
                <span class="control-card-icon">🔑</span>
                <h3>Connection Info</h3>
              </div>
              <div class="control-info-row" id="control-info-gateway"></div>
              <div class="control-info-row" id="control-info-device"></div>
              <button class="control-action-btn control-disconnect-btn" id="ctrl-disconnect-btn">Disconnect</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Chat container -->
    CHAT_PLACEHOLDER

    <!-- Mobile bottom tab bar -->
    <div class="mobile-tab-bar" id="mobile-tab-bar">
      <button class="mobile-tab active" data-section="chat">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <span>Chat</span>
      </button>
      <button class="mobile-tab" data-section="profile">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>Profile</span>
      </button>
      <button class="mobile-tab" data-section="controls">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        <span>Controls</span>
      </button>
    </div>
  </div>'''

new_app = new_app.replace('CHAT_PLACEHOLDER', chat_html)

# Replace the old .app div with the new one
# Find the old .app div start and end
app_start = content.find('  <div class="app" style="display:none;">')
# Find the closing </div> for .app - it's the one before the <script> tags
app_end_search = content.find('  <script src="/app.js')
# Go backwards to find the closing </div> of .app
app_end = content.rfind('</div>', app_start, app_end_search) + 6

old_app = content[app_start:app_end]
content = content[:app_start] + new_app + content[app_end:]

# === STEP 3: Update script tags ===
# Remove workspace.js script tag
content = content.replace('  <script src="/workspace.js?v=18"></script>\n', '')

# Update the bottom inline script - remove initWorkspace() call
content = content.replace(
    '''      function showApp() {
        landing.style.display = 'none';
        app.style.display = '';
        initWorkspace();
      }''',
    '''      function showApp() {
        landing.style.display = 'none';
        app.style.display = '';
      }'''
)

# Move confirm overlay inside .app div (it was after the scripts before)
# Actually looking at the original, the confirm overlay is AFTER the </script> tag
# Let's keep it where it is - it's a global overlay

# Clean up any double blank lines
while '\n\n\n' in content:
    content = content.replace('\n\n\n', '\n\n')

with open('index.html', 'w') as f:
    f.write(content)

print("index.html rebuilt successfully")
print(f"New size: {len(content)} bytes")
