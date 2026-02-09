# Executor Pipeline v2 (content.js)
#
# Goal: make DOM execution deterministic by aligning the planner's intent
# with a local candidate registry, scoring-based resolution, and explicit
# verification hooks. This spec focuses on the content.js executor path.

## Summary

The current executor resolves targets using a small set of selector methods
(id, label, text, role, css, xpath, index). This is often insufficient when
there are multiple matching elements, hidden duplicates, or shadow DOM.

This spec proposes a v2 executor that:
1. Builds a local candidate registry for actionable elements.
2. Resolves targets using a scoring-based matcher and optional vaultyId.
3. Verifies outcomes after each action.
4. Emits structured failure telemetry to improve planner alignment.


## Goals

- Increase execution success rate for FILL / CLICK / SELECT / CHECK.
- Make planner and executor "speak the same language."
- Reduce failure caused by duplicate elements, hidden elements, and shadow DOM.
- Provide actionable telemetry when resolution or execution fails.

## Non-Goals

- Replace the planner or LLM prompt strategy.
- Add new backend endpoints (optional but not required for v2).
- Implement the Critic Agent (separate spec).


## Proposed Architecture (content.js)

Pipeline:
Observe -> Candidate Registry -> Plan -> Resolve -> Execute -> Verify -> Report

Key changes:
- OBSERVE now builds and returns a candidate registry.
- EXECUTE supports target.by = "vaultyId" and target.by = "intent".
- Resolution uses a scoring ladder and telemetry on failure.


## Candidate Registry

### Definition

CandidateRegistry is a list of actionable elements with a stable vaultyId
for the current page context and enough metadata to resolve intent.

The registry is built on each OBSERVE call and stored in memory. A separate
WeakMap keeps element references for execution.

### Candidate shape (in memory)

{
  vaultyId: "v-1024",
  type: "button" | "link" | "input" | "select" | "textarea" | "custom-dropdown",
  role: "button" | "textbox" | "combobox" | ...,
  text: "Submit Application",
  label: "Email",
  placeholder: "Enter email",
  ariaLabel: "Submit Application",
  attributes: {
    id: "submitButton",
    name: "submit",
    dataTestId: "submit-application"
  },
  context: "MODAL" | "FORM" | "MAIN" | "NAV" | "PAGE",
  formId: "applicationForm",
  sectionHeading: "Review",
  bbox: { x, y, w, h },
  visibility: {
    isVisible: true,
    isEnabled: true,
    isTopmost: true
  },
  domPath: "html>body>...>button#submit",
  shadowPath: ["host#app", "shadowRoot", "button#submit"]
}

### Candidate shape (sent to planner)

Keep this lightweight to reduce payload size:

{
  vaultyId: "v-1024",
  type: "button",
  role: "button",
  text: "Submit Application",
  label: null,
  attributes: { id, name, dataTestId },
  context: "FORM",
  isVisible: true,
  isEnabled: true
}


## Target Schema (Planner -> Executor)

### Direct vaultyId targeting (preferred)

{
  "type": "CLICK",
  "target": {
    "by": "vaultyId",
    "id": "v-1024"
  }
}

### Intent-based targeting (fallback)

{
  "type": "CLICK",
  "target": {
    "by": "intent",
    "intent": "submit_application",
    "role": "button",
    "text": {
      "exact": "Submit Application",
      "contains": ["Submit", "Apply"]
    },
    "label": null,
    "attributes": {
      "id": null,
      "name": null,
      "dataTestId": "submit-application"
    },
    "context": {
      "form": "application",
      "section": "Review",
      "modalTitle": null
    },
    "constraints": {
      "mustBeVisible": true,
      "mustBeEnabled": true,
      "mustBeTopmost": true
    },
    "fallbacks": ["aria", "label", "text", "som"],
    "confidence": 0.76
  }
}

### Backward compatibility

If target.by is one of "id", "label", "text", "role", "css", "xpath", "index",
the executor continues to use the current resolveTarget behavior.


## Resolver Ladder (v2)

