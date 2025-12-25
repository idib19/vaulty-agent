# Vaulty Agent System Architecture

This document explains the internal architecture and data flow of the Vaulty Agent browser automation system.

## System Overview

Vaulty Agent is a browser automation system that uses LLM (Large Language Model) intelligence to fill web forms automatically. It consists of three main components:

1. **Chrome Extension** - Observes pages, executes actions, manages user profile
2. **Next.js Backend** - Routes LLM calls, manages state, provides API endpoints
3. **LLM Provider** - Decides what action to take based on page content and user profile

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CHROME BROWSER                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐  │
│  │   Popup UI      │    │ Background.js   │    │   Content Script    │  │
│  │  (popup.html)   │◄──►│ (Service Worker)│◄──►│   (content.js)      │  │
│  │                 │    │                 │    │                     │  │
│  │ • Start/Stop    │    │ • Agent Loop    │    │ • DOM Observer      │  │
│  │ • Profile       │    │ • State Machine │    │ • Action Executor   │  │
│  │ • Settings      │    │ • API Client    │    │ • Field Extractor   │  │
│  └─────────────────┘    └────────┬────────┘    └─────────────────────┘  │
│                                  │                                       │
│                    Chrome Storage│(Profile, Jobs, Settings)             │
└──────────────────────────────────┼───────────────────────────────────────┘
                                   │ HTTP
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         NEXT.JS BACKEND (web/)                           │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐  │
│  │ /api/agent/next │    │  LLM Router     │    │   LLM Providers     │  │
│  │                 │───►│  (router.ts)    │───►│                     │  │
│  │ Planner Endpoint│    │                 │    │ • OpenAI            │  │
│  └─────────────────┘    │ • Auto-detect   │    │ • Anthropic         │  │
│  ┌─────────────────┐    │ • Fallback      │    │ • OpenRouter        │  │
│  │ /api/agent/     │    └─────────────────┘    │ • Ollama            │  │
│  │ verify, log     │                           └─────────────────────┘  │
│  └─────────────────┘                                                     │
│  ┌─────────────────┐                                                     │
│  │ /api/profile    │ ◄─── Profile Sync (optional)                       │
│  └─────────────────┘                                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. Job Initialization

```
User clicks "Start" in popup
         │
         ▼
    ┌─────────┐     ┌──────────────┐     ┌─────────────┐
    │ Popup   │────►│ Background   │────►│ New Tab     │
    │         │     │ START_JOB    │     │ Created     │
    └─────────┘     └──────────────┘     └─────────────┘
         │                                      │
         ▼                                      ▼
    Job stored in                    Content script
    chrome.storage                   injected
```

### 2. Agent Loop (Main Cycle)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AGENT LOOP                                   │
│                                                                      │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐      │
│  │ OBSERVE  │───►│ PLAN     │───►│ EXECUTE  │───►│ DELAY    │──┐   │
│  │          │    │          │    │          │    │          │  │   │
│  │ Extract  │    │ Call LLM │    │ Run      │    │ 800ms or │  │   │
│  │ fields,  │    │ via API  │    │ action   │    │ 2000ms   │  │   │
│  │ buttons  │    │          │    │ on DOM   │    │          │  │   │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘  │   │
│       ▲                                                         │   │
│       └─────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Exit conditions:                                                    │
│  • action.type === "DONE"                                           │
│  • action.type === "REQUEST_VERIFICATION" (pause for user)          │
│  • needsApproval === true (pause for approval)                      │
│  • job.stop === true (user clicked Stop)                            │
│  • Fatal error                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 3. Observation Phase

The content script extracts structured data from the page:

```javascript
{
  url: "https://example.com/apply",
  title: "Job Application",
  fields: [
    {
      index: 0,
      tag: "input",
      type: "text",
      id: "firstName",
      name: "first_name",
      label: "First Name",          // Found via <label for="...">
      placeholder: "Enter name",
      required: true,
      disabled: false,
      readonly: false,
      value: "",                    // Current value
      autocomplete: "given-name"
    },
    {
      index: 1,
      tag: "select",
      type: "select",
      id: "country",
      label: "Country",
      options: [
        { value: "us", text: "United States", selected: false },
        { value: "uk", text: "United Kingdom", selected: false }
      ]
    }
    // ... more fields
  ],
  buttons: [
    { index: 0, tag: "button", type: "submit", text: "Submit", disabled: false }
  ],
  pageContext: "First 4000 chars of visible text..."
}
```

### 4. Planning Phase

