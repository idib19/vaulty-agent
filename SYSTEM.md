# Vaulty Agent System Architecture

This document describes the internal architecture and data flow of the Vaulty Agent browser automation system as implemented today.

## System Overview

Vaulty Agent is a browser automation system that uses LLM (and optional vision) to fill web forms and complete job applications. It has three main parts:

1. **Chrome Extension** – Side panel UI, background agent loop, content script (observation + execution), and optional in-page overlay
2. **Next.js Backend (web/)** – Planner API, OTP/verify, Copilot interpret, profile sync, CORS
3. **LLM Provider** – OpenAI, Anthropic, OpenRouter, or Ollama; vision and planning support

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CHROME BROWSER                                    │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐  │
│  │  Side Panel UI   │  │  Background.js   │  │  Content Script          │  │
│  │  (sidepanel.html)│◄─►│  (Service Worker)│◄─►│  (content.js)           │  │
│  │                  │  │                  │  │                          │  │
│  │ • Apply / Start  │  │ • Agent loop     │  │ • DOM observer          │  │
│  │ • Copilot        │  │ • State machine  │  │ • Candidate registry    │  │
│  │ • Profile        │  │ • Screenshot     │  │ • Action executor (v2)  │  │
│  │ • Settings      │  │ • API client      │  │ • Network/route gating   │  │
│  └──────────────────┘  │ • External API   │  │ • Modal awareness       │  │
│                         └────────┬─────────┘  └──────────────────────────┘  │
│  ┌──────────────────┐           │             ┌──────────────────────────┐  │
│  │  Mini Overlay    │           │             │  Injected: mini-overlay.js │  │
│  │  (in-page HUD)   │◄──────────┴────────────│  (step badge, progress)   │  │
│  └──────────────────┘   chrome.storage       └──────────────────────────┘  │
│                         (jobs, profile, settings, logs)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │ HTTP
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         NEXT.JS BACKEND (web/)                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐   │
│  │ /api/agent/next │  │  LLM Router     │  │  LLM Providers               │   │
│  │ (planner)      │─►│  (router.ts)    │─►│  OpenAI (vision) / Anthropic │   │
│  │                 │  │                 │  │  OpenRouter / Ollama         │   │
│  │ • Vision mode   │  │ • Auto-detect   │  └─────────────────────────────┘   │
│  │ • Planning mode │  │ • Vision check │  ┌─────────────────────────────┐   │
│  │ • Candidate     │  └─────────────────┘  │ Prompts (prompts.ts,         │   │
│  │   resolution    │  ┌─────────────────┐  │  copilot-prompts.ts)        │   │
│  └─────────────────┘  │ /api/agent/otp  │  └─────────────────────────────┘   │
│  ┌─────────────────┐  │ /api/agent/     │                                    │
│  │ /api/agent/     │  │   verify, log    │                                    │
│  │ verify, log     │  └─────────────────┘                                    │
│  └─────────────────┘  ┌─────────────────┐  ┌─────────────────────────────┐   │
│  ┌─────────────────┐  │ /api/copilot/   │  │ lib/agent (history, types)   │   │
│  │ /api/profile    │  │ interpret       │  │ Conversation & patterns      │   │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Extension Entry Points

- **Extension icon click** → Opens the **side panel** (no popup).
- **Keyboard shortcut** `Ctrl+Shift+V` / `Cmd+Shift+V` (“Activate Vaulty Copilot”) → Opens side panel.
- **Side panel tabs**: Apply, Copilot, Profile, Settings.

## Data Flow

### 1. Job Start

- **From side panel**: User enters URL (or “Use current tab”), chooses Live/Background, clicks “Start Agent”. Side panel sends `START_JOB` to background with `jobId`, `startUrl`, `mode`.
- **From external app**: Allowed origins (e.g. `https://vaulty.ca`, `http://localhost:3000`) send `START_JOB_FROM_EXTERNAL` with `jobUrl`, optional `jobTitle`, `company`, `coverLetter`, `resumeId`, `customFields`, `mode`. Background creates job with pre-filled `applicationState` and starts the agent loop.

