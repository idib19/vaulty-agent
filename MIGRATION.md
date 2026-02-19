# Apply-Agent Migration Guide

## Context

The extension currently has two form-filling systems side by side:

| | Old system | New system |
|---|---|---|
| **Tab** | "Apply" | "Apply-agent" |
| **Architecture** | Heavy agent loop — multi-step LLM orchestration, job/status storage, backend dependency, overlay rendering, log system | Lightweight — single Claude API call maps profile → form fields, fills them, advances multi-step forms autonomously |
| **Backend required** | Yes (`web/` Next.js server) | No — direct Anthropic API call from the extension |
| **Entry point (background)** | `agentLoop()` triggered by `START_JOB` message | `aaRequestSnapshotAndFill()` triggered by `aa_start_fill` message |
| **Entry point (content)** | Large orchestration handlers | `aa_get_snapshot` + `aa_fill_fields` handlers (IIFE at bottom of `content.js`) |
| **Entry point (sidepanel)** | `tab-apply` div + all related JS in `sidepanel.js` | `tab-apply-agent` div + `aaSetStatus()` + Fill button handler in `sidepanel.js` |

The goal is to **delete the old system entirely** and promote the new one as the primary tab.

---

## What to delete

### 1. `sidepanel.html`

**Delete** the entire old Apply tab block (lines 22–71):
```html
<!-- Apply Tab -->
<div id="tab-apply" class="tab-content active">
  ...
</div>
```

**Then** rename the Apply-agent tab button and content div:
- Change `data-tab="apply-agent"` → `data-tab="apply"`
- Change `id="tab-apply-agent"` → `id="tab-apply"`
- Add `class="tab-content active"` to the new tab (make it the default)
- Update the tab button to be `class="tab active"` by default

---

### 2. `sidepanel.js`

**Delete** all of the following functions and event listeners (they all belong to the old Apply tab):

- `refreshUI()` — polls old job state from storage
- `updateLiveStep()` — renders old live step UI
- `prefillCurrentTabUrl()` — prefills URL input (old Apply tab only)
- Event listeners for: `#useCurrentTab`, `#start`, `#stop`, `#approve`, `#continueJob`, `#sendOtp`, `#sendPassword`
- The `chrome.storage.onChanged` listener that calls `updateLiveStep` (checks `agentLiveStep` in session storage)
- `loadLogs()`, `renderLogEntry()`, `formatActionSummary()`, `formatTime()`, `getActionIcon()`, `getActionTypeClass()`, `escapeHtml()`
- Event listeners for: `#refreshLogs`, `#clearLogs`, `#exportLogs`
- The init IIFE call to `refreshUI()`, `loadLogs()`, and `prefillCurrentTabUrl()`

**Keep:**
- `loadProfile()` and its save/clear handlers — used by the Profile tab
- `loadSettings()` and its save handler — used by the Settings tab
- The `chrome.storage.onChanged` listener that calls `refreshUI` on `LOGS_KEY` changes — **delete this one** since logs belong to old system
- The Copilot tab handlers — keep as-is
- The `showStatusMsg()`, `postJSON()`, `getApiBase()`, `uid()` helpers — evaluate case by case (most are only used by old Apply tab code; `showStatusMsg` is reused by Profile/Settings)
- The Apply-agent block at the bottom (`AA_STATUS_MAP`, `aaSetStatus`, message listener, Fill button handler) — **keep and promote**

**After cleanup**, rename all `aa`-prefixed identifiers to clean names:
- `aaSetStatus` → `setFillStatus`
- `AA_STATUS_MAP` → `FILL_STATUS_MAP`
- `aa-btn-fill` (HTML id) → `btn-fill`
- `aa-status-box` (HTML id) → `status-box`
- `aa-status-icon` (HTML id) → `status-icon`
- `aa-status-text` (HTML id) → `status-text`

Update `aaSetStatus()` references in the message listener and click handler accordingly.

---

### 3. `background.js`

**Delete** the old agent system — this is the largest deletion:

- `agentLoop()` function and everything it calls (lines ~945 to ~2228)
- `pendingUserResponses` map
- `globalPaused` flag
- `pendingTabSwitches` map
- `activeAgentTabs` set
- `sidePanelOpen` flag
- `cleanupOldPendingTabSwitches()`
- `addLog()` and log-related helpers
- The `chrome.tabs.onCreated` listener (tracks new tabs for Apply agent)
- The entire old `chrome.runtime.onMessage` listener (lines ~2228–2555) that handles: `START_JOB`, `STOP_JOB`, `RESUME_JOB`, `APPROVE`, `RESUME_AFTER_VERIFICATION`, `COPILOT_SUMMARIZE`, `SIDE_PANEL_OPENED`, `SIDE_PANEL_CLOSED`, `START_JOB_FROM_EXTERNAL`, etc.
- `startJobFromExternal()` function