The backend receives the observation and calls the LLM:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    LLM PROMPT STRUCTURE                              │
│                                                                      │
│  SYSTEM PROMPT:                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ You are an intelligent form-filling assistant...               │ │
│  │ RULES: Fill one field at a time, match labels to profile...   │ │
│  │ AVAILABLE ACTIONS: FILL, SELECT, CHECK, CLICK, DONE...        │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  USER PROMPT:                                                        │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ STEP: 1                                                        │ │
│  │ PAGE: https://example.com/apply                                │ │
│  │ USER PROFILE:                                                  │ │
│  │   first name: John                                             │ │
│  │   last name: Doe                                               │ │
│  │   email: john@example.com                                      │ │
│  │                                                                │ │
│  │ FORM FIELDS:                                                   │ │
│  │   [0] input type="text" id="firstName" label="First Name"     │ │
│  │   [1] input type="email" id="email" label="Email"             │ │
│  │                                                                │ │
│  │ BUTTONS:                                                       │ │
│  │   [0] button type="submit" text="Submit"                      │ │
│  │                                                                │ │
│  │ What is the next action? Respond with JSON only.              │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  LLM RESPONSE:                                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ {"type": "FILL", "target": {"by": "id", "selector":           │ │
│  │  "firstName"}, "value": "John"}                                │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 5. Execution Phase

The content script receives the action and executes it:

```
Action: FILL
         │
         ▼
┌─────────────────┐
│ resolveTarget() │ ─── Find element by id/label/text/css/xpath/index
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ highlight()     │ ─── Scroll into view, add purple outline
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ el.focus()      │
│ el.value = ""   │ ─── Clear existing value
│ el.value = val  │ ─── Set new value
│ dispatch events │ ─── input, change events
└─────────────────┘
```

## Action Types

| Action | Description | Example |
|--------|-------------|---------|
| `FILL` | Fill a text input | `{"type": "FILL", "target": {"by": "id", "selector": "email"}, "value": "john@example.com"}` |
| `SELECT` | Choose dropdown option | `{"type": "SELECT", "target": {"by": "id", "selector": "country"}, "value": "us"}` |
| `CHECK` | Check/uncheck checkbox | `{"type": "CHECK", "target": {"by": "id", "selector": "terms"}, "checked": true}` |
| `CLICK` | Click a button | `{"type": "CLICK", "target": {"by": "text", "text": "Next"}}` |
| `NAVIGATE` | Go to URL | `{"type": "NAVIGATE", "url": "https://example.com"}` |
| `WAIT_FOR` | Wait for element | `{"type": "WAIT_FOR", "target": {"by": "text", "text": "Success"}, "timeoutMs": 5000}` |
| `EXTRACT` | Get more page data | `{"type": "EXTRACT", "mode": "visibleText"}` |
| `REQUEST_VERIFICATION` | Pause for OTP/captcha | `{"type": "REQUEST_VERIFICATION", "kind": "OTP"}` |
| `DONE` | Mark complete | `{"type": "DONE", "summary": "Form submitted successfully"}` |

## Target Resolution

Elements can be targeted in multiple ways:

| Target Type | Usage | Example |
|-------------|-------|---------|
| `by: "id"` | Element ID | `{"by": "id", "selector": "firstName"}` |
| `by: "label"` | Label text | `{"by": "label", "text": "First Name"}` |
| `by: "text"` | Button/link text | `{"by": "text", "text": "Submit"}` |
| `by: "css"` | CSS selector | `{"by": "css", "selector": ".submit-btn"}` |
| `by: "xpath"` | XPath | `{"by": "xpath", "xpath": "//button[@type='submit']"}` |
| `by: "index"` | Field/button index | `{"by": "index", "index": 0, "elementType": "field"}` |
| `by: "role"` | ARIA role | `{"by": "role", "role": "button", "name": "Submit"}` |

## State Management

### Chrome Storage Keys

```javascript
{
  // Active job
  "activeJobId": "abc123",
  
  // Job state
  "job:abc123": {
    "status": "running",      // idle, starting, running, paused_for_approval, 
                              // needs_verification, done, stopped, error
    "step": 5,
    "tabId": 12345,
    "mode": "live",           // live or background
    "approved": false,
    "needsApproval": false,
    "stop": false,
    "error": null,
    "result": null
  },
  
  // User profile
  "userProfile": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "+1 555 123 4567",
    "address": {
      "street": "123 Main St",
      "city": "San Francisco",
      "state": "CA",
      "zipCode": "94102",
      "country": "USA"
    },
    "company": "Acme Inc",
    "jobTitle": "Engineer",
    "updatedAt": "2024-01-15T10:30:00Z"
  },
  
  // Settings
  "apiBase": "http://localhost:3000",
  "agentSettings": {
    "llmProvider": "",        // Use backend default
    "llmApiKey": "",
    "llmModel": "",
    "ollamaUrl": "http://localhost:11434"
  }
}
```

### Job Status Flow

```
idle ──► starting ──► running ──┬──► done
                                │
                                ├──► stopped (user clicked Stop)
                                │
                                ├──► error (fatal error)
                                │
                                ├──► paused_for_approval ──► running
                                │         (user approves)
                                │
                                └──► needs_verification ──► running
                                          (user enters OTP)
```

