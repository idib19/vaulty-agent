# Critic Agent Implementation Specification

## Overview

The Critic Agent is a secondary LLM-based component that monitors the main Job Application Agent's performance, identifies patterns of failure, and provides corrective guidance to improve success rates.

**Goal**: Reduce user intervention by enabling self-correction when the main agent gets stuck.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           VAULTY AGENT SYSTEM                                │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        MAIN AGENT LOOP                                 │  │
│  │   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐              │  │
│  │   │ Step 1  │ → │ Step 2  │ → │ Step 3  │ → │ Step N  │              │  │
│  │   └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘              │  │
│  │        │             │             │             │                    │  │
│  │        └─────────────┴─────────────┴─────────────┘                    │  │
│  │                              │                                        │  │
│  │                              ▼                                        │  │
│  │        ┌─────────────────────────────────────────────────────────┐   │  │
│  │        │              CONVERSATION HISTORY LOG                    │   │  │
│  │        │  Each entry: step, thinking, action, result, context     │   │  │
│  │        └─────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    │ Trigger conditions met?                │
│                                    ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                          CRITIC AGENT                                  │  │
│  │                                                                        │  │
│  │   INPUTS:                        OUTPUTS:                              │  │
│  │   • Full conversation history    • Assessment (what's wrong)          │  │
│  │   • Current screenshot           • Correction directive               │  │
│  │   • Application state            • Alternative strategies             │  │
│  │   • User profile                 • Confidence score                   │  │
│  │                                                                        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│                         ┌─────────────────────┐                            │
│                         │ Inject Correction   │                            │
│                         │ into Main Agent     │                            │
│                         └─────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Trigger Conditions

The Critic Agent should be invoked when:

| Trigger | Description | Priority |
|---------|-------------|----------|
| **Repeated Failure** | Same action fails 2+ times consecutively | High |
| **Low Confidence Spiral** | Confidence drops below 0.4 for 3+ steps | High |
| **Loop Detection** | Agent cycles through same 3-4 actions | High |
| **Stuck Detection** | No progress for 5+ steps (no fields filled) | Medium |
| **Checkpoint** | Every 15 steps as a sanity check | Low |
| **Pre-Submit** | Before final form submission | Medium |

### Implementation in background.js

```javascript
// Trigger conditions check
function shouldInvokeCritic(actionHistory, currentStep, applicationState) {
  const patterns = analyzePatterns(actionHistory);
  
  // 1. Repeated failures (highest priority)
  if (patterns.repeatedFailures && patterns.repeatedFailures.length > 0) {
    return { trigger: "repeated_failure", reason: patterns.repeatedFailures[0] };
  }
  
  // 2. Low confidence spiral
  const recentConfidences = actionHistory.slice(-3).map(h => h.confidence || 0.7);
  const avgConfidence = recentConfidences.reduce((a, b) => a + b, 0) / recentConfidences.length;
  if (avgConfidence < 0.4) {
    return { trigger: "low_confidence", reason: `Average confidence: ${avgConfidence.toFixed(2)}` };
  }
  
  // 3. No progress detection
  const fieldsFilledRecently = applicationState.progress.fieldsFilledThisPage.length;
  const stepsWithoutProgress = currentStep - (applicationState.lastProgressStep || 0);
  if (stepsWithoutProgress > 5 && fieldsFilledRecently === 0) {
    return { trigger: "stuck", reason: `No progress for ${stepsWithoutProgress} steps` };
  }
  
  // 4. Periodic checkpoint
  if (currentStep > 0 && currentStep % 15 === 0) {
    return { trigger: "checkpoint", reason: `Step ${currentStep} checkpoint` };
  }
  
  return null; // No trigger
}
```

---

## Data Structures

### CriticRequest

```typescript
interface CriticRequest {
  // Context about the current session
  jobId: string;
  step: number;
  
  // Full conversation history (not truncated)
  conversationHistory: ConversationEntry[];
  
  // Current page state
  screenshot?: string;  // Base64 encoded
  observation: PageObservation;
  
  // Application state
  applicationState: ApplicationState;
  
  // User profile for context
  profile: UserProfile;
  
  // What triggered the critic
  trigger: {
    type: "repeated_failure" | "low_confidence" | "stuck" | "checkpoint" | "pre_submit";
    reason: string;
  };
}
```

### CriticResponse

```typescript
interface CriticResponse {
  // What the critic observed
  assessment: {
    summary: string;           // "The agent is repeatedly failing to click Submit because..."
    identifiedIssues: string[];
    rootCause?: string;
  };
  
  // Correction directive for main agent
  correction: {
    type: "retry_different" | "skip_field" | "change_strategy" | "ask_user" | "abort";
    instruction: string;       // Injected into next main agent prompt
    suggestedAction?: {
      type: string;
      target?: unknown;
      value?: string;
    };
  };
  
  // Alternative strategies to try
  alternatives: Array<{
    strategy: string;
    reasoning: string;
    priority: number;
  }>;
  
  // Confidence in the correction
  confidence: number;
  
  // Should we force user intervention?
  requiresUserIntervention: boolean;
  userInterventionReason?: string;
}
```

---

## Critic Agent Prompt Design

### System Prompt

```typescript
export const CRITIC_SYSTEM_PROMPT = `You are a CRITIC AGENT analyzing a Job Application Agent's performance.

YOUR ROLE:
You are NOT applying to the job yourself. You are analyzing WHY the main agent is struggling 
and providing CORRECTIVE GUIDANCE to help it succeed.

ANALYSIS FRAMEWORK:
1. PATTERN RECOGNITION
   - Look for repeated actions that keep failing
   - Identify actions that succeed vs. fail
   - Note any cycles or loops in behavior

2. ROOT CAUSE ANALYSIS
   - Why is the agent failing? (wrong selector? element not visible? timing issue?)
   - Is there a mismatch between DOM data and visual reality?
   - Are there blockers the agent isn't recognizing?

3. STRATEGY ASSESSMENT
   - Is the agent using the right approach?
   - What alternative strategies could work?
   - Should we change targeting method? (label → id → index)

4. INTERVENTION DECISION
   - Can this be fixed with a different approach?
   - Does the user need to intervene?
   - Should we abort and try later?

RESPONSE FORMAT (JSON):
{
  "assessment": {
    "summary": "<1-2 sentence description of what's going wrong>",
    "identifiedIssues": ["issue 1", "issue 2"],
    "rootCause": "<most likely root cause>"
  },
  "correction": {
    "type": "retry_different | skip_field | change_strategy | ask_user | abort",
    "instruction": "<specific instruction for main agent>",
    "suggestedAction": { /* optional specific action */ }
  },
  "alternatives": [
    { "strategy": "...", "reasoning": "...", "priority": 1 }
  ],
  "confidence": 0.8,
  "requiresUserIntervention": false
}

CORRECTION TYPES:
- "retry_different": Try the same goal with a different approach
- "skip_field": Skip this field and move on (if optional)
- "change_strategy": Fundamentally change approach (e.g., try OAuth instead of email login)
- "ask_user": Need user input to proceed
- "abort": Too many failures, stop and report

BE SPECIFIC: Don't just say "try again". Say exactly what to do differently.`;
```

### User Prompt Builder

```typescript
export function buildCriticPrompt(request: CriticRequest): string {
  const { conversationHistory, observation, applicationState, trigger } = request;
  
  // Format conversation history in detail
  const historyText = conversationHistory.map(entry => {
    const status = entry.result.ok ? "✓" : "✗";
    const actionDesc = entry.action.value 
      ? `${entry.action.type} "${entry.action.target}" = "${entry.action.value}"`
      : `${entry.action.type} "${entry.action.target}"`;
    
    let line = `${status} Step ${entry.step}: ${actionDesc}`;
    if (entry.thinking) line += `\n   Thinking: "${entry.thinking}"`;
    if (!entry.result.ok) line += `\n   Error: ${entry.result.error}`;
    return line;
  }).join("\n\n");
  
  // Analyze patterns
  const patterns = analyzePatterns(conversationHistory);
  let patternAnalysis = "";
  if (patterns.repeatedFailures?.length) {
    patternAnalysis += `\n⚠️ REPEATED FAILURES:\n${patterns.repeatedFailures.map(f => `  - ${f}`).join("\n")}`;
  }
  if (patterns.successfulStrategies?.length) {
    patternAnalysis += `\n✓ WORKING STRATEGIES:\n${patterns.successfulStrategies.map(s => `  - ${s}`).join("\n")}`;
  }

  return `CRITIC ANALYSIS REQUEST
========================

TRIGGER: ${trigger.type.toUpperCase()}
REASON: ${trigger.reason}

APPLICATION GOAL:
- Job: ${applicationState.goal.jobTitle} at ${applicationState.goal.company}
- Progress: ${applicationState.progress.estimatedProgress}%
- Phase: ${applicationState.progress.phase}

FULL CONVERSATION HISTORY (${conversationHistory.length} steps):
${historyText}
${patternAnalysis}

CURRENT PAGE STATE:
- URL: ${observation.url}
- Title: ${observation.title}
- Fields: ${observation.fields?.length || 0}
- Buttons: ${observation.buttons?.length || 0}

VISIBLE FIELDS:
${observation.fields?.slice(0, 15).map(f => 
  `- "${f.label || f.name || f.id}": ${f.value ? `"${f.value}"` : "(empty)"}${f.required ? " (required)" : ""}${f.hasError ? " ⚠️ ERROR" : ""}`
).join("\n") || "(none)"}

VISIBLE BUTTONS:
${observation.buttons?.slice(0, 10).map(b => 
  `- "${b.text}" [${b.context}]`
).join("\n") || "(none)"}

Analyze the situation and provide corrective guidance.`;
}
```

---

## API Endpoint

### Route: `/api/agent/critic`

```typescript
// web/app/api/agent/critic/route.ts

import { NextRequest, NextResponse } from "next/server";
import { corsHeaders } from "@/lib/cors";
import { callLLMWithVision, getConfiguredProvider, isVisionSupported } from "@/lib/llm/router";
import { CRITIC_SYSTEM_PROMPT, buildCriticPrompt, parseCriticResponse } from "@/lib/agent/critic";
import type { CriticRequest, CriticResponse } from "@/lib/agent/types";

export async function POST(request: NextRequest) {
  const body = await request.json() as CriticRequest;
  
  const provider = getConfiguredProvider();
  const useVision = body.screenshot && isVisionSupported(provider);
  
  console.log(`[Critic] Analyzing agent performance (trigger: ${body.trigger.type})...`);
  console.log(`[Critic] History: ${body.conversationHistory.length} steps`);
  
  const prompt = buildCriticPrompt(body);
  
  const startTime = Date.now();
  let response;
  
  if (useVision) {
    response = await callLLMWithVision({
      messages: [
        { role: "system", content: CRITIC_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      images: [{ base64: body.screenshot!, type: "image/png" }],
      temperature: 0.2,  // Slightly higher for creative problem-solving
      maxTokens: 1500,
    });
  } else {
    response = await callLLM({
      messages: [
        { role: "system", content: CRITIC_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 1500,
    });
  }
  
  const duration = Date.now() - startTime;
  console.log(`[Critic] Analysis completed in ${duration}ms`);
  
  const parsed = parseCriticResponse(response.content);
  
  console.log(`[Critic] Assessment: ${parsed.assessment.summary}`);
  console.log(`[Critic] Correction: ${parsed.correction.type} - ${parsed.correction.instruction}`);
  
  return NextResponse.json(parsed as CriticResponse, { headers: corsHeaders });
}
```

---

## Integration with Main Agent Loop

### Modified background.js Flow

```javascript
async function agentLoop({ jobId, startUrl, mode }) {
  // ... existing setup ...
  
  while (true) {
    // ... existing observation and state update ...
    
    // ============================================================
    // CRITIC AGENT CHECK
    // ============================================================
    const criticTrigger = shouldInvokeCritic(actionHistory, step, applicationState);
    
    if (criticTrigger) {
      console.log(`[agent] 🔍 Invoking Critic Agent (trigger: ${criticTrigger.trigger})...`);
      
      const screenshot = await captureScreenshot(tabId);
      
      const criticResponse = await postJSON(`${apiBase}/api/agent/critic`, {
        jobId,
        step,
        conversationHistory: actionHistory,  // Full history, not truncated
        screenshot,
        observation,
        applicationState,
        profile,
        trigger: criticTrigger
      });
      
      console.log(`[agent] 🔍 Critic assessment: ${criticResponse.assessment.summary}`);
      
      // Handle critic response
      if (criticResponse.requiresUserIntervention) {
        // Force user intervention
        const askAction = {
          type: "ASK_USER",
          question: criticResponse.userInterventionReason || criticResponse.assessment.summary,
          options: [
            { id: "continue", label: "Continue anyway" },
            { id: "skip", label: "Skip this step" },
            { id: "stop", label: "Stop and review" }
          ],
          allowCustom: true
        };
        // ... handle ASK_USER flow ...
        continue;
      }
      
      if (criticResponse.correction.type === "abort") {
        // Too many failures, stop gracefully
        const doneAction = { 
          type: "DONE", 
          summary: `Stopped: ${criticResponse.assessment.summary}` 
        };
        await setJob(jobId, { status: "error", error: criticResponse.assessment.summary });
        return;
      }
      
      // Inject critic correction into next planning call
      criticCorrection = criticResponse.correction.instruction;
      
      // If critic suggests a specific action, use it
      if (criticResponse.correction.suggestedAction) {
        action = criticResponse.correction.suggestedAction;
        thinking = `Critic correction: ${criticResponse.correction.instruction}`;
        confidence = criticResponse.confidence;
        // Skip normal planner call, use critic's suggestion
        goto executeAction;
      }
    }
    
    // ... existing planner call (with criticCorrection injected if set) ...
    
    executeAction:
    // ... existing action execution ...
  }
}
```

### Injecting Critic Feedback into Prompts

When the critic provides a correction but no specific action, inject it into the next planner call:

```typescript
// In buildUserPrompt or as a separate section
if (criticCorrection) {
  prompt += `
═══════════════════════════════════════════════════════════════
                    CRITIC CORRECTION
═══════════════════════════════════════════════════════════════
A Critic Agent analyzed your recent failures and recommends:

${criticCorrection}

IMPORTANT: Follow this guidance. Do NOT repeat the same failing approach.
═══════════════════════════════════════════════════════════════
`;
}
```

---

## Implementation Phases

### Phase 1: Foundation (1-2 days)
- [ ] Add `CriticRequest` and `CriticResponse` types to `types.ts`
- [ ] Create `critic.ts` with prompts and parsers
- [ ] Implement `/api/agent/critic` endpoint
- [ ] Add `shouldInvokeCritic()` function

### Phase 2: Integration (1-2 days)
- [ ] Add critic trigger check in main agent loop
- [ ] Implement critic response handling
- [ ] Add critic correction injection into prompts
- [ ] Add logging and metrics for critic invocations

### Phase 3: Testing & Tuning (2-3 days)
- [ ] Test with common failure scenarios
- [ ] Tune trigger thresholds
- [ ] Refine critic prompts based on real-world results
- [ ] Add A/B testing capability (with/without critic)

### Phase 4: Advanced Features (future)
- [ ] Learning from successful corrections (store what worked)
- [ ] Multiple critic strategies (conservative vs. aggressive)
- [ ] User preference learning (what types of help do they want?)
- [ ] Cost optimization (when is critic worth the extra LLM call?)

---

## Metrics to Track

| Metric | Description |
|--------|-------------|
| `critic_invocations` | How often critic is triggered |
| `critic_correction_success` | Did the correction lead to progress? |
| `critic_to_user_escalation` | How often does critic recommend user help? |
| `steps_saved` | Steps avoided by critic intervention |
| `user_intervention_rate` | Before vs. after critic implementation |

---

## Cost Considerations

The Critic Agent adds an additional LLM call, so we should be strategic:

1. **Only invoke on failure patterns**, not every step
2. **Use cheaper models** for critic (e.g., GPT-4o-mini instead of GPT-4o)
3. **Cache similar corrections** (if same pattern seen before, reuse correction)
4. **Rate limit** critic calls (max 3 per job application)

---

## Example Scenarios

### Scenario 1: Submit Button Not Found

**History:**
```
✓ Step 5: FILL "Email" = "john@example.com"
✓ Step 6: FILL "Phone" = "555-1234"
✗ Step 7: CLICK "Submit" (Error: element not found)
✗ Step 8: CLICK "Submit" (Error: element not found)
```

**Critic Assessment:**
```json
{
  "assessment": {
    "summary": "Agent is trying to click 'Submit' but the button text is actually 'Submit Application'",
    "identifiedIssues": ["Button text mismatch", "Using text-based targeting"],
    "rootCause": "The submit button has text 'Submit Application', not just 'Submit'"
  },
  "correction": {
    "type": "retry_different",
    "instruction": "The submit button is labeled 'Submit Application'. Use the full text or target by button index.",
    "suggestedAction": {
      "type": "CLICK",
      "target": { "by": "text", "text": "Submit Application" }
    }
  },
  "confidence": 0.9
}
```

### Scenario 2: Hidden Field

**History:**
```
✓ Step 3: FILL "Name" = "John Doe"
✗ Step 4: FILL "Company" (Error: element not interactable)
✗ Step 5: FILL "Company" (Error: element not visible)
```

**Critic Assessment:**
```json
{
  "assessment": {
    "summary": "The 'Company' field appears in DOM but is not visible - likely a conditional field",
    "identifiedIssues": ["Field is hidden/conditional", "May require another action first"],
    "rootCause": "Company field is only shown after selecting 'Employed' status"
  },
  "correction": {
    "type": "change_strategy",
    "instruction": "Skip the Company field for now. Look for an 'Employment Status' dropdown and select 'Employed' first, then the Company field should appear."
  },
  "confidence": 0.75
}
```

---

## Files to Create

```
web/lib/agent/
├── types.ts          # Add CriticRequest, CriticResponse
├── history.ts        # (existing) - used by critic
├── critic.ts         # NEW: CRITIC_SYSTEM_PROMPT, buildCriticPrompt, parseCriticResponse
├── triggers.ts       # NEW: shouldInvokeCritic, trigger condition logic
└── index.ts          # Export all

web/app/api/agent/
├── next/route.ts     # (existing)
└── critic/route.ts   # NEW: Critic API endpoint
```

---

## Summary

The Critic Agent provides a meta-cognitive layer that:

1. **Monitors** the main agent's conversation history for failure patterns
2. **Analyzes** what's going wrong using a separate LLM call (with vision)
3. **Corrects** by injecting guidance into the next main agent call
4. **Escalates** to user when automated correction isn't possible

This should significantly reduce the need for user intervention while maintaining safety through the escalation mechanism.