**Keep:**
- `chrome.action.onClicked` listener — opens the side panel (still needed)
- `chrome.commands.onCommand` listener — hotkey to open side panel (still needed)
- `sleep()` helper — reused by Apply-agent
- The entire `APPLY-AGENT` block at the bottom (lines ~2556–2789) — **keep and promote**

**After cleanup**, strip the `aa` prefix from all Apply-agent identifiers:
- `aaSessions` → `sessions`
- `aaRequestSnapshotAndFill` → `requestSnapshotAndFill`
- `aaProcessSnapshot` → `processSnapshot`
- `aaCallClaude` → `callClaude`
- `aaBuildPrompt` → `buildPrompt`
- `aaParseMapping` → `parseMapping`
- `aaExtractFormHTML` → `extractFormHTML`
- `aaLoadProfile` → `loadProfile`
- `aaFlattenProfile` → `flattenProfile`
- `aaGetApiKey` → `getApiKey`
- `aaNotify` → `notifyPanel`
- `AA_CLAUDE_MODEL` → `CLAUDE_MODEL`
- `AA_CLAUDE_API_URL` → `CLAUDE_API_URL`
- `AA_MAX_STEPS` → `MAX_STEPS`
- Message types: `aa_start_fill` → `start_fill`, `aa_step_ready` → `step_ready`, `aa_fill_complete` → `fill_complete`, `aa_status_update` → `status_update`, `aa_get_snapshot` → `get_snapshot`, `aa_fill_fields` → `fill_fields`

Update all message type strings consistently across `background.js`, `content.js`, and `sidepanel.js`.

---

### 4. `content.js`

**Delete** everything above the `APPLY-AGENT` IIFE block that belongs to the old system:

- `injectOverlay()` IIFE — injects `mini-overlay.js` (old system visual layer)
- `highlightedElements` array and `pendingAskUserResponse`
- `vaultyRegistry`, `vaultyRegistryVersion`, `VAULTY_ID_ATTR`
- The entire `OBSERVATION_CONFIG` block and network idle tracking (`pendingRequests`, `lastActivityTimestamp`, patched `fetch`/`XHR`)
- All old message handlers in the main `chrome.runtime.onMessage.addListener`: `OBSERVE`, `FILL`, `CLICK`, `SELECT`, `CHECK`, `NAVIGATE`, `WAIT_FOR`, `EXTRACT`, `ASK_USER`, `CLOSE_MODAL`, `STATE_UPDATE`, etc.
- All DOM interaction helpers that serve those old handlers

**Keep:**
- The `APPLY-AGENT` IIFE at the bottom — **keep and promote**
- Strip the `aa` prefix from all identifiers inside it (see list above)
- Remove the `window.__aaFormFillerInjected` guard and IIFE wrapper once it's the only system — just use top-level declarations

---

### 5. `manifest.json`

**Delete** the `overlay.js` and `mini-overlay.js` entries from `web_accessible_resources` (they serve the old overlay system).

**Consider deleting** `overlay.js` and `mini-overlay.js` files entirely once the old content script is cleaned up.

The `content_scripts` static injection entry can remain — the new system still needs a content script on all pages.

---

### 6. Files to delete entirely (after above cleanup)

- `overlay.js` — old visual overlay, not used by new system
- `mini-overlay.js` — old mini overlay, not used by new system
- `styles.css` — check if referenced anywhere other than old overlay; if not, delete

---

## Rename and promote sequence (recommended order)

1. Clean `background.js` first — delete old agent block, strip `aa_` prefixes, move Apply-agent block to top
2. Clean `content.js` — delete old handlers, promote IIFE content to top level, strip `aa_` prefixes
3. Clean `sidepanel.js` — delete old Apply tab JS, strip `aa_` prefixes from Apply-agent block
4. Clean `sidepanel.html` — delete old Apply tab div, rename Apply-agent div/button to `apply`/`tab-apply`, make it the active default
5. Update `manifest.json` — remove unused `web_accessible_resources`
6. Delete `overlay.js`, `mini-overlay.js`, `styles.css` if unused

After each step, reload the extension in `chrome://extensions` and verify the Fill button still works before moving to the next file.