## LLM Provider Selection

```
┌─────────────────────────────────────────────────────────────────────┐
│                    LLM PROVIDER SELECTION                            │
│                                                                      │
│  1. Check LLM_PROVIDER env var                                      │
│     └─► If set to openai/anthropic/openrouter/ollama, use it       │
│                                                                      │
│  2. Auto-detect from API keys                                       │
│     ├─► OPENAI_API_KEY set? Use OpenAI                             │
│     ├─► ANTHROPIC_API_KEY set? Use Anthropic                       │
│     ├─► OPENROUTER_API_KEY set? Use OpenRouter                     │
│     └─► None set? Default to Ollama (local)                        │
│                                                                      │
│  3. Fallback to stub planner                                        │
│     └─► If Ollama fails or no LLM available, use hardcoded rules   │
└─────────────────────────────────────────────────────────────────────┘
```

## Safety Features

### Approval Gates

Submit-like actions require user approval:

```javascript
// Keywords that trigger approval
["submit", "apply", "confirm", "pay", "finish", "send", "complete", "place order"]

// Or explicit flag from LLM
{ "type": "CLICK", "requiresApproval": true, ... }
```

### Infinite Loop Prevention

```javascript
// Track consecutive EXTRACT actions
if (action.type === "EXTRACT") {
  consecutiveExtracts++;
  if (consecutiveExtracts >= 5) {
    // Stop with "No actionable elements found" message
  }
}
```

### Step Limit

```javascript
// Safety cap in stub planner
if (step >= 40) {
  return { type: "DONE", summary: "Stopped after 40 steps" };
}
```

### Action Delays

```javascript
// Prevent rapid looping
const delayMs = action.type === "EXTRACT" ? 2000 : 800;
await sleep(delayMs);
```

## Extension Permissions

```json
{
  "permissions": [
    "tabs",        // Create and manage tabs
    "scripting",   // Inject content scripts
    "storage",     // Store profile and job state
    "activeTab"    // Access current tab
  ],
  "host_permissions": [
    "<all_urls>"   // Interact with any website
  ]
}
```

## API Reference

### POST /api/agent/next

Request:
```json
{
  "jobId": "abc123",
  "step": 1,
  "mode": "live",
  "observation": { /* PageObservation */ },
  "profile": { /* UserProfile */ }
}
```

Response:
```json
{
  "action": { /* AgentAction */ },
  "forceLive": false
}
```

### POST /api/agent/verify

Request:
```json
{
  "jobId": "abc123",
  "code": "123456"
}
```

### POST /api/agent/log

Request:
```json
{
  "jobId": "abc123",
  "step": 5,
  "action": { /* AgentAction */ },
  "result": { "ok": true }
}
```

### GET /api/profile?userId=xxx

Response:
```json
{
  "profile": { /* UserProfile */ }
}
```

### POST /api/profile

Request:
```json
{
  "userId": "xxx",
  "profile": { /* UserProfile */ }
}
```

## Error Handling

| Error Type | Handling |
|------------|----------|
| Content script not ready | Retry after 500ms |
| Tab closed | Stop with error |
| Planner API failed | Stop with error |
| Action target not found | Non-fatal, continue loop |
| LLM response parse error | Fall back to stub planner |
| Fatal action error | Stop with error |

## Debugging

### Browser Console (Content Script)
```javascript
// Observe is called
console.log("[content] Extracting fields...");

// Action is executed
console.log("[content] Executing:", action);
```

### Service Worker Console (Background)
```javascript
// Each step is logged
console.log("[agent] Step 5: FILL", action);

// Errors are logged
console.error("[agent] Planner call failed:", error);
```

### Backend Logs
```javascript
// LLM provider selection
console.log("[LLM Router] Using provider: openai");

// Planner step
console.log("[Planner] Step 1, calling openai...");
console.log("[Planner] LLM response:", response.slice(0, 200));
```

## File Reference

| File | Purpose |
|------|---------|
| `extension/manifest.json` | Extension config and permissions |
| `extension/background.js` | Agent loop, state machine, API client |
| `extension/content.js` | DOM observation and action execution |
| `extension/overlay.js` | Visual HUD on page |
| `extension/popup.html/js/css` | User interface |
| `extension/profile.js` | Profile storage utilities |
| `web/lib/llm/router.ts` | LLM provider selection |
| `web/lib/llm/prompts.ts` | System and user prompts |
| `web/lib/llm/providers/*.ts` | Provider implementations |
| `web/lib/profile.ts` | Profile types and helpers |
| `web/lib/types.ts` | Shared TypeScript types |
| `web/app/api/agent/next/route.ts` | Planner endpoint |
| `web/app/api/agent/verify/route.ts` | OTP submission |
| `web/app/api/profile/route.ts` | Profile sync |

