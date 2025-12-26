# Vaulty Agent Improvement Plan

## Document Purpose

This document outlines the comprehensive plan to transform Vaulty Agent from an action-focused automation tool into a goal-focused intelligent browser agent capable of completing job applications without user assistance.

**Created**: December 25, 2024  
**Status**: Implementation in Progress

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Architecture Weaknesses](#architecture-weaknesses)
3. [Target Architecture](#target-architecture)
4. [Implementation Phases](#implementation-phases)
5. [Phase 1: Goal State Tracking](#phase-1-goal-state-tracking)
6. [Phase 2: Multi-Step Planning](#phase-2-multi-step-planning)
7. [Phase 3: Vision Enhancement](#phase-3-vision-enhancement)
8. [Phase 4: Polish & Reliability](#phase-4-polish--reliability)
9. [Technical Specifications](#technical-specifications)
10. [Success Metrics](#success-metrics)

---

## Current State Analysis

### System Components

| Component | File | Role |
|-----------|------|------|
| Extension Background | `extension/background.js` | Agent loop, state machine, API client |
| Content Script | `extension/content.js` | DOM observation, action execution |
| Overlay HUD | `extension/overlay.js` | Visual feedback on page |
| LLM Prompts | `web/lib/llm/prompts.ts` | System and user prompts |
| Planner API | `web/app/api/agent/next/route.ts` | LLM planning endpoint |
| Types | `web/lib/llm/types.ts` | Shared type definitions |

### Current Agent Loop

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ OBSERVE  │───►│ PLAN     │───►│ EXECUTE  │───►│ DELAY    │──┐
│          │    │          │    │          │    │          │  │
│ Extract  │    │ Call LLM │    │ Run      │    │ 800ms    │  │
│ DOM data │    │ via API  │    │ action   │    │          │  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘  │
     ▲                                                         │
     └─────────────────────────────────────────────────────────┘
```

### Current Observation Structure

```typescript
interface PageObservation {
  url: string;
  title: string;
  fields: FormField[];      // Extracted input elements
  buttons: FormButton[];    // Extracted buttons
  pageContext: string;      // First 4000 chars of page text
  specialElements?: {       // Detected blockers
    hasCaptcha?: boolean;
    hasOAuthButtons?: string[];
    hasFileUpload?: boolean;
    hasPasswordField?: boolean;
    hasCookieBanner?: boolean;
  };
  hasActiveModal?: boolean;
  modalTitle?: string | null;
}
```

---

## Architecture Weaknesses

### 1. No Goal Persistence

**Problem**: Each LLM call is essentially stateless. The agent doesn't remember:
- What job it's applying to
- What company/role it's targeting
- What progress it has made
- What it has already tried and failed

**Impact**: Agent gets distracted by unrelated elements, repeats failed actions, loses context across page navigations.

### 2. DOM Observation is Fragile

**Problem**: 
- Labels often not found (empty string)
- Multiple buttons with identical text
- No spatial/visual context
- Indexes change when page updates

**Impact**: Agent clicks wrong buttons, can't distinguish modal vs nav elements, targeting failures.

### 3. One Action Per API Call

**Problem**: Each action requires:
- 800ms delay
- HTTP round-trip (~200-500ms)
- LLM inference (~500-2000ms)

**Impact**: 20-field form takes 30+ seconds of overhead alone.

### 4. Overloaded LLM Prompt

**Problem**: SYSTEM_PROMPT is ~200 lines covering:
- Response format
- Confidence scoring
- Failure handling
- Password rules
- Element context
- Action types
- Edge cases

**Impact**: LLM gets confused, outputs defensive ASK_USER instead of acting.

### 5. No Verification Loop

**Problem**: After executing an action, agent doesn't verify:
- Did the field actually get filled?
- Did the click trigger the expected result?
- Did the page navigate as expected?

**Impact**: Silent failures, repeated actions on same element.

### 6. Reactive Instead of Proactive

**Problem**: Agent reacts to what it sees, doesn't plan ahead:
- No awareness of typical application flow
- No anticipation of what comes next
- No strategy for blockers

**Impact**: Gets stuck on unexpected pages, doesn't handle multi-step flows well.

---

## Target Architecture

### Goal-Focused Agent Loop

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GOAL CONTEXT                                 │
│  Job: Software Engineer at Google                                   │
│  Progress: 3/5 sections complete                                    │
│  Current: "Work Experience" section                                 │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ OBSERVE  │───►│ PLAN     │───►│ EXECUTE  │───►│ VERIFY   │──┐
│          │    │          │    │          │    │          │  │
│ DOM +    │    │ Multi-   │    │ Execute  │    │ Check    │  │
│ Vision   │    │ step     │    │ sequence │    │ results  │  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘  │
     ▲                                                         │
     │            ┌──────────────────────────────┐             │
     └────────────│ RE-PLAN if verification fails │◄───────────┘
                  └──────────────────────────────┘
```

### New State Model

```typescript
interface ApplicationState {
  // Goal context (set at start, persists across pages)
  goal: {
    jobUrl: string;
    jobTitle: string;
    company: string;
    startedAt: string;
  };
  
  // Progress tracking
  progress: {
    phase: "navigating" | "logging_in" | "filling_form" | "reviewing" | "submitting" | "completed";
    sectionsCompleted: string[];
    currentSection: string | null;
    fieldsFilledThisPage: string[];
    estimatedProgress: number; // 0-100
  };
  
  // Blocker awareness
  blockers: {
    type: null | "login_required" | "captcha" | "file_upload" | "verification" | "error";
    description: string | null;
    attemptsMade: number;
  };
  
  // Memory of what worked/failed
  memory: {
    successfulPatterns: string[];  // e.g., "clicked 'Easy Apply' at index 5"
    failedPatterns: string[];      // e.g., "index 0 'Sign In' was nav, not modal"
    pagesVisited: string[];
  };
}
```

---

## Implementation Phases

### Overview

| Phase | Focus | Duration | Dependencies |
|-------|-------|----------|--------------|
| Phase 1 | Goal State Tracking | 1-2 days | None |
| Phase 2 | Multi-Step Planning | 2-3 days | Phase 1 |
| Phase 3 | Vision Enhancement | 2-3 days | Phase 1 |
| Phase 4 | Polish & Reliability | 3-5 days | Phase 2, 3 |

---

## Phase 1: Goal State Tracking

### Objective

Give the agent persistent memory of what it's trying to accomplish, reducing distraction and improving decision quality.

### Files to Modify

| File | Changes |
|------|---------|
| `extension/background.js` | Add ApplicationState management |
| `web/lib/llm/prompts.ts` | Add goal context to prompts |
| `web/lib/types.ts` | Add ApplicationState types |
| `web/app/api/agent/next/route.ts` | Accept and use goal context |

### Implementation Details

#### 1.1 Add ApplicationState Type

**File**: `web/lib/types.ts`

```typescript
// Goal context for the application
export interface ApplicationGoal {
  jobUrl: string;
  jobTitle: string;        // Extracted from page or user-provided
  company: string;         // Extracted from page or user-provided
  startedAt: string;       // ISO timestamp
}

// Progress tracking
export interface ApplicationProgress {
  phase: ApplicationPhase;
  sectionsCompleted: string[];
  currentSection: string | null;
  fieldsFilledThisPage: string[];
  estimatedProgress: number;
}

export type ApplicationPhase = 
  | "navigating"     // Going to job page
  | "logging_in"     // Authentication required
  | "filling_form"   // Main application form
  | "reviewing"      // Review/confirm page
  | "submitting"     // Final submit
  | "completed";     // Success

// Blocker awareness
export interface ApplicationBlocker {
  type: BlockerType | null;
  description: string | null;
  attemptsMade: number;
}

export type BlockerType = 
  | "login_required"
  | "captcha"
  | "file_upload"
  | "verification"
  | "error";

// Memory of patterns
export interface ApplicationMemory {
  successfulPatterns: string[];
  failedPatterns: string[];
  pagesVisited: string[];
}

// Full application state
export interface ApplicationState {
  goal: ApplicationGoal;
  progress: ApplicationProgress;
  blockers: ApplicationBlocker;
  memory: ApplicationMemory;
}
```

#### 1.2 Initialize State at Job Start

**File**: `extension/background.js`

Add function to extract job info from initial page:

```javascript
// Extract job title and company from page
async function extractJobInfo(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Common selectors for job titles
        const titleSelectors = [
          'h1',
          '[class*="job-title"]',
          '[class*="jobTitle"]',
          '[data-testid*="title"]',
          '.job-title',
          '.posting-headline h2',
        ];
        
        // Common selectors for company names
        const companySelectors = [
          '[class*="company-name"]',
          '[class*="companyName"]',
          '[data-testid*="company"]',
          '.company-name',
          '.employer-name',
        ];
        
        let jobTitle = null;
        let company = null;
        
        for (const sel of titleSelectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) {
            jobTitle = el.textContent.trim().slice(0, 100);
            break;
          }
        }
        
        for (const sel of companySelectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) {
            company = el.textContent.trim().slice(0, 100);
            break;
          }
        }
        
        // Fallback: extract from page title
        if (!jobTitle) {
          const pageTitle = document.title;
          // Common patterns: "Job Title - Company | Site"
          const match = pageTitle.match(/^([^-|]+)/);
          if (match) jobTitle = match[1].trim();
        }
        
        return { jobTitle, company };
      }
    });
    
    return result[0]?.result || { jobTitle: null, company: null };
  } catch (e) {
    console.log("[agent] Failed to extract job info:", e);
    return { jobTitle: null, company: null };
  }
}

// Initialize application state
function createInitialState(startUrl, jobInfo) {
  return {
    goal: {
      jobUrl: startUrl,
      jobTitle: jobInfo.jobTitle || "Unknown Position",
      company: jobInfo.company || "Unknown Company",
      startedAt: new Date().toISOString(),
    },
    progress: {
      phase: "navigating",
      sectionsCompleted: [],
      currentSection: null,
      fieldsFilledThisPage: [],
      estimatedProgress: 0,
    },
    blockers: {
      type: null,
      description: null,
      attemptsMade: 0,
    },
    memory: {
      successfulPatterns: [],
      failedPatterns: [],
      pagesVisited: [],
    },
  };
}
```

#### 1.3 Update Prompts with Goal Context

**File**: `web/lib/llm/prompts.ts`

Add new focused prompt section:

```typescript
export function buildGoalContext(state: ApplicationState): string {
  const { goal, progress, blockers, memory } = state;
  
  let context = `
═══════════════════════════════════════════════════════════════
                      YOUR MISSION
═══════════════════════════════════════════════════════════════
You are applying to: ${goal.jobTitle} at ${goal.company}
Started: ${new Date(goal.startedAt).toLocaleTimeString()}
Progress: ${progress.estimatedProgress}% complete

Current Phase: ${formatPhase(progress.phase)}
${progress.currentSection ? `Current Section: ${progress.currentSection}` : ''}
═══════════════════════════════════════════════════════════════

FOCUS RULES:
- IGNORE: Cookie banners, promotional content, nav menus, social links
- FOCUS: Application form fields, login if required, next/submit buttons
- GOAL: Successfully submit this application
`;

  // Add blocker awareness
  if (blockers.type) {
    context += `
⚠️ CURRENT BLOCKER: ${blockers.type}
Description: ${blockers.description}
Attempts made: ${blockers.attemptsMade}
→ Resolve this before continuing with the application.
`;
  }

  // Add memory of failed patterns
  if (memory.failedPatterns.length > 0) {
    context += `
🚫 ALREADY TRIED (don't repeat):
${memory.failedPatterns.slice(-5).map(p => `- ${p}`).join('\n')}
`;
  }

  return context;
}

function formatPhase(phase: string): string {
  const phases: Record<string, string> = {
    navigating: "📍 Navigating to job page",
    logging_in: "🔐 Logging in",
    filling_form: "📝 Filling application form",
    reviewing: "👁️ Reviewing application",
    submitting: "🚀 Submitting application",
    completed: "✅ Application submitted",
  };
  return phases[phase] || phase;
}
```

#### 1.4 Update Agent Loop

**File**: `extension/background.js`

Modify agent loop to maintain state:

```javascript
async function agentLoop(jobId, tabId, startUrl, mode) {
  // ... existing setup ...
  
  // Initialize application state
  await sleep(1000); // Wait for page to load
  const jobInfo = await extractJobInfo(tabId);
  let appState = createInitialState(startUrl, jobInfo);
  
  console.log(`[agent] Starting application for: ${appState.goal.jobTitle} at ${appState.goal.company}`);
  
  // Store state in job
  await setJob(jobId, { 
    ...existingJob,
    applicationState: appState 
  });
  
  // ... existing loop ...
  
  while (true) {
    // ... existing checks ...
    
    // Update state before each step
    appState = await updateApplicationState(appState, observation, lastAction, lastResult);
    await setJob(jobId, { applicationState: appState });
    
    // Send state to planner
    const plan = await postJSON(`${apiBase}/api/agent/next`, {
      jobId,
      step,
      mode,
      observation,
      profile,
      applicationState: appState,  // NEW: Include state
      actionHistory: actionHistory.slice(-5),
    });
    
    // ... rest of loop ...
  }
}

// Update application state based on observation and last action
function updateApplicationState(state, observation, lastAction, lastResult) {
  const newState = { ...state };
  const url = observation.url.toLowerCase();
  
  // Track page visits
  if (!newState.memory.pagesVisited.includes(observation.url)) {
    newState.memory.pagesVisited.push(observation.url);
  }
  
  // Detect phase from URL and page content
  if (url.includes('login') || url.includes('signin') || url.includes('sign-in')) {
    newState.progress.phase = 'logging_in';
  } else if (url.includes('apply') || url.includes('application') || url.includes('career')) {
    newState.progress.phase = 'filling_form';
  } else if (url.includes('review') || url.includes('confirm')) {
    newState.progress.phase = 'reviewing';
  } else if (url.includes('thank') || url.includes('success') || url.includes('submitted')) {
    newState.progress.phase = 'completed';
  }
  
  // Track filled fields
  if (lastAction?.type === 'FILL' && lastResult?.ok) {
    const fieldId = lastAction.target?.selector || lastAction.target?.index?.toString();
    if (fieldId && !newState.progress.fieldsFilledThisPage.includes(fieldId)) {
      newState.progress.fieldsFilledThisPage.push(fieldId);
    }
  }
  
  // Track success/failure patterns
  if (lastAction && lastResult) {
    const pattern = `${lastAction.type} ${lastAction.target?.text || lastAction.target?.selector || ''}`;
    if (lastResult.ok) {
      if (!newState.memory.successfulPatterns.includes(pattern)) {
        newState.memory.successfulPatterns.push(pattern);
      }
    } else {
      if (!newState.memory.failedPatterns.includes(pattern)) {
        newState.memory.failedPatterns.push(pattern);
      }
    }
  }
  
  // Detect blockers
  if (observation.specialElements?.hasCaptcha) {
    newState.blockers.type = 'captcha';
    newState.blockers.description = 'CAPTCHA detected on page';
  } else if (observation.specialElements?.hasFileUpload) {
    newState.blockers.type = 'file_upload';
    newState.blockers.description = 'File upload required';
  } else {
    newState.blockers.type = null;
    newState.blockers.description = null;
  }
  
  // Estimate progress (rough heuristic)
  const phasesOrder = ['navigating', 'logging_in', 'filling_form', 'reviewing', 'submitting', 'completed'];
  const phaseIndex = phasesOrder.indexOf(newState.progress.phase);
  newState.progress.estimatedProgress = Math.round((phaseIndex / (phasesOrder.length - 1)) * 100);
  
  return newState;
}
```

#### 1.4.1 Mandatory Initial Vision Bootstrap (Step 1)

**Problem**: At the first step, the agent can drift/hallucinate and start applying to other positions on the site.

**Fix**: Always do a **vision-first bootstrap** at step 1:
- Capture a screenshot right after the first observation
- Send screenshot + `applicationState.goal` to the planner
- Force the model to **verify the target job title/company** before clicking anything
- Explicitly forbid clicking other job listings unless they match the goal

**Expected Outcome**:
- Step 1 becomes a “lock-on” phase that selects the correct Apply entry point for the intended job.

#### 1.5 Simplify System Prompt

**File**: `web/lib/llm/prompts.ts`

Create a more focused system prompt:

```typescript
export const FOCUSED_SYSTEM_PROMPT = `You are a Job Application Agent. Your ONLY task is to successfully submit job applications.

RESPONSE FORMAT (JSON only):
{
  "thinking": "<brief reasoning about current situation and decision>",
  "confidence": <0.0-1.0>,
  "action": { <single action object> }
}

CORE RULES:
1. ONE action at a time. Fill one field, then next step.
2. Use ONLY user profile data. Never invent information.
3. Prefer text-based targeting: CLICK by button text, not index.
4. Skip fields that already have correct values.

ACTIONS:
- FILL: {"type":"FILL","target":{"by":"id","selector":"<id>"},"value":"<value>"}
- CLICK: {"type":"CLICK","target":{"by":"text","text":"<button text>"}}
- SELECT: {"type":"SELECT","target":{"by":"id","selector":"<id>"},"value":"<option>"}
- DONE: {"type":"DONE","summary":"<what happened>"}
- ASK_USER: {"type":"ASK_USER","question":"<question>","options":[...],"allowCustom":true}

WHEN TO USE ASK_USER:
- Required field has no matching profile data
- Ambiguous situation (multiple similar buttons)
- Blocked by something you cannot handle (CAPTCHA, file upload)

IGNORE: Cookie banners, newsletter popups, promotional content, unrelated navigation.
FOCUS: Form fields, login forms, next/continue/submit buttons.`;
```

### Expected Outcomes

After Phase 1:
- Agent knows what job it's applying to
- Agent tracks progress through application
- Agent remembers what worked and what failed
- Agent ignores distractions better
- Prompts are cleaner and more focused

---

## Phase 2: Multi-Step Planning

### Objective

Enable the agent to plan sequences of actions instead of deciding one action at a time.

### Key Changes

1. **Plan Structure**: LLM returns a plan with multiple steps
2. **Plan Execution**: Execute steps sequentially until re-planning needed
3. **Re-planning Triggers**: Page navigation, unexpected state, action failure

### Files to Modify

| File | Changes |
|------|---------|
| `web/lib/types.ts` | Add Plan types |
| `web/lib/llm/prompts.ts` | Update prompts for planning |
| `web/app/api/agent/next/route.ts` | Handle plan requests |
| `extension/background.js` | Plan execution logic |

### Implementation Details

#### 2.1 Plan Types

```typescript
export interface ActionPlan {
  thinking: string;
  confidence: number;
  plan: PlannedAction[];
  currentStepIndex: number;
}

export interface PlannedAction {
  action: AgentAction;
  expectedResult: string;  // "Field should be filled with email"
  verifyBy?: string;       // "Check field value contains @"
}
```

#### 2.2 Planning Prompt

```typescript
export const PLANNING_SYSTEM_PROMPT = `You are a Job Application Agent with planning capabilities.

When you see a form or multi-step process, plan ahead:
1. Analyze all visible fields/buttons
2. Create a sequence of actions to complete the current section
3. Return the full plan

RESPONSE FORMAT:
{
  "thinking": "<analysis of the situation>",
  "confidence": <0.0-1.0>,
  "plan": [
    { 
      "action": {"type":"FILL","target":{"by":"id","selector":"email"},"value":"user@email.com"},
      "expectedResult": "Email field filled"
    },
    {
      "action": {"type":"FILL","target":{"by":"id","selector":"phone"},"value":"555-1234"},
      "expectedResult": "Phone field filled"
    },
    {
      "action": {"type":"CLICK","target":{"by":"text","text":"Continue"}},
      "expectedResult": "Navigate to next section"
    }
  ],
  "currentStepIndex": 0
}

WHEN TO RE-PLAN:
- Page navigates to new URL
- Unexpected error occurs
- Plan step fails
- Modal/popup appears

Each step will be executed and verified. If verification fails, you'll be asked to re-plan.`;
```

#### 2.3 Plan Execution Loop

```javascript
async function executePlan(plan, tabId, jobId) {
  for (let i = plan.currentStepIndex; i < plan.plan.length; i++) {
    const step = plan.plan[i];
    
    // Execute action
    const result = await sendToTab(tabId, { type: "EXECUTE", action: step.action });
    
    // Verify result if specified
    if (step.verifyBy) {
      const verified = await verifyAction(tabId, step.verifyBy);
      if (!verified) {
        return { completed: false, failedAt: i, reason: "Verification failed" };
      }
    }
    
    // Check if page navigated (need to re-plan)
    const currentUrl = await getCurrentTabUrl(tabId);
    if (urlSignificantlyDifferent(plan.startUrl, currentUrl)) {
      return { completed: false, failedAt: i, reason: "Page navigated" };
    }
    
    await sleep(300); // Shorter delay between plan steps
  }
  
  return { completed: true };
}
```

---

## Phase 3: Vision Enhancement

### Objective

Use screenshots as primary input when DOM observation is ambiguous or fails.

### Key Changes

1. **Proactive Vision**: Screenshot before every action (optional high-quality mode)
2. **Fallback Vision**: Screenshot when DOM targeting fails
3. **Set-of-Marks**: Overlay numbers on clickable elements for LLM
4. **Visual Verification**: Screenshot after action to verify result

### Implementation Details

#### 3.1 Set-of-Marks Overlay

```javascript
// In content.js
function addSetOfMarks() {
  const markers = [];
  const clickables = document.querySelectorAll('button, a, input[type="submit"], [role="button"]');
  
  clickables.forEach((el, index) => {
    if (!isVisible(el)) return;
    
    const rect = el.getBoundingClientRect();
    const marker = document.createElement('div');
    marker.className = 'vaulty-som-marker';
    marker.textContent = index.toString();
    marker.style.cssText = `
      position: fixed;
      left: ${rect.left - 10}px;
      top: ${rect.top - 10}px;
      width: 20px;
      height: 20px;
      background: #ff6b6b;
      color: white;
      border-radius: 50%;
      font-size: 12px;
      font-weight: bold;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99999;
      pointer-events: none;
    `;
    document.body.appendChild(marker);
    markers.push(marker);
  });
  
  return markers;
}

function removeSetOfMarks(markers) {
  markers.forEach(m => m.remove());
}
```

#### 3.2 Vision-First Mode

```javascript
// In background.js
async function observeWithVision(tabId) {
  // Add markers
  await sendToTab(tabId, { type: "ADD_SOM" });
  await sleep(100);
  
  // Capture screenshot
  const screenshot = await captureScreenshot(tabId);
  
  // Remove markers
  await sendToTab(tabId, { type: "REMOVE_SOM" });
  
  // Get DOM observation as backup
  const domObservation = await sendToTab(tabId, { type: "OBSERVE" });
  
  return {
    screenshot,
    domObservation,
    mode: "vision"
  };
}
```

---

## Phase 4: Polish & Reliability

### Objective

Harden the agent for production use with better error handling, verification, and user experience.

### Key Improvements

1. **Verification Loops**: Confirm actions succeeded
2. **Graceful Degradation**: Handle edge cases elegantly
3. **Progress UI**: Show clear progress to user
4. **Recovery Strategies**: Auto-recover from common failures

---

## Technical Specifications

### API Changes

#### POST /api/agent/next

Updated request:
```typescript
interface PlannerRequest {
  jobId: string;
  step: number;
  mode: "live" | "background";
  observation: PageObservation;
  profile: UserProfile;
  applicationState: ApplicationState;  // NEW
  actionHistory?: ActionHistory[];
  screenshot?: string;
  loopContext?: LoopContext;
}
```

Updated response:
```typescript
interface PlannerResponse {
  action: AgentAction;
  plan?: ActionPlan;           // NEW: Optional multi-step plan
  thinking?: string;
  confidence?: number;
  stateUpdates?: Partial<ApplicationState>;  // NEW: Suggested state updates
  forceLive?: boolean;
}
```

### State Storage

```javascript
// Chrome storage structure
{
  "job:abc123": {
    status: "running",
    step: 15,
    applicationState: {
      goal: { jobUrl, jobTitle, company, startedAt },
      progress: { phase, sectionsCompleted, currentSection, fieldsFilledThisPage, estimatedProgress },
      blockers: { type, description, attemptsMade },
      memory: { successfulPatterns, failedPatterns, pagesVisited }
    },
    actionHistory: [...],
    currentPlan: null | ActionPlan
  }
}
```

---

## Success Metrics

### MVP Success Criteria

- [ ] Agent can complete 3 different job applications without assistance
- [ ] Agent correctly fills 95%+ of form fields
- [ ] Agent handles login flows when credentials are available
- [ ] Agent doesn't get stuck in infinite loops
- [ ] Agent correctly identifies when to ask for help

### Quality Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Completion rate (no user help) | >80% | ~30% |
| Fields filled correctly | >95% | ~70% |
| Time per application | <5 min | ~15 min |
| Loop detection accuracy | >99% | ~90% |
| False positive ASK_USER | <5% | ~30% |

---

## Appendix: File Reference

| File | Phase | Changes |
|------|-------|---------|
| `web/lib/types.ts` | 1 | Add ApplicationState types |
| `extension/background.js` | 1, 2 | State management, plan execution |
| `web/lib/llm/prompts.ts` | 1, 2 | Goal context, planning prompts |
| `web/app/api/agent/next/route.ts` | 1, 2 | Handle state, return plans |
| `extension/content.js` | 3 | Set-of-marks, vision support |
| `extension/overlay.js` | 4 | Progress display |

---

## Next Steps

1. **Start Phase 1**: Implement goal state tracking
2. **Test on 3 job boards**: Indeed, LinkedIn, Greenhouse
3. **Iterate based on failures**
4. **Move to Phase 2 when Phase 1 is stable**