Background creates a new tab (or uses existing) and injects the content script; job state is stored in `chrome.storage.local` under `job:<jobId>`.

### 2. Agent Loop (Background)

High-level cycle:

1. **Observe** – Send `OBSERVE` to content script. Content script waits for network idle and DOM stability, builds candidate registry (if needed), returns observation (fields, buttons, candidates, specialElements, modal awareness, etc.).
2. **Optional screenshot** – For initial vision per URL, planning mode, or loop-recovery vision. Background captures tab via `chrome.tabs.captureVisibleTab`.
3. **Plan** – POST to `/api/agent/next` with:
   - `jobId`, `step`, `mode`, `observation`, `profile`
   - `actionHistory` (last ~10–20 entries)
   - `applicationState` (goal, progress, blockers, auth, memory, external)
   - Optional: `screenshot`, `initialVision`, `requestPlan`, `loopContext`
   - When an LLM is configured, the backend first runs an **Understand** step (see below), then the planner uses that understanding to output concise, efficient actions.
4. **Execute** – Send `EXECUTE` to content script with the action; content script resolves target (including by `vaultyId` or `intent` via registry), runs the action, returns result and a fresh observation.
5. **Update state** – Background updates `applicationState`, `actionHistory`, job status; handles DONE, REQUEST_VERIFICATION, ASK_USER, approval gates, and loop detection.
6. **Delay** – Short delay (e.g. 800ms, or 2000ms after EXTRACT) before next observe.

**Exit / pause conditions**: `action.type === "DONE"`, `REQUEST_VERIFICATION` or `ASK_USER` (pause for user), `requiresApproval` (pause for approval), `job.stop === true`, fatal error, or step cap (behavior.maxSteps).

### 3. Observation (Content Script)

Observation is gated for stability:

- **Network idle**: Patched `fetch` and `XMLHttpRequest` track in-flight requests; wait until no requests for `networkIdleMs` (default 800ms), up to `networkMaxMs` (8s).
- **DOM stability**: Optional wait after last DOM change.
- **SPA route**: `history.pushState` / `replaceState` and `popstate` are wrapped; route changes bump a version and can trigger re-observe.

**Observe output** (simplified):

- `url`, `title`, `fields`, `buttons`, `pageContext` (visible text cap), `specialElements` (captcha, OAuth, file upload, OTP, etc.)
- **Modal awareness**: If an active modal is detected, scope is limited to the modal (fields/buttons/candidates from modal); `hasActiveModal`, `modalTitle`.
- **Candidate registry (v2)**: For each actionable element (inputs, buttons, links, comboboxes) in scope, the content script builds a candidate with a stable `vaultyId` and metadata (type, role, text, label, attributes, context, visibility). These are sent as `candidates` and `registryVersion` so the planner (and backend) can resolve targets by `vaultyId` or by intent with scoring.

### 4. Planning Phase (Backend)

**Understand step (between observation and planning)**  
When an LLM is configured, the backend runs an **Understand** LLM call before building the planner prompt. Inputs: the **observation** (fields, buttons, candidates, pageContext, specialElements, modal) and the current **goal** (from `applicationState.goal`: jobTitle, company, jobUrl). The understand step produces a short, **goal-aware** page understanding (what the page is, key elements and suggested order, ambiguities or warnings). That text is injected at the top of the planner prompt (single-action, planning, and vision modes) so the planner can output **concise, efficient** actions (precise fill/click targets) aligned with the goal. If the understand call fails or no LLM is configured, planning proceeds without it.

**POST /api/agent/next** then supports:

