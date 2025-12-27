# Hybrid Perception Experiment

## Goal
Add a vision-assisted perception path that pairs a screenshot with the existing DOM snapshot, uses a vision-capable LLM to propose likely CTAs/inputs, and fuses those proposals with our heuristics to improve targeting reliability (especially on canvas-heavy/low-accessibility UIs).

## Success Criteria
- Vision-enabled runs pick better primary/secondary targets on pages where DOM-only signals are weak (shadow DOM, custom buttons, mislabeled fields).
- No regression when vision is unavailable (falls back cleanly to current DOM flow).
- Clear observability: we can see when vision was used, what it suggested, and how fusion chose the final target.

## High-Level Flow
1) Background triggers OBSERVE → content script gathers DOM snapshot (existing) and requests a screenshot from background.
2) Background captures screenshot (`chrome.tabs.captureVisibleTab`) and sends {observation, screenshotBase64} to the planner API.
3) Planner uses `callLLMWithVision` with `VISION_SYSTEM_PROMPT` / `INITIAL_VISION_SYSTEM_PROMPT` to get vision tags (probable CTAs/inputs with boxes and confidences).
4) Fuse: merge vision tags with DOM candidates via bounding-box overlap and text/role similarity; produce enriched candidates with combined confidence and rationale.
5) Planner returns the chosen action plus fusion rationale; executor proceeds as usual.

## Data Contracts
- Request to planner (`web/app/api/agent/next/route.ts` already supports `screenshot`):
  ```json
  {
    "observation": { ...existing PageObservation... },
    "screenshot": "<base64 png>",
    "initialVision": false,
    "requestPlan": false,
    "loopContext": { ... },
    "applicationState": { ... }
  }
  ```
- Vision model expected output (from prompt parsing, text-only contract for now):
  ```json
  {
    "thinking": "why these targets",
    "candidates": [
      {
        "label": "Submit",
        "role": "button",
        "box": { "x": 120, "y": 540, "w": 180, "h": 40 },
        "confidence": 0.82,
        "nearbyText": "Review and submit",
        "ctaType": "submit|next|continue|login|upload|otp|other"
      }
    ]
  }
  ```
  We do not store images; use them only in-flight.

## Client-Side Capture (extension)
- Background (`extension/background.js`):
  - Add a feature flag `visionEnabled` in settings (default off/auto when provider supports it).
  - Before sending a planner request, if `visionEnabled`, call `chrome.tabs.captureVisibleTab(tab.windowId, {format: "png"})`.
  - Limit size: if >250KB, downscale via canvas in a temporary offscreen page or accept as-is and rely on provider limits.
  - Attach screenshot base64 to planner payload; if capture fails (permissions/denied), log and continue DOM-only.
- Content script (`extension/content.js`):
  - No screenshot capture; keep DOM extraction as-is.
  - Optionally include element bounding boxes with IDs in observation to help fusion (e.g., `{id, role, text, bbox}`).

## Server-Side Inference (Next API)
- `route.ts` already routes to `callLLMWithVision` when `screenshot` + provider supports vision.
- Add a small vision response parser (similar to `parseActionResponse`) that extracts `candidates` with boxes/confidences.
- Pass vision candidates alongside DOM observation into the fusion layer.
- If vision unsupported or parsing fails, fall back to DOM heuristics silently.

## Fusion Algorithm (DOM + Vision)
1) Normalize DOM candidates:
   - For each field/button extracted in `content.js`, compute bbox (`getBoundingClientRect` in content) and a base heuristic score (existing rules: role, context region, text match).
2) Normalize vision candidates:
   - Ensure all boxes are in viewport coords; clamp to viewport.
3) Match vision → DOM:
   - IoU overlap ≥0.25 OR center-of-vision-box lies within DOM bbox.
   - Text similarity: lowercased vision `label/nearbyText` vs DOM `innerText/aria-label/name/placeholder`.
4) Score fusion:
   - `score = domScore * 0.6 + visionConfidence * 0.4 + textSimBonus + regionBonus`.
   - Add CTA-type bonus for submit/next/login patterns.
   - Penalize invisible/disabled elements regardless of vision confidence.
5) Output:
   - Sorted enriched candidate list with `{target, score, rationale: {dom, vision}}`.
   - Pick top-1 for action planning; expose top-3 for debugging/telemetry.

## Prompting Notes
- Use `VISION_SYSTEM_PROMPT` for loop steps; `INITIAL_VISION_SYSTEM_PROMPT` for first-step bootstrap (already present in `prompts.ts`).
- Ask the model to return a compact JSON block with boxes and CTA types; keep temperature low (0.1).
- Include text summary (“why these 3 targets”) to aid debugging.

## Telemetry & Controls
- Feature flag: `visionEnabled` (auto/on/off). Auto = use when provider supports vision and screenshot capture succeeds.
- Metrics to log (non-PII):
  - Whether vision was used.
  - Vision candidate count and top confidence.
  - Chosen target source: `dom_only` | `vision_only` | `hybrid`.
  - Failures: capture_failed, parse_failed, fusion_empty.
- Keep screenshots in-memory only; never persist to storage or logs.

## Rollout Plan
1) Add feature flag + capture pipeline (background) and passthrough to planner.
2) Implement vision response parsing and fusion in planner layer; keep DOM-only as fallback.
3) Add lightweight debug view in logs/overlay (e.g., show “Vision: top CTA = Submit (0.82)”).
4) Dogfood on a small set of sites with custom buttons/canvas; compare targeting success vs DOM-only.
5) Iterate on fusion weights and prompt format; enable by default once stable.

## Risks / Mitigations
- **Permissions**: `captureVisibleTab` requires host permissions/tab active; mitigation: try/catch, fallback to DOM.
- **Latency**: vision calls are slower; mitigate by using only on first load or every Nth loop, and cap image size.
- **Privacy**: screenshots may contain PII; mitigate by in-flight use only, no storage, and user-visible flag in settings.