### Pre-filter
- Remove candidates that are not visible.
- Remove candidates that are disabled (for click or fill).
- If mustBeTopmost is set, filter by elementFromPoint.

### Scoring-Based Resolution

The resolver computes a score per candidate:

score =
  0.40 * textExactMatch +
  0.20 * roleMatch +
  0.15 * labelMatch +
  0.10 * attributeMatch (id/name/data-testid) +
  0.10 * contextMatch +
  0.05 * visibilityBoost

Notes:
- textExactMatch in [0,1] where 1 = exact, 0.7 = contains, 0 = no match
- labelMatch uses extracted labels and aria-label
- attributeMatch is higher if data-testid is present
- contextMatch is higher if the element is in the same form or modal

### Decision rules
- If top score >= 0.75, select it.
- If top score < 0.45, return failure (insufficient confidence).
- If top two scores are within 0.05, prefer the one that is topmost or closer
  to the intended label or section heading.


## Verification Hooks (v2)

### FILL
- Verify: element.value equals expected (after 1-2 animation frames).
- If mismatch, retry with alternate focus or dispatch input/change again.

### CLICK
- Verify: either URL changes, modal opens, or DOM hash changes.
- If no change, return ok: false with reason "no_dom_change".

### SELECT
- Verify: selected option value matches expected.
- For custom dropdown, verify displayed value changed.

### CHECK
- Verify: el.checked equals expected.


## Failure Telemetry (v2)

Execution should return a structured trace:

{
  ok: false,
  error: "CLICK target not found",
  resolutionTrace: {
    registryVersion: 12,
    candidatesTotal: 38,
    candidatesAfterFilter: 9,
    topMatches: [
      { vaultyId: "v-1024", score: 0.62, reasons: ["text:contains", "role"] },
      { vaultyId: "v-1099", score: 0.58, reasons: ["text:contains"] }
    ],
    chosen: null,
    failureReason: "score_below_threshold"
  }
}

This trace should be included in the result and logged by the background
agent for planner tuning.


## Integration Plan (content.js)

### 1) Build Candidate Registry during OBSERVE

Add functions:
- buildCandidateRegistry(scope)
- collectActionableElementsDeep(root)  // includes shadow DOM
- computeCandidateMetadata(el)
- isTopmost(el)

Store:
- window.__vaultyRegistry = { version, candidates, elementMap }
- elementMap is a WeakMap: vaultyId -> DOM element

OBSERVE response includes:
- candidates: registry.candidates (lightweight fields)

### 2) Resolve Target using vaultyId

Add resolveTargetV2(action.target):
- if target.by === "vaultyId":
  - look up in registry.elementMap
  - verify isConnected + visible
- if target.by === "intent":
  - run scoring search on registry.candidates
- else fallback to resolveTarget (legacy)

### 3) Execute + Verify

Wrap each action type:
- resolveTargetV2
- perform action (existing helpers)
- verify and return result + trace

### 4) Registry invalidation

- On DOM mutations or route changes, mark registry stale.
- If execute finds stale registry, rebuild before resolution.


## Shadow DOM Handling

Add a traversal helper:

collectActionableElementsDeep(root):
  - iterate root.querySelectorAll for standard elements
  - if element has shadowRoot, recursively traverse shadowRoot
  - record shadowPath for each candidate

This allows the registry to include elements inside shadow DOM.


## Rollout Plan

Phase 1:
- Add registry + vaultyId targeting.
- Maintain full backward compatibility.

Phase 2:
- Update planner to prefer vaultyId when present.
- Enable scoring-based intent fallback.

Phase 3:
- Add verification hooks and telemetry feedback.
- Add resolver tuning based on telemetry.


## Open Questions

- Should vaultyId be stable across registry rebuilds?
  - Suggest using a stable hash of attributes (id, name, text, role).
- How much of the registry should be sent to the planner?
  - Suggest a cap (e.g., top 80 candidates) and only send minimal fields.
- Should the planner be allowed to request a registry refresh?
  - Consider a new action: REFRESH_REGISTRY.