- **Text-only mode**: System prompt + user prompt (including optional PAGE UNDERSTANDING, then observation, profile, step, action history, application state); LLM returns a single action (with optional thinking/confidence). Backend may **resolve target to vaultyId** using `candidates` and scoring (`resolveActionTargetWithCandidates`).
- **Vision mode**: When `screenshot` is provided and the configured provider supports vision (currently OpenAI), the backend can use vision prompts (e.g. initial bootstrap or loop recovery), also prefixed with page understanding when available, and return an action.
- **Planning mode**: When `requestPlan === true`, backend uses a planning prompt (and optionally vision), again with optional page understanding, to produce a multi-step **ActionPlan** (ordered list of planned actions with field names and expected results). The first action is returned along with the plan; the extension can then execute step-by-step and optionally re-plan.

Application state (`goal`, `progress`, `phase`, `blockers`, `auth`, `memory`) is passed so the LLM can align actions with “apply to Job X at Company Y” and handle login/captcha/verification flows.

### 5. Execution (Content Script)

- **Target resolution**: If the action target is `by: "vaultyId"`, the content script looks up the element in the registry by `vaultyId`. If `by: "intent"` (or other descriptors), it uses the candidate registry and a scoring function to pick the best match; resolution can emit a `vaultyId` for stable execution.
- **Actions**: FILL, SELECT, SELECT_CUSTOM, CHECK, CLICK, WAIT_FOR, EXTRACT, UPLOAD_FILE, REFRESH_REGISTRY, etc. Execution highlights the element, performs the DOM update, and dispatches appropriate events.
- **ASK_USER**: Content script can show an in-page modal (or relay to side panel); background sets status to `waiting_for_user` until the user responds.

## Action Types

| Action | Description | Example |
|--------|-------------|---------|
| `FILL` | Fill a text input | `{"type": "FILL", "target": {"by": "id", "selector": "email"}, "value": "john@example.com"}` |
| `SELECT` | Choose native dropdown option | `{"type": "SELECT", "target": {"by": "id", "selector": "country"}, "value": "us"}` |
| `SELECT_CUSTOM` | Choose option in custom (div) dropdown | `{"type": "SELECT_CUSTOM", "target": {...}, "value": "..."}` |
| `CHECK` | Check/uncheck checkbox | `{"type": "CHECK", "target": {"by": "id", "selector": "terms"}, "checked": true}` |
| `CLICK` | Click button/link | `{"type": "CLICK", "target": {"by": "text", "text": "Next"}}` |
| `NAVIGATE` | Go to URL | `{"type": "NAVIGATE", "url": "https://example.com"}` |
| `WAIT_FOR` | Wait for element | `{"type": "WAIT_FOR", "target": {...}, "timeoutMs": 5000}` |
| `EXTRACT` | Get more page data | `{"type": "EXTRACT", "mode": "visibleText"}` |
| `UPLOAD_FILE` | Attach file (e.g. resume) | `{"type": "UPLOAD_FILE", "target": {...}, "fileType": "resume"}` |
| `REQUEST_VERIFICATION` | Pause for OTP/captcha | `{"type": "REQUEST_VERIFICATION", "kind": "OTP", "context": {...}}` |
| `ASK_USER` | Multi-choice or free-text question | `{"type": "ASK_USER", "question": "...", "options": [...], "allowCustom": true}` |
| `REFRESH_REGISTRY` | Rebuild candidate registry | `{"type": "REFRESH_REGISTRY"}` |
| `DONE` | Mark job complete | `{"type": "DONE", "summary": "..."}` |

## Target Resolution

| Target Type | Usage | Example |
|-------------|-------|---------|
| `by: "vaultyId"` | Stable ID from candidate registry | `{"by": "vaultyId", "id": "v-1024"}` |
| `by: "intent"` | Semantic match via registry scoring | `{"by": "intent", "intent": "submit button", "role": "button"}` |
| `by: "id"` | Element ID | `{"by": "id", "selector": "firstName"}` |
| `by: "label"` | Label text | `{"by": "label", "text": "First Name"}` |
| `by: "text"` | Button/link text | `{"by": "text", "text": "Submit"}` |
| `by: "css"` | CSS selector | `{"by": "css", "selector": ".submit-btn"}` |
| `by: "xpath"` | XPath | `{"by": "xpath", "xpath": "//button[@type='submit']"}` |
| `by: "index"` | Field/button index | `{"by": "index", "index": 0, "elementType": "field"}` |
| `by: "role"` | ARIA role | `{"by": "role", "role": "button", "name": "Submit"}` |

The backend may translate id/label/text/role/intent into `vaultyId` using the observation’s `candidates` before sending the action to the content script.

## State Management

### Chrome Storage Keys

- `activeJobId` – Current job ID (if any).
- `job:<jobId>` – Per-job state:
  - `status`: `idle` | `starting` | `running` | `paused_for_approval` | `needs_verification` | `waiting_for_user` | `done` | `stopped` | `error`
  - `step`, `tabId`, `mode` (`live` | `background`)
  - `applicationState`: goal, progress, blockers, auth, memory, external
  - `actionHistory`: last ~20 entries (step, action, result, thinking, context)
  - `initialVisionStep`, `initialVisionUrls` (for vision bootstrap)
  - `plan`, `needsApproval`, `stop`, `error`, `result`, `pending` (e.g. for verification/ASK_USER)
- `userProfile` – User profile (contact, address, professional, resume, credentials, EEO, etc.).
- `agentSettings` – `apiBase`, LLM provider/model/API key, Ollama URL, **behavior**: `autopilotEnabled`, `capEnabled`, `maxSteps`.
- `agentLogs` – Recent log entries (capped, e.g. 200).

### Job Status Flow

```
idle ──► starting ──► running ──┬──► done
                                ├──► stopped (user stop / cancel)
                                ├──► error (fatal)
                                ├──► paused_for_approval ──► running (after approve)
                                ├──► needs_verification ──► running (after OTP/code)
                                └──► waiting_for_user ──► running (after ASK_USER response)
```

### Application State (Goal-Focused)

- **goal**: `jobUrl`, `jobTitle`, `company`, `startedAt`
- **progress**: `phase` (navigating | logging_in | filling_form | reviewing | submitting | completed), `sectionsCompleted`, `currentSection`, `fieldsFilledThisPage`, `estimatedProgress`
- **blockers**: `type`, `description`, `attemptsMade`
- **auth**: Strategy (login/signup/oauth), `onAuthPage`, `loginAttempts`, `loginErrors`, `signupAttempted`, `pivotReason`, etc.
- **memory**: `successfulPatterns`, `failedPatterns`, `pagesVisited`
- **external**: Optional data from external app (`coverLetter`, `resumeId`, `customFields`, `source`)

## LLM Provider Selection

- **Env**: `LLM_PROVIDER` (openai | anthropic | openrouter | ollama) or auto-detect from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`; default `ollama`.
- **Vision**: Currently only OpenAI is used for vision (screenshot); others fall back to text-only.
- **Stub**: If no API key is configured, the planner uses built-in stub rules (simple label/text rules and step cap).

## Safety and Behavior

- **Approval gates**: Submit-like buttons (e.g. “Submit”, “Apply”, “Confirm”) get `requiresApproval: true`; job goes to `paused_for_approval` until user approves in side panel.
- **Step cap**: `behavior.maxSteps` (default 40); configurable in Settings.
- **Autopilot**: `behavior.autopilotEnabled` toggles whether the agent continues without per-step approval.
- **Loop detection**: Consecutive failures or repeated patterns can trigger vision recovery (screenshot + `loopContext`) or ASK_USER.
- **Action delays**: Delay between steps (e.g. 800ms; longer after EXTRACT) to avoid tight loops.

## OTP and Verification

- **Manual code**: Side panel sends code to backend **POST /api/agent/verify** (`jobId`, `code`); backend stores it in memory. Extension can **GET /api/agent/verify?jobId=...** to retrieve it (used when content script needs to fill an OTP field).
- **Vaulty Inbox (automatic OTP)**: **POST /api/agent/otp** with `email` (proxy e.g. `user@mailbox.vaulty.ca`), optional `kind` (`otp` | `verify_link`), `waitMs`, `consume`. Backend calls Vaulty Inbox API (`VAULTY_API_URL`, `VAULTY_API_TOKEN`); returns `code` or `verifyLink`. Used when the agent can auto-fill OTP from the user’s Vaulty mailbox.

## Copilot (Page Summarizer)

- **POST /api/copilot/interpret**: Task `summarize`; body includes `context` (e.g. `url`, page metadata) and optional `screenshot`. Uses `copilot-prompts` and the same LLM router; returns a summary (title, content, keyPoints). The response may include an optional `suggestions` array (items: question, suggestedAnswer, rationale) when the page contains questions (e.g. tests/quizzes). For multiple-choice questions, items may include `options` (array of choice strings) and `correctIndex` (0-based) for interactive quiz mode in the side panel. Also supports task `explain_incorrect`: body includes `question`, `userAnswer`, `correctAnswer`, optional `rationale`, optional `context: { summary?, title? }`; returns `{ explanation: string }`. Used when the user requests a deeper explanation for an incorrect quiz answer. Used by the side panel “Summarize this page” on the active tab.

## External Messaging

External web apps (allowed origins) can send messages to the extension via `chrome.runtime.sendMessage` (from an allowed origin):

- `GET_EXTENSION_STATUS` – Returns `ok`, `installed`, `version`.
- `GET_JOB_STATUS` – Payload `jobId`; returns job status, step, phase, progress, error.
- `START_JOB_FROM_EXTERNAL` – Payload `jobUrl`, optional `jobTitle`, `company`, `coverLetter`, `resumeId`, `customFields`, `mode`; creates job with pre-filled `applicationState` and starts the agent loop; returns `jobId`.
- `CANCEL_JOB` – Payload `jobId`; sets job to stop.

Allowed origins are listed in the background script (e.g. vaulty.ca, localhost variants). The extension’s `externally_connectable` in `manifest.json` restricts which sites can message it.

## API Reference

### POST /api/agent/next

Request (key fields):

- `jobId`, `step`, `mode`, `observation` (url, title, fields, buttons, pageContext, specialElements, candidates, registryVersion, hasActiveModal, modalTitle)
- `profile` (optional)
- `actionHistory` (optional, array of { step, action, result, thinking, context })
- `applicationState` (optional, goal/progress/blockers/auth/memory/external)
- `screenshot` (optional, base64), `initialVision` (optional), `requestPlan` (optional), `loopContext` (optional)

Response:

- `action` (AgentAction), `thinking`, `confidence`, `forceLive`, optional `plan` (ActionPlan).

### POST /api/agent/verify

- Body: `{ jobId, code }` – Stores code for jobId (in-memory).
- GET `?jobId=...` – Returns `{ ok, code }` for extension to consume.

### POST /api/agent/otp

- Body: `email`, optional `kind`, `waitMs`, `consume`. Calls Vaulty Inbox API; returns `{ ok, code }` or `{ ok, verifyLink }` or error.

### POST /api/agent/log

- Body: `jobId`, `step`, `action`, `result` – Backend can log or persist (implementation-specific).

### POST /api/copilot/interpret

- **Task `summarize`**: Body: `task: "summarize"`, `context` (e.g. url), optional `screenshot`. Returns `{ type: "summary", title, content, keyPoints? }`. May include optional `suggestions?: Array<{ question, suggestedAnswer, rationale?, options?, correctIndex? }>` when the page contains questions (e.g. tests/quizzes); `options` and `correctIndex` enable interactive quiz mode in the side panel.
- **Task `explain_incorrect`**: Body: `task: "explain_incorrect"`, `question`, `userAnswer`, `correctAnswer`, optional `rationale`, optional `context: { summary?, title? }`. Returns `{ explanation: string }`. Used by the side panel when the user requests a deeper explanation for an incorrect quiz answer.

### GET/POST /api/profile

- GET `?userId=xxx` – Returns profile.
- POST – Body `userId`, `profile`; syncs profile.

## Error Handling

- Content script not ready → Retry after delay.
- Tab closed → Stop job with error.
- Planner API failure → Stop or fall back to stub.
- Target not found → Non-fatal; result reported, loop may use vision or ASK_USER.
- Parse error on LLM response → Fall back to stub planner where applicable.

## Extension Permissions and Config

- **Permissions**: `tabs`, `scripting`, `storage`, `activeTab`, `sidePanel`.
- **Host permissions**: `<all_urls>`.
- **Web accessible resources**: `overlay.js`, `mini-overlay.js`.
- **Externally connectable**: Listed origins (e.g. app.vaulty.ca, *.vaulty.ca, localhost).
- **Commands**: `activate-copilot` (Ctrl+Shift+V / Cmd+Shift+V).
- **Content scripts**: `content.js` on http(s), `document_idle`, `all_frames: true` (execution targets main frame only where relevant).

## File Reference

| File | Purpose |
|------|---------|
| `extension/manifest.json` | Extension config, permissions, side panel, commands, externally_connectable |
| `extension/background.js` | Agent loop, state machine, screenshot, API client, external messaging, job/application state |
| `extension/content.js` | DOM observation, network/route gating, candidate registry (v2), action execution, modal detection |
| `extension/mini-overlay.js` | In-page HUD (step badge, progress), injected by content script |
| `extension/overlay.js` | Legacy/full overlay (web_accessible) |
| `extension/sidepanel.html` | Side panel UI (tabs: Apply, Copilot, Profile, Settings) |
| `extension/sidepanel.js` | Side panel logic (start/stop, logs, verify/OTP/password, profile, settings, Copilot summarize) |
| `extension/sidepanel.css` | Side panel styles |
| `extension/profile.js` | Profile storage helpers (if used) |
| `web/lib/llm/router.ts` | LLM provider selection, callLLM, callLLMWithVision, isVisionSupported |
| `web/lib/llm/prompts.ts` | UNDERSTAND_SYSTEM_PROMPT, buildUnderstandPrompt; system/user/vision/planning prompts, parseActionResponse, parsePlanningResponse |
| `web/lib/llm/copilot-prompts.ts` | Copilot summarize system/user prompts |
| `web/lib/llm/types.ts` | PageObservation, LoopContext, CandidateElement, FormField, FormButton, etc. |
| `web/lib/llm/providers/*.ts` | OpenAI, Anthropic, OpenRouter, Ollama |
| `web/lib/agent/index.ts` | Agent module exports |
| `web/lib/agent/history.ts` | formatHistoryAsText, analyzePatterns, conversation context for LLM |
| `web/lib/agent/types.ts` | ConversationEntry, ConversationSummary, ConversationConfig |
| `web/lib/agent/CRITIC_AGENT_SPEC.md` | Spec for critic agent (optional future) |
| `web/lib/profile.ts` | Profile types and helpers |
| `web/lib/types.ts` | AgentAction, Target, Observation, ApplicationState, ActionPlan, PlannerRequest/Response, etc. |
| `web/lib/cors.ts` | CORS headers for API routes |
| `web/app/api/agent/next/route.ts` | Planner endpoint (understand step, then vision, planning, candidate resolution) |
| `web/app/api/agent/verify/route.ts` | In-memory OTP/code store (POST/GET) |
| `web/app/api/agent/otp/route.ts` | Vaulty Inbox OTP/verify_link fetch |
| `web/app/api/agent/log/route.ts` | Agent log endpoint |
| `web/app/api/copilot/interpret/route.ts` | Page summarizer (Copilot) |
| `web/app/api/profile/route.ts` | Profile GET/POST |
| `docs/EXECUTOR_PIPELINE_SPEC.md` | Candidate registry and executor v2 spec |

## Debugging

- **Content script**: Console logs tagged e.g. `[content]` for observe/execute and registry.
- **Background**: Service worker console for each step, screenshot, planner call, and errors.
- **Backend**: Logs for provider, planner mode (text/vision/planning), and response previews.
