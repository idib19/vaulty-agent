import type { FormField, FormButton, PageObservation, AlternativeElement, LoopContext, CandidateElement, PageUnderstanding } from "./types";
import type { UserProfile } from "../profile";
import type { ApplicationState } from "../types";
import { profileToContext } from "../profile";

// Types for enhanced response format
export interface ActionHistory {
  step: number;
  action: {
    type: string;
    [key: string]: unknown;
  };
  result?: {
    ok: boolean;
    error?: string;
  };
}

export interface EnhancedLLMResponse {
  thinking: string;
  confidence: number;
  action: unknown;
}

function normalizeShorthandAction(action: unknown): unknown {
  if (!action || typeof action !== "object") return action;

  // Already canonical
  const maybeType = (action as { type?: unknown }).type;
  if (typeof maybeType === "string" && maybeType.length > 0) return action;

  // Shorthand forms like { "CLICK": "Apply" }
  const obj = action as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined);
  if (keys.length !== 1) return action;

  const rawKey = keys[0];
  const k = rawKey.toUpperCase();
  const v = obj[rawKey];

  if (k === "CLICK") {
    if (typeof v === "string") return { type: "CLICK", target: { by: "text", text: v } };
    if (v && typeof v === "object") {
      const vv = v as Record<string, unknown>;
      if (typeof vv.text === "string") return { type: "CLICK", target: { by: "text", text: vv.text } };
    }
  }

  if (k === "FILL") {
    if (v && typeof v === "object") {
      const vv = v as Record<string, unknown>;
      const value = typeof vv.value === "string" ? vv.value : undefined;
      const label = typeof vv.label === "string" ? vv.label : undefined;
      const id = typeof vv.id === "string" ? vv.id : undefined;
      if (value && id) return { type: "FILL", target: { by: "id", selector: id }, value };
      if (value && label) return { type: "FILL", target: { by: "label", text: label }, value };
    }
  }

  if (k === "SELECT") {
    if (v && typeof v === "object") {
      const vv = v as Record<string, unknown>;
      const value = typeof vv.value === "string" ? vv.value : undefined;
      const id = typeof vv.id === "string" ? vv.id : undefined;
      const label = typeof vv.label === "string" ? vv.label : undefined;
      if (value && id) return { type: "SELECT", target: { by: "id", selector: id }, value };
      if (value && label) return { type: "SELECT", target: { by: "label", text: label }, value };
    }
  }

  if (k === "SELECT_CUSTOM") {
    if (v && typeof v === "object") {
      const vv = v as Record<string, unknown>;
      const value = typeof vv.value === "string" ? vv.value : undefined;
      const index = typeof vv.index === "number" ? vv.index : undefined;
      const id = typeof vv.id === "string" ? vv.id : undefined;
      const label = typeof vv.label === "string" ? vv.label : undefined;
      if (value && typeof index === "number") return { type: "SELECT_CUSTOM", target: { by: "index", index, elementType: "field" }, value };
      if (value && id) return { type: "SELECT_CUSTOM", target: { by: "id", selector: id }, value };
      if (value && label) return { type: "SELECT_CUSTOM", target: { by: "label", text: label }, value };
    }
  }

  if (k === "CHECK") {
    if (v && typeof v === "object") {
      const vv = v as Record<string, unknown>;
      const checked = typeof vv.checked === "boolean" ? vv.checked : true;
      const id = typeof vv.id === "string" ? vv.id : undefined;
      const label = typeof vv.label === "string" ? vv.label : undefined;
      if (id) return { type: "CHECK", target: { by: "id", selector: id }, checked };
      if (label) return { type: "CHECK", target: { by: "label", text: label }, checked };
    }
  }

  if (k === "WAIT_FOR") {
    if (typeof v === "string") return { type: "WAIT_FOR", target: { by: "text", text: v }, timeoutMs: 15000 };
    if (v && typeof v === "object") {
      const vv = v as Record<string, unknown>;
      const text = typeof vv.text === "string" ? vv.text : undefined;
      const timeoutMs = typeof vv.timeoutMs === "number" ? vv.timeoutMs : 15000;
      if (text) return { type: "WAIT_FOR", target: { by: "text", text }, timeoutMs };
    }
  }

  if (k === "ASK_USER") {
    if (typeof v === "string") return { type: "ASK_USER", question: v, options: [], allowCustom: true };
    if (v && typeof v === "object") {
      const vv = v as Record<string, unknown>;
      const question = typeof vv.question === "string" ? vv.question : undefined;
      if (question) {
        const options = Array.isArray(vv.options) ? vv.options : [];
        const allowCustom = vv.allowCustom !== false;
        return { type: "ASK_USER", question, options, allowCustom };
      }
    }
  }

  if (k === "DONE") {
    if (typeof v === "string") return { type: "DONE", summary: v };
    if (v && typeof v === "object") {
      const vv = v as Record<string, unknown>;
      const summary = typeof vv.summary === "string" ? vv.summary : "done";
      return { type: "DONE", summary };
    }
  }

  return action;
}

function formatCandidateRegistry(candidates?: CandidateElement[]): string {
  if (!candidates || candidates.length === 0) return "(none)";
  return candidates.map(c => {
    const parts: string[] = [];
    const context = c.context || "PAGE";
    parts.push(`[${context}]`);
    parts.push(c.type || "element");
    parts.push(`vaultyId="${c.vaultyId}"`);
    if (c.text) parts.push(`text="${c.text}"`);
    if (c.label) parts.push(`label="${c.label}"`);
    if (c.ariaLabel) parts.push(`ariaLabel="${c.ariaLabel}"`);
    if (c.attributes?.id) parts.push(`id="${c.attributes.id}"`);
    if (c.attributes?.name) parts.push(`name="${c.attributes.name}"`);
    if (c.attributes?.dataTestId) parts.push(`dataTestId="${c.attributes.dataTestId}"`);
    if (c.formId) parts.push(`form="${c.formId}"`);
    if (c.sectionHeading) parts.push(`section="${c.sectionHeading}"`);
    if (c.isVisible === false) parts.push("hidden");
    if (c.isEnabled === false) parts.push("disabled");
    return parts.join(" ");
  }).join("\n");
}

function formatPageUnderstanding(understanding?: PageUnderstanding): string {
  if (!understanding) return "(none)";
  const blockers = (understanding.blockers || []).join(", ") || "none";
  const primaryActions = understanding.primaryActions && understanding.primaryActions.length > 0
    ? understanding.primaryActions.slice(0, 5).map(action => {
      const parts: string[] = [];
      if (action.vaultyId) parts.push(`vaultyId=${action.vaultyId}`);
      if (action.intent) parts.push(`intent=${action.intent}`);
      if (action.text) parts.push(`text="${action.text}"`);
      if (action.label) parts.push(`label="${action.label}"`);
      if (action.role) parts.push(`role=${action.role}`);
      if (action.reason) parts.push(`reason="${action.reason}"`);
      return `- ${parts.join(" ")}`;
    }).join("\n")
    : "(none)";
  const requiredFields = understanding.requiredFields && understanding.requiredFields.length > 0
    ? understanding.requiredFields.slice(0, 10).map(field => {
      const parts: string[] = [];
      if (field.vaultyId) parts.push(`vaultyId=${field.vaultyId}`);
      if (field.label) parts.push(`label="${field.label}"`);
      if (field.required) parts.push("required");
      if (field.missingProfileData) parts.push("missing_profile_data");
      return `- ${parts.join(" ")}`;
    }).join("\n")
    : "(none)";

  return [
    `pageType=${understanding.pageType}`,
    `primaryGoal=${understanding.primaryGoal}`,
    `blockers=${blockers}`,
    `confidence=${understanding.confidence}`,
    `summary="${understanding.summary}"`,
    `primaryActions:\n${primaryActions}`,
    `requiredFields:\n${requiredFields}`,
  ].join("\n");
}

// ============================================================
// GOAL CONTEXT BUILDER
// ============================================================

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

export function buildGoalContext(state: ApplicationState | undefined): string {
  if (!state) return "";
  
  const { goal, progress, blockers, memory } = state;
  
  let context = `
═══════════════════════════════════════════════════════════════
                      YOUR MISSION
═══════════════════════════════════════════════════════════════
🎯 APPLYING TO: ${goal.jobTitle} at ${goal.company}
📊 PROGRESS: ${progress.estimatedProgress}% complete
📍 PHASE: ${formatPhase(progress.phase)}
${progress.currentSection ? `📋 SECTION: ${progress.currentSection}` : ''}
═══════════════════════════════════════════════════════════════

FOCUS RULES (CRITICAL):
- IGNORE: Cookie banners, promotional content, nav menus, social links, unrelated popups, other job listings / other positions
- FOCUS: Application form fields, login/signup if required, next/continue/submit buttons
- GOAL: Successfully submit THIS job application - never apply to a different position
`;

  // Add blocker awareness
  if (blockers.type) {
    context += `
⚠️ CURRENT BLOCKER: ${blockers.type.toUpperCase()}
Description: ${blockers.description}
Attempts: ${blockers.attemptsMade}
→ You must resolve this blocker before continuing.
`;
  }

  // Add memory of failed patterns (what NOT to do)
  if (memory.failedPatterns.length > 0) {
    context += `
🚫 FAILED ATTEMPTS (do NOT repeat these):
${memory.failedPatterns.slice(-5).map(p => `   × ${p}`).join('\n')}
`;
  }
  
  // Add progress details
  if (progress.fieldsFilledThisPage.length > 0) {
    context += `
✅ FIELDS ALREADY FILLED ON THIS PAGE: ${progress.fieldsFilledThisPage.length}
   (${progress.fieldsFilledThisPage.slice(-5).join(', ')}${progress.fieldsFilledThisPage.length > 5 ? '...' : ''})
`;
  }

  return context;
}

export const SYSTEM_PROMPT = `You are an autonomous Job Application Agent with advanced reasoning capabilities.

MISSION
- Apply to the job at the provided URL.
- Your goal is to reach a successful submission on a job board or employer ATS.

RESPONSE FORMAT
You MUST respond with a JSON object containing THREE fields:
{
  "thinking": "<your step-by-step reasoning about what you see and what to do>",
  "confidence": <0.0 to 1.0 how confident you are in this action>,
  "action": { <EXACTLY ONE action object - NOT an array!> }
}

⚠️ CRITICAL: The "action" field must be a SINGLE action object, NOT an array!
- WRONG: "action": [{"type": "FILL"...}, {"type": "CLICK"...}]
- CORRECT: "action": {"type": "FILL", ...}
You can only perform ONE action per response. If you need to fill a form, fill ONE field at a time.

THINKING PROCESS (required in "thinking" field)
Before choosing an action, reason through:
1. What do I see on the page? (forms, fields, buttons)
2. What is the current state? (which fields are filled, what's next)
3. Are there any blockers? (login required, ambiguous options, popups)
4. What is the best next action? Why?
5. Am I confident, or should I ask the user for help?

CONFIDENCE SCORING
- 0.9-1.0: Very confident - clear next step, unambiguous
- 0.7-0.8: Confident - likely correct but some uncertainty
- 0.5-0.6: Uncertain - multiple valid options, might need guidance
- 0.3-0.4: Low confidence - guessing, should consider ASK_USER
- 0.0-0.2: Very uncertain - strongly consider ASK_USER

OPERATING RULES
- Work step-by-step. You MUST return exactly ONE action per response.
- Do NOT try to batch multiple actions (e.g., fill email + fill password + click login). Do ONE thing at a time.
- Use ONLY the user's profile data provided. Do not invent information.
- BEFORE filling a field, check its current "value" property in the fields list. Skip if already correctly filled!
- If a CANDIDATE REGISTRY is provided, ALWAYS target by vaultyId (by:"vaultyId") for the chosen element.
- If no reliable vaultyId is available, use intent targeting (by:"intent") with role/text/label/attributes.
- Only fall back to id/label/text/index when the registry is missing or empty.
- For multi-step flows, use Next/Continue buttons to proceed.

⚠️ CRITICAL: VALUE SOURCES FOR FILL ACTIONS ⚠️
When filling a field, the "value" MUST come from the USER PROFILE DATA section below.
NEVER use:
- Placeholder text visible in form fields (e.g., "Your Full Name", "Enter email", "123-456-7890")
- The field's label as the value (e.g., don't fill "Full name" into the Full name field)
- Example/sample text that appears inside input boxes
- Text from HTML placeholder attributes

✅ CORRECT: Get the user's actual name from the profile → "value": "John Smith"
❌ WRONG: Copy placeholder "Your Full Name" → "value": "Your Full Name"
❌ WRONG: Use field label → "value": "Full name"

FIELD VALUE AWARENESS (CRITICAL - AVOID LOOPS)
- Each field in the observation shows its current "value". If a field already has the correct value, DO NOT fill it again.
- If you just filled a field and it still shows the old value, the page may need time to update - try a different field or action.
- If you've filled the same field 2+ times in recent actions, STOP and try something else (click submit, fill a different field, or ASK_USER).

ERROR-FIRST RULE (CRITICAL - FIX ERRORS BEFORE NAVIGATION)
- If ANY field shows "⚠️ HAS_ERROR" with an error message, you MUST fix that error FIRST.
- READ the error message carefully - it tells you exactly what's wrong:
  - "required" / "This field is required" → Fill the empty field
  - "invalid email" / "enter valid email" → Correct the email format
  - "password must contain" → Fix password to meet requirements
  - "select an option" / "please choose" → Select a value for the dropdown
  - "minimum X characters" → Add more content to the field
- DO NOT click Next/Continue/Submit if there are visible validation errors - it will fail!
- After fixing a field, wait for the page to re-validate before proceeding.
- If you can't understand the error, use ASK_USER to get help.

PASSWORD FIELDS (SPECIAL HANDLING)
- When you see "Password" AND "Verify Password" (or "Confirm Password") fields, they MUST contain identical values.
- Password requirements (uppercase, length, special chars) apply to BOTH fields equally.
- If you see a password validation ERROR, update the ORIGINAL Password field FIRST with a compliant password, THEN update Verify Password.
- When creating a password that meets requirements, use something like: "SecurePass123!" (uppercase, lowercase, number, special char, 12+ chars).

CRITICAL: HANDLING FAILURES - READ THIS CAREFULLY
- Check the RECENT ACTIONS section below for failed actions (marked with ✗).
- If you see an action that FAILED (✗), DO NOT repeat the same action with the same target.
- When the same action type failed previously, you MUST:
  1. Set your confidence to 0.3 or lower
  2. Try a COMPLETELY DIFFERENT approach:
     - Use a different selector type (e.g., try "by":"index" instead of "by":"text")
     - Try a different element entirely
     - Look for alternative buttons/links with similar meaning
     - Consider if the element might be in an iframe, modal, or dynamically loaded
  3. If you've tried 2+ different approaches and all failed, use ASK_USER
- Repeated failures indicate your understanding of the page is WRONG.
- The element may: not exist, have a different name, be hidden, be in an iframe, or require scrolling.
- DO NOT keep trying the same failed action - this wastes time and frustrates users.

SPECIAL ELEMENT HANDLING
- OAuth buttons: "Sign in with Google", "Continue with LinkedIn", etc. - if user prefers OAuth, click these and request OAUTH verification.
- Resume/CV file uploads: If you see "RESUME FILE AVAILABLE" in USER PROFILE, use UPLOAD_FILE action. If no resume file is available, use ASK_USER.
- Multiple similar buttons: If you see multiple "Apply" or "Submit" buttons, use ASK_USER to let the user choose.
- Cookie/GDPR popups: Click "Accept" or "Close" to dismiss them before proceeding.
- OTP/Verification codes: If "OTP_DETECTED" appears in SPECIAL ELEMENTS, DO NOT attempt to fill OTP fields - the system will automatically fetch and fill the code. Just WAIT_FOR the page to update.
- IMPORTANT: Do NOT mention or assume CAPTCHAs exist unless "CAPTCHA DETECTED" appears in SPECIAL ELEMENTS below. Most job sites don't use visible CAPTCHAs.

DROPDOWN HANDLING (CRITICAL - MANY FORMS USE CUSTOM DROPDOWNS)
There are TWO types of dropdowns:

1. NATIVE <select> (tag="select", has options array):
   - Use SELECT action: {"type":"SELECT","target":{"by":"id","selector":"<id>"},"value":"<option_value>"}
   - The "value" should match the option's value attribute (check the options array in the field)

2. CUSTOM DROPDOWN (isCustomDropdown=true, type="custom-dropdown"):
   - These are div-based dropdowns that require clicking to open, then clicking an option
   - Look for: dropdownExpanded (true/false) and dropdownOptions (list of available options)
   - Option A: Use SELECT_CUSTOM for automatic handling:
     {"type":"SELECT_CUSTOM","target":{"by":"vaultyId","id":"<vaultyId>"},"value":"<option text>"}
   - Option B: Manual two-step approach:
     Step 1: CLICK the dropdown trigger to open it (if dropdownExpanded=false)
     Step 2: In next turn, CLICK the desired option text from dropdownOptions
   - PREFER SELECT_CUSTOM when you see isCustomDropdown=true - it handles the click-open-select flow automatically

DROPDOWN TIPS:
- If SELECT fails on a native select, check if the value matches exactly (case-sensitive)
- If SELECT_CUSTOM fails, fall back to manual CLICK-then-CLICK approach
- Custom dropdowns often show "Select..." or "Choose..." as placeholder - this is NOT a valid selection

ELEMENT CONTEXT PRIORITY (CRITICAL!)
Each element has a context label showing WHERE it is on the page:
- [MODAL] = Element is inside an active modal/dialog - HIGHEST PRIORITY when modal is active
- [NAV] = Element is in the navigation bar - Usually NOT for form submission
- [MAIN] = Element is in main content area - Good for forms
- [FORM] = Element is inside a form
- [SIDEBAR] = Element is in a sidebar
- [FOOTER] = Element is in footer
- [PAGE] = Default/unknown location

MODAL PRIORITY RULES:
- When you see "ACTIVE MODAL" in the observation, ONLY interact with [MODAL] elements!
- Navigation bar buttons (like "Sign In" at index 0) often just open modals - don't keep clicking them
- If clicking a [NAV] button doesn't work after 2 attempts, look for [MODAL] or [MAIN] alternatives
- The same button text may appear in both NAV and MODAL - ALWAYS prefer [MODAL] when modal is active

EXAMPLE:
  If you see: [NAV][0] Sign In  AND  [MODAL][15] Sign In
  And "ACTIVE MODAL: Login" is shown
  → Click the [MODAL][15] one, NOT the [NAV][0] one!

WHEN TO ASK THE USER (ASK_USER action)
Use ASK_USER when:
- 🚨 A REQUIRED field has no matching data in the profile - DO NOT try to submit without it!
- You're unsure which of multiple similar buttons to click
- You've tried an action 2+ times and it keeps failing
- The page state is confusing or unexpected
- You need clarification on ambiguous form questions (e.g., "Are you authorized to work?" when not in profile)

JOB APPLICATION SPECIFICS
- Login vs signup:
  - If a login form is present and the profile has email+password, login.
  - If the site requires account creation, sign up using profile email/password.
  - If there is a "confirm password" field, fill it with the same password.
  - If password is missing and a password field is required, request PASSWORD verification.
- OAuth:
  - If the user prefers OAuth and a "Continue with Google" style option exists, click it and then request OAUTH verification.
- Common ATS fields:
  - Name, email, phone, location/address.
  - Work authorization / visa / sponsorship questions: do NOT guess; if required and missing, use ASK_USER.
  - Experience, education, skills, links (LinkedIn/GitHub/portfolio): use profile/resume context.
  - Resume/CV file uploads: use UPLOAD_FILE action if "RESUME FILE AVAILABLE" is shown in profile context. If no file is available and a text resume field exists, paste resume text instead.

SUBMISSION & SUCCESS
- BEFORE clicking Submit/Next/Continue, verify that ALL REQUIRED fields are filled!
- If any REQUIRED field is empty because profile data is missing, use ASK_USER to request the data first.
- NEVER attempt to submit a form with empty required fields - it will fail with validation errors!
- When the application form is truly complete (all required fields filled), click the most appropriate submit/apply button.
- Use DONE only when there is evidence the application is submitted (confirmation message/page, "thank you", "application submitted", "we received", confirmation number, etc.).
- If you hit blockers (OTP, email code, password prompt, OAuth popup), use REQUEST_VERIFICATION.

ACTIONS (choose exactly one for the "action" field)
- FILL (preferred): {"type":"FILL","target":{"by":"vaultyId","id":"<vaultyId>"},"value":"<value>"}
- FILL (intent fallback): {"type":"FILL","target":{"by":"intent","intent":"fill_field","role":"textbox","label":"Email","text":{"contains":["Email"]}},"value":"<value>"}
- SELECT (native <select>): {"type":"SELECT","target":{"by":"vaultyId","id":"<vaultyId>"},"value":"<option_value>"}
- SELECT_CUSTOM (custom dropdown): {"type":"SELECT_CUSTOM","target":{"by":"vaultyId","id":"<vaultyId>"},"value":"<option text>"}
- CHECK: {"type":"CHECK","target":{"by":"vaultyId","id":"<vaultyId>"},"checked":true}
- CLICK: {"type":"CLICK","target":{"by":"vaultyId","id":"<vaultyId>"}}
- CLICK (intent fallback): {"type":"CLICK","target":{"by":"intent","intent":"submit_application","role":"button","text":{"contains":["Submit","Apply"]}}}
- UPLOAD_FILE: {"type":"UPLOAD_FILE","target":{"by":"vaultyId","id":"<vaultyId>"},"fileType":"resume"}
- WAIT_FOR: {"type":"WAIT_FOR","target":{"by":"intent","intent":"wait_for_text","text":{"contains":["Success","Thank you"]}},"timeoutMs":5000}
- REFRESH_REGISTRY: {"type":"REFRESH_REGISTRY"}
- REQUEST_VERIFICATION: {"type":"REQUEST_VERIFICATION","kind":"OTP"|"EMAIL_CODE"|"PASSWORD"|"OAUTH","context":{"hint":"<why>"}}
  Use for login codes, email verification, password entry, or OAuth popups.
- ASK_USER: {"type":"ASK_USER","question":"<clear question for the user>","options":[{"id":"1","label":"<option 1>"},{"id":"2","label":"<option 2>"}],"allowCustom":true}
  Use ASK_USER if you're stuck or unsure what to click!
- DONE: {"type":"DONE","summary":"<evidence of successful submission>"}

ASK_USER EXAMPLES
- {"type":"ASK_USER","question":"I see two 'Apply' buttons. Which one should I click?","options":[{"id":"1","label":"Blue 'Apply Now' at the top"},{"id":"2","label":"Green 'Quick Apply' in the sidebar"}],"allowCustom":false}
- {"type":"ASK_USER","question":"The form asks 'Are you authorized to work in the US?' but this isn't in your profile. How should I answer?","options":[{"id":"yes","label":"Yes, I am authorized"},{"id":"no","label":"No, I require sponsorship"}],"allowCustom":true}
- {"type":"ASK_USER","question":"A resume file upload is required but no resume file is available in your profile. What should I do?","options":[{"id":"skip","label":"Skip this field"},{"id":"text","label":"Look for a text alternative"},{"id":"stop","label":"Stop and let me upload a resume"}],"allowCustom":true}`;

 

export function buildUserPrompt(
  observation: PageObservation,
  profile: UserProfile,
  step: number,
  actionHistory?: ActionHistory[],
  applicationState?: ApplicationState
): string {
  const profileContext = profileToContext(profile);
  const goalContext = buildGoalContext(applicationState);
  
  // Format fields for LLM (with context labels)
  const fieldsText = observation.fields
    .filter(f => !f.disabled && !f.readonly)
    .map(f => {
      // Start with context label
      let desc = f.context ? `[${f.context}]` : "[PAGE]";
      desc += `[${f.index}] ${f.tag}`;
      if (f.type) desc += ` type="${f.type}"`;
      if (f.id) desc += ` id="${f.id}"`;
      if (f.name) desc += ` name="${f.name}"`;
      if (f.label) desc += ` label="${f.label}"`;
      if (f.placeholder) desc += ` placeholder="${f.placeholder}"`;
      if (f.autocomplete) desc += ` autocomplete="${f.autocomplete}"`;
      if (f.required) desc += ` (required)`;
      if (f.value) desc += ` value="${f.value.slice(0, 50)}${f.value.length > 50 ? '...' : ''}"`;
      if (f.options) {
        const optionsText = f.options.slice(0, 10).map(o => `"${o.text}"`).join(", ");
        desc += ` options=[${optionsText}${f.options.length > 10 ? '...' : ''}]`;
      }
      if (f.checked !== null) desc += ` checked=${f.checked}`;
      // Custom dropdown info
      if (f.isCustomDropdown) {
        desc += ` isCustomDropdown=true`;
        desc += ` dropdownExpanded=${f.dropdownExpanded || false}`;
        if (f.dropdownOptions && f.dropdownOptions.length > 0) {
          const optTexts = f.dropdownOptions.slice(0, 8).map(o => `"${o.text}"`).join(", ");
          desc += ` dropdownOptions=[${optTexts}${f.dropdownOptions.length > 8 ? '...' : ''}]`;
        }
      }
      // Include validation error info
      if (f.hasError) {
        desc += ` ⚠️ HAS_ERROR`;
        if (f.errorMessage) desc += ` error="${f.errorMessage.slice(0, 100)}"`;
      }
      return desc;
    })
    .join("\n");
  
  // Format buttons for LLM (with context labels)
  const buttonsText = observation.buttons
    .filter(b => !b.disabled)
    .map(b => {
      // Start with context label
      let desc = b.context ? `[${b.context}]` : "[PAGE]";
      desc += `[${b.index}] ${b.tag}`;
      if (b.type) desc += ` type="${b.type}"`;
      if (b.id) desc += ` id="${b.id}"`;
      desc += ` text="${b.text}"`;
      return desc;
    })
    .join("\n");

  // Candidate registry (executor v2)
  const candidatesText = formatCandidateRegistry(observation.candidates);
  const understandingText = formatPageUnderstanding(observation.understanding);
  const understandingText = formatPageUnderstanding(observation.understanding);
  const understandingText = formatPageUnderstanding(observation.understanding);
  const understandingText = formatPageUnderstanding(observation.understanding);
  
  // Modal status (important for context priority)
  const modalStatus = observation.hasActiveModal 
    ? `🔴 ACTIVE MODAL DETECTED: "${observation.modalTitle || 'Dialog'}" - Focus ONLY on [MODAL] elements!`
    : "";
  
  // Format profile for LLM
  const profileEntries = Object.entries(profileContext);
  const hasPassword = !!profileContext["password"];
  const profileText = profileEntries
    .map(([key, value]) => {
      const displayValue = value.length > 800 ? value.slice(0, 800) + "..." : value;
      return `${key}: ${displayValue}`;
    })
    .join("\n");
  
  const passwordNote = hasPassword ? "" : "\npassword: (NOT SET - use REQUEST_VERIFICATION kind=PASSWORD)";
  const oauthNote = profile.preferOAuth ? "\nOAuth preference: User prefers 'Login with Google' style buttons" : "";
  
  // Format external data (cover letter, custom fields from Vaulty dashboard)
  let externalDataText = "";
  if (applicationState?.external) {
    const ext = applicationState.external;
    const parts: string[] = [];
    
    // Add cover letter if available
    if (ext.coverLetter) {
      const coverLetterPreview = ext.coverLetter.length > 1500 
        ? ext.coverLetter.slice(0, 1500) + "..." 
        : ext.coverLetter;
      parts.push(`\nCOVER LETTER (use for cover letter fields):\n${coverLetterPreview}`);
    }
    
    // Add custom field answers if available
    if (ext.customFields && Object.keys(ext.customFields).length > 0) {
      parts.push(`\nPRE-FILLED ANSWERS (use these for matching questions):`);
      for (const [fieldName, value] of Object.entries(ext.customFields)) {
        parts.push(`  ${fieldName}: ${value}`);
      }
    }
    
    // Add notes if available
    if (ext.notes) {
      parts.push(`\nAPPLICATION NOTES: ${ext.notes}`);
    }
    
    if (parts.length > 0) {
      externalDataText = parts.join("\n");
    }
  }
  
  // Detect validation errors - prioritize these!
  const errorFields = observation.fields.filter(f => f.hasError);
  let validationErrorsText = "";
  if (errorFields.length > 0) {
    const errorLines = errorFields.slice(0, 10).map(f => {
      const fieldName = f.label || f.name || f.id || `field[${f.index}]`;
      const errorMsg = f.errorMessage || "validation error (check field requirements)";
      return `  ❌ ${fieldName}: "${errorMsg}"`;
    }).join("\n");
    
    validationErrorsText = `
⚠️⚠️⚠️ VALIDATION ERRORS DETECTED - FIX BEFORE PROCEEDING ⚠️⚠️⚠️
${errorLines}

🚨 YOU MUST FIX THESE ERRORS before clicking Next/Continue/Submit!
   Read the error messages - they tell you exactly what's wrong.
   Do NOT try to submit or navigate until all errors are fixed.
`;
  }
  
  // Format special elements if present
  let specialElementsText = "";
  if (observation.specialElements) {
    const se = observation.specialElements;
    const parts: string[] = [];
    if (se.hasCaptcha) parts.push(`CAPTCHA DETECTED (type: ${se.captchaType || "unknown"})`);
    if (se.hasOAuthButtons?.length) parts.push(`OAuth buttons: ${se.hasOAuthButtons.join(", ")}`);
    if (se.hasFileUpload) parts.push("File upload field present");
    if (se.hasPasswordField) parts.push("Password field present");
    // OTP detection - system will auto-fill, LLM should wait
    if ((se as { hasOtpField?: boolean }).hasOtpField) {
      const otpCount = (se as { otpFieldCount?: number }).otpFieldCount || 0;
      parts.push(`OTP_DETECTED (${otpCount} digit fields) - System will auto-fill, just wait`);
    }
    if (parts.length > 0) {
      specialElementsText = `\nSPECIAL ELEMENTS:\n${parts.join("\n")}`;
    }
  }
  
  // Format action history with emphasis on failures
  let historyText = "";
  if (actionHistory && actionHistory.length > 0) {
    const recentHistory = actionHistory.slice(-5); // Last 5 actions
    const failedCount = recentHistory.filter(h => h.result?.ok === false).length;
    
    historyText = "\nRECENT ACTIONS (for context):\n" + recentHistory.map(h => {
      let line = `Step ${h.step}: ${h.action.type}`;
      
      // Add target info for CLICK/FILL actions
      const target = h.action.target as { by?: string; text?: string; selector?: string; index?: number } | undefined;
      if (target) {
        if (target.text) line += ` target="${target.text}"`;
        else if (target.selector) line += ` target="${target.selector}"`;
        else if (target.index !== undefined) line += ` target=index[${target.index}]`;
      }
      
      // Emphasize failures
      if (h.result) {
        if (h.result.ok) {
          line += " ✓ SUCCESS";
        } else {
          line += ` ✗ FAILED: ${h.result.error || "unknown error"}`;
        }
      }
      return line;
    }).join("\n");
    
    // Add warning if there are failures
    if (failedCount > 0) {
      historyText += `\n\n⚠️ WARNING: ${failedCount} of the last ${recentHistory.length} actions FAILED. Do NOT repeat failed actions. Try a different approach.`;
    }
  }
  
  return `${goalContext}
STEP: ${step}
PAGE: ${observation.url}
TITLE: ${observation.title}
${modalStatus ? `\n${modalStatus}\n` : ""}${validationErrorsText}
⭐ USER PROFILE DATA (USE THESE EXACT VALUES FOR FILL ACTIONS):
${profileText || "(No profile data provided)"}${passwordNote}${oauthNote}${externalDataText}
[END OF PROFILE - Do NOT use placeholder text from form fields!]

FORM FIELDS:
${fieldsText || "(No editable fields found)"}

BUTTONS:
${buttonsText || "(No buttons found)"}${specialElementsText}${historyText}

CANDIDATE REGISTRY (use vaultyId for targeting):
${candidatesText}

PAGE UNDERSTANDING (LLM summary, verify against observation):
${understandingText}

PAGE CONTEXT (truncated):
${observation.pageContext.slice(0, 2000)}

Remember: Respond with JSON containing "thinking", "confidence", and "action" fields.
Stay focused on your mission: Apply to "${applicationState?.goal?.jobTitle || 'the job'}" at "${applicationState?.goal?.company || 'the company'}".
What is the next action to take?`;
}

// ============================================================
// MULTI-STEP PLANNING PROMPT (Phase 2)
// ============================================================

export const PLANNING_SYSTEM_PROMPT = `You are a Job Application Agent with MULTI-STEP PLANNING capabilities.

You are analyzing a SCREENSHOT of a form page alongside structured field data extracted from the DOM.

⚠️ CRITICAL - VALUE SOURCES (READ THIS FIRST):
The "value" field in your actions MUST come from the USER PROFILE DATA provided below.
NEVER use:
- Placeholder text from form fields (e.g., "Your Full Name", "Enter your email", "123-456-7890")
- Example/sample text that appears in input fields
- The label of the field itself

✅ CORRECT: "value": "Idrissa Boly" (from profile firstName + lastName)
❌ WRONG: "value": "Your Full Name" (placeholder text from form)
❌ WRONG: "value": "Full name" (this is the label, not a value)

USE THE SCREENSHOT TO:
- Verify field labels match what you see visually on the page
- Identify any fields that might be missing from the DOM extraction (custom components)
- See the VISUAL ORDER of fields (top-to-bottom, left-to-right) - this is your action order
- Spot any error messages, required field indicators (*), or visual cues
- Understand the form layout, section groupings, and which fields belong together
- Identify dropdown menus, comboboxes, and other interactive elements by their appearance

YOUR MISSION: Analyze ALL visible form fields and create a COMPLETE PLAN using REAL PROFILE DATA.

RESPONSE FORMAT (JSON):
{
  "thinking": "<your analysis - INCLUDE which profile values you're using for each field>",
  "confidence": <0.0 to 1.0>,
  "plan": [
    {
      "action": {"type":"FILL","target":{"by":"vaultyId","id":"<vaultyId>"},"value":"<ACTUAL firstName lastName from profile>"},
      "fieldName": "Full name",
      "expectedResult": "Name field filled with profile name"
    },
    {
      "action": {"type":"FILL","target":{"by":"vaultyId","id":"<vaultyId>"},"value":"<ACTUAL email from profile>"},
      "fieldName": "Email",
      "expectedResult": "Email field filled with profile email"
    },
    {
      "action": {"type":"FILL","target":{"by":"vaultyId","id":"<vaultyId>"},"value":"<ACTUAL phone from profile>"},
      "fieldName": "Phone",
      "expectedResult": "Phone field filled with profile phone"
    },
    {
      "action": {"type":"CLICK","target":{"by":"vaultyId","id":"<vaultyId>"}},
      "fieldName": "Submit button",
      "expectedResult": "Form submitted"
    }
  ],
  "currentStepIndex": 0
}

PLANNING RULES:
1. ANALYZE ALL FIELDS: Look at every field on the page before creating the plan.
2. SKIP FILLED FIELDS: If a field already has the correct value, don't include it in the plan.
3. USE vaultyId TARGETING: If CANDIDATE REGISTRY is provided, target by vaultyId for all actions.
4. HUMAN-READABLE fieldName: The "fieldName" must be the field's visible label for HUD display.
5. ORDER MATTERS: Plan actions in top-to-bottom, left-to-right order as fields appear on the form.
6. END WITH NAVIGATION: Last action should be clicking Next/Continue/Submit ONLY if all REQUIRED fields are filled.
7. MAX 10 STEPS: Keep plans to 10 actions max. If more fields exist, end with the navigation button.

🚨 REQUIRED FIELDS WITH MISSING DATA - NEVER SUBMIT WITHOUT THEM! 🚨
If a REQUIRED field has no profile data (shows "⚠️ NOT SET"):
- DO NOT include Submit/Next/Continue as your last action!
- Instead, end your plan with ASK_USER to request the missing data
- Example: {"type":"ASK_USER","question":"The form requires 'Full name' and 'LinkedIn URL' but these aren't in your profile. Please provide them.","options":[],"allowCustom":true}
- Only proceed to Submit AFTER the user provides the missing required data

FIELD TARGETING (CRITICAL):
- PREFERRED: {"by":"vaultyId","id":"<vaultyId>"} - Use candidate registry
- FALLBACK: {"by":"intent","intent":"fill_field","role":"textbox","label":"Full name"} - Provide intent + label
- LAST RESORT: {"by":"label","text":"Full name"} or {"by":"id","selector":"input-name"}

⭐ PROFILE DATA → FIELD MAPPING (USE THESE VALUES):
- "Full name" / "Name" field → Use: firstName + " " + lastName from profile
- "Email" field → Use: email from profile  
- "Phone" / "Phone number" field → Use: phone from profile
- "LinkedIn" / "LinkedIn URL" field → Use: linkedIn from profile
- "GitHub" / "GitHub URL" field → Use: github from profile
- "Portfolio" / "Portfolio URL" / "Website" field → Use: portfolio from profile
- "Location" / "City" / "Current location" field → Use: location from profile

⚠️ MISSING DATA HANDLING (CRITICAL):
- If profile data shows "⚠️ NOT SET" for an OPTIONAL field, skip it in your plan
- If profile data shows "⚠️ NOT SET" for a REQUIRED field (marked with ✱ or "required"):
  → DO NOT proceed to Submit/Next/Continue!
  → End your plan with ASK_USER to request the missing data from the user
  → List ALL missing required fields in your ASK_USER question
- NEVER put "ASK_USER" as a FILL value - that's meaningless text!
- NEVER attempt to submit a form with empty required fields - it will fail!

DO NOT INCLUDE IN PLAN:
- Fields that already have correct values
- Hidden fields
- Disabled/readonly fields

FILE UPLOAD HANDLING:
If you see a Resume/CV file upload field AND "RESUME FILE AVAILABLE" appears in the profile:
- Add UPLOAD_FILE action to your plan: {"type":"UPLOAD_FILE","target":{"by":"vaultyId","id":"<vaultyId>"},"fileType":"resume"}
  (Fallback: {"by":"index","index":<n>,"elementType":"field"} if no vaultyId exists)
- If no resume file is available, do NOT include file upload in the plan (ask user separately)

WHEN TO RE-PLAN (you'll be asked to create a new plan when):
- Page URL changes (navigated to new page)
- Validation errors appear after submission attempt
- Modal/popup appears
- A planned action fails`;

export function buildPlanningPrompt(
  observation: PageObservation,
  profile: UserProfile,
  step: number,
  applicationState?: ApplicationState
): string {
  const profileContext = profileToContext(profile);
  const goalContext = buildGoalContext(applicationState);
  const hasResumeFile = !!profileContext["RESUME FILE AVAILABLE"];
  const candidatesText = formatCandidateRegistry(observation.candidates);
  
  // Check for file upload fields
  const fileUploadFields = observation.fields.filter(f => f.type === "file");
  
  // Format fields with detailed info for planning (exclude file inputs - handled separately)
  const fieldsForPlanning = observation.fields
    .filter(f => !f.disabled && !f.readonly && f.type !== "hidden" && f.type !== "file")
    .map(f => {
      const label = f.label || f.name || f.id || `field_${f.index}`;
      const currentValue = f.value ? `"${f.value.slice(0, 50)}"` : "(empty)";
      const required = f.required ? " (REQUIRED)" : "";
      const error = f.hasError ? ` ⚠️ ERROR: ${f.errorMessage || "validation error"}` : "";
      
      let fieldInfo = `- "${label}"${required}: currently ${currentValue}${error}`;
      
      // Add type-specific info
      if (f.type === "select" && f.options) {
        const opts = f.options.slice(0, 5).map(o => o.text).join(", ");
        fieldInfo += `\n    Options: [${opts}${f.options.length > 5 ? ", ..." : ""}]`;
      }
      if (f.isCustomDropdown) {
        fieldInfo += ` (custom dropdown)`;
        if (f.dropdownOptions && f.dropdownOptions.length > 0) {
          const opts = f.dropdownOptions.slice(0, 5).map(o => o.text).join(", ");
          fieldInfo += `\n    Options: [${opts}${f.dropdownOptions.length > 5 ? ", ..." : ""}]`;
        }
      }
      
      return fieldInfo;
    })
    .join("\n");
  
  // Format buttons
  const buttonsText = observation.buttons
    .filter(b => !b.disabled)
    .slice(0, 10)
    .map(b => `- "${b.text}" [${b.context || "PAGE"}]`)
    .join("\n");
  
  // Profile summary for value mapping - explicit format to prevent placeholder copying
  const fullName = [profileContext["firstName"], profileContext["lastName"]].filter(Boolean).join(" ");
  
  // Check which profile fields are available
  const profileAvailable = {
    fullName: !!fullName,
    email: !!profileContext["email"],
    phone: !!profileContext["phone"],
    location: !!profileContext["location"],
    country: !!profileContext["country"],
    linkedIn: !!profileContext["linkedIn"],
    github: !!profileContext["github"],
    portfolio: !!profileContext["portfolio"],
  };
  
  // Find required fields that are missing from profile
  const requiredFieldsMissingData: string[] = [];
  observation.fields.forEach(f => {
    if (!f.required || f.disabled || f.readonly || f.value) return; // Skip non-required, disabled, or already filled
    
    const label = (f.label || f.name || "").toLowerCase();
    
    // Check if this required field has matching profile data
    if ((label.includes("name") || label.includes("full name")) && !profileAvailable.fullName) {
      requiredFieldsMissingData.push("Full name");
    } else if ((label.includes("location") || label.includes("city") || label.includes("address")) && !profileAvailable.location) {
      requiredFieldsMissingData.push("Location");
    } else if (label.includes("email") && !profileAvailable.email) {
      requiredFieldsMissingData.push("Email");
    } else if (label.includes("phone") && !profileAvailable.phone) {
      requiredFieldsMissingData.push("Phone number");
    } else if (label === "country" || label.startsWith("country ") || label.endsWith(" country") || label.includes("country*")) {
      if (!profileAvailable.country) requiredFieldsMissingData.push("Country");
    } else if (label.includes("linkedin") && !profileAvailable.linkedIn) {
      requiredFieldsMissingData.push("LinkedIn URL");
    } else if (label.includes("portfolio") || label.includes("website")) {
      if (!profileAvailable.portfolio) requiredFieldsMissingData.push("Portfolio URL");
    } else if (label.includes("github") && !profileAvailable.github) {
      requiredFieldsMissingData.push("GitHub URL");
    }
  });
  
  // Remove duplicates
  const uniqueMissingRequired = [...new Set(requiredFieldsMissingData)];
  
  // Create warning for missing required fields
  let missingRequiredWarning = "";
  if (uniqueMissingRequired.length > 0) {
    missingRequiredWarning = `
🚨🚨🚨 BLOCKING: REQUIRED FIELDS WITH MISSING DATA 🚨🚨🚨
The following REQUIRED fields cannot be filled because profile data is missing:
${uniqueMissingRequired.map(f => `  ❌ ${f}`).join("\n")}

⛔ DO NOT INCLUDE "Submit" OR "Next" IN YOUR PLAN!
⛔ You MUST end your plan with ASK_USER to request these missing values.
⛔ Example last action: {"type":"ASK_USER","question":"The form requires: ${uniqueMissingRequired.join(", ")}. Please provide these values.","options":[],"allowCustom":true}
`;
  }
  
  const profileSummary = `
⭐ USER PROFILE DATA (USE THESE EXACT VALUES FOR FILL ACTIONS):
┌─────────────────────────────────────────────────────────────────────────
│ Full name:  ${fullName ? `"${fullName}"` : "⚠️ NOT SET"}
│ Email:      ${profileContext["email"] ? `"${profileContext["email"]}"` : "⚠️ NOT SET"}
│ Phone:      ${profileContext["phone"] ? `"${profileContext["phone"]}"` : "⚠️ NOT SET"}
│ Location:   ${profileContext["location"] ? `"${profileContext["location"]}"` : "⚠️ NOT SET"}
│ LinkedIn:   ${profileContext["linkedIn"] ? `"${profileContext["linkedIn"]}"` : "⚠️ NOT SET"}
│ GitHub:     ${profileContext["github"] ? `"${profileContext["github"]}"` : "⚠️ NOT SET"}
│ Portfolio:  ${profileContext["portfolio"] ? `"${profileContext["portfolio"]}"` : "⚠️ NOT SET"}
└─────────────────────────────────────────────────────────────────────────
${missingRequiredWarning}
⚠️ CRITICAL RULES FOR MISSING DATA:
- If a field shows "⚠️ NOT SET" above and is OPTIONAL, skip it in your plan
- If a field shows "⚠️ NOT SET" above and is REQUIRED, you MUST use ASK_USER (never submit!)
- NEVER fill placeholder text like "Your Full Name" or "ASK_USER" as values
- Only use FILL with actual data values shown in quotes above`;

  // File upload info
  let fileUploadSection = "";
  if (fileUploadFields.length > 0) {
    const fileField = fileUploadFields[0]; // Usually just one resume upload
    const fileLabel = fileField.label || fileField.name || "Resume/CV";
    const fileCandidate = observation.candidates?.find(c => {
      if (!c.attributes) return false;
      if (c.attributes.type && c.attributes.type !== "file") return false;
      if (fileField.id && c.attributes.id === fileField.id) return true;
      if (fileField.name && c.attributes.name === fileField.name) return true;
      return false;
    });
    const fileTarget = fileCandidate
      ? `{"by":"vaultyId","id":"${fileCandidate.vaultyId}"}`
      : `{"by":"index","index":${fileField.index},"elementType":"field"}`;
    if (hasResumeFile) {
      fileUploadSection = `
📎 FILE UPLOAD REQUIRED:
- Field: "${fileLabel}" [index ${fileField.index}]
- ✅ RESUME FILE AVAILABLE: ${profileContext["RESUME FILE AVAILABLE"]}
- ACTION TO ADD: {"type":"UPLOAD_FILE","target":${fileTarget},"fileType":"resume"}
  Include this action FIRST in your plan!`;
    } else {
      fileUploadSection = `
📎 FILE UPLOAD REQUIRED:
- Field: "${fileLabel}" [index ${fileField.index}]
- ⚠️ NO RESUME FILE AVAILABLE - Skip file upload, or use ASK_USER if required`;
    }
  }

  return `${goalContext}
MULTI-STEP PLANNING REQUEST
===========================
STEP: ${step}
PAGE: ${observation.url}
TITLE: ${observation.title}

${profileSummary}
${fileUploadSection}

FORM FIELDS TO ANALYZE:
${fieldsForPlanning || "(No editable fields found)"}

AVAILABLE BUTTONS:
${buttonsText || "(No buttons found)"}

CANDIDATE REGISTRY (use vaultyId for targeting):
${candidatesText}

PAGE UNDERSTANDING (LLM summary, verify against observation):
${understandingText}

PAGE CONTEXT (truncated):
${(observation.pageContext || "").slice(0, 1500)}

INSTRUCTIONS:
1. Analyze each field above
2. Match fields to profile data
3. Create a plan to fill all empty fields that have profile data available
4. If file upload is required and resume is available, include UPLOAD_FILE action FIRST
5. CHECK: Are there any REQUIRED fields with missing profile data?
   - If YES: End your plan with ASK_USER to request the missing data (DO NOT submit!)
   - If NO: End with clicking the appropriate navigation button (Next/Continue/Submit)
6. Return JSON with "thinking", "confidence", "plan", and "currentStepIndex"`;
}

// Vision-specific system prompt when screenshot is provided
export const VISION_SYSTEM_PROMPT = `You are an autonomous Job Application Agent analyzing a SCREENSHOT to find the NEXT BEST ACTION.

YOUR MISSION:
Continue the job application process by identifying the next actionable step. The agent got stuck, and you must find a way forward by looking at what's ACTUALLY on screen.

PRIORITY ORDER FOR ACTIONS:
1. DISMISS BLOCKERS FIRST: Cookie banners, popups, modals, overlays - click "Accept", "Close", "X", or "Dismiss"
2. LOGIN (if credentials available): Fill email/password fields and click login/sign-in button
3. OAUTH (if no credentials or login fails): Click "Continue with Google/LinkedIn" buttons
4. SIGNUP (if no account exists): Fill registration form fields
5. FILL FORM FIELDS: Fill empty required fields (name, email, phone, etc.)
6. NAVIGATE: Click "Next", "Continue", "Apply", "Submit" buttons
7. COMPLETE: Look for confirmation messages indicating success

WHAT TO LOOK FOR IN THE SCREENSHOT:
- Login/Sign-in forms with email and password fields
- "Continue with Google/LinkedIn/GitHub" OAuth buttons
- Form input fields (text boxes, dropdowns, checkboxes)
- Navigation buttons ("Next", "Continue", "Apply Now", "Submit", "Easy Apply")
- Blocking overlays (cookie banners, popups, modals - dismiss them first)
- Error messages or validation warnings
- Confirmation/success messages
- Job application buttons (Apply, Easy Apply, Quick Apply)

TARGETING RULES (CRITICAL):
- If CANDIDATE REGISTRY is provided in the prompt, always target by vaultyId.
- Use intent/text targeting only if no suitable vaultyId exists.

WHEN SOMETHING BLOCKS THE WAY:
- Cookie/GDPR banner → Click "Accept" or "Accept All" or "Close"
- Modal/popup → Click "X" or "Close" or click outside to dismiss
- OTP/Email code required → Use REQUEST_VERIFICATION with kind="OTP"
- Page still loading → Use WAIT_FOR with appropriate text

SMART RETRY - ELEMENT CONTEXT PRIORITY:
When retrying after a failed click, pay attention to element CONTEXT labels:
- [MODAL] = Element inside a modal/dialog - HIGHEST PRIORITY when modal is active
- [NAV] = Element in navigation bar - Often triggers modals, NOT the action itself
- [MAIN] = Element in main content - Good for forms and primary actions
- [FORM] = Element inside a form

If you clicked a [NAV] button (e.g., [NAV][0] "Sign In") and nothing happened:
→ Look for a [MODAL] or [MAIN] button with similar text at a HIGHER index
→ Example: If [NAV][0] "Sign In" failed, try [MODAL][15] "Sign In" instead

When "SUGGESTED ALTERNATIVES" are provided, USE THEM! They are sorted by priority.

RESPONSE FORMAT:
{
  "thinking": "<1. What I see on the page 2. What's blocking or what needs to be done 3. The specific action I recommend>",
  "confidence": <0.0 to 1.0>,
  "action": { <EXACTLY ONE action to execute - NOT an array!> }
}

⚠️ CRITICAL: Return ONLY ONE action at a time, NOT an array of actions!
- WRONG: "action": [{"type": "FILL"...}, {"type": "CLICK"...}]  
- CORRECT: "action": {"type": "FILL", ...}
If login needs email + password, fill EMAIL first. Password will be filled in the next step.

ACTION EXAMPLES:
- Fill field (preferred): {"type":"FILL","target":{"by":"vaultyId","id":"<vaultyId>"},"value":"john@email.com"}
- Click button (preferred): {"type":"CLICK","target":{"by":"vaultyId","id":"<vaultyId>"}}
- Click Apply button (intent fallback): {"type":"CLICK","target":{"by":"intent","intent":"apply","role":"button","text":{"contains":["Apply","Easy Apply"]}}}
- Dismiss cookie: {"type":"CLICK","target":{"by":"text","text":"Accept"}}
- Navigate/progress: {"type":"CLICK","target":{"by":"text","text":"Next"}} or {"type":"CLICK","target":{"by":"text","text":"Continue"}}
- When stuck/unsure: {"type":"ASK_USER","question":"I see multiple buttons but unsure which to click. Can you help?","options":[...],"allowCustom":true}

⚠️ CRITICAL: If CANDIDATE REGISTRY is present, use vaultyId for clicks (most reliable).
Use text-based targeting only if vaultyId is unavailable. Avoid index targeting.

IF COMPLETELY BLOCKED (blank page, error, no visible actions):
Use ASK_USER to request human assistance:
{"type":"ASK_USER","question":"<describe what you see and ask for help>","options":[...],"allowCustom":true}`;

// Initial vision bootstrap system prompt (used for first 2 steps to handle redirects)
export const INITIAL_VISION_SYSTEM_PROMPT = `You are an autonomous Job Application Agent analyzing a SCREENSHOT at the START of a run.

PRIMARY OBJECTIVE:
- Identify the correct entry point to apply for the SPECIFIC target job.
- Do NOT click or navigate to any other job listing/position.

COMMON FLOW (expect 2 steps before reaching the form):
1. STEP 1: You're on a job board (ZipRecruiter, Indeed, LinkedIn) → Click "Apply" or "Easy Apply"
2. STEP 2: You're redirected to company's ATS (Lever, Greenhouse, Workday) → Click "Apply for this job" or similar
3. STEP 3+: Now you should see the actual application form with fields to fill

If you're on step 1-2 and don't see form fields yet, that's EXPECTED! Just click the Apply button.

CRITICAL RULES (ANTI-HALLUCINATION):
1. You must VERIFY the page matches the target job (job title/company) before you click anything.
2. If the screen shows multiple job cards/listings, you MUST ignore them unless you can clearly see the target job title/company on one of them.
3. If you cannot confidently identify the target job on screen, respond with ASK_USER and explain what you see.
4. Look for these action buttons/links: "Apply", "Apply now", "Easy Apply", "Apply for this job", "Start application", "Continue", "Next".
5. Dismiss blocking overlays first (cookie banners, popups).
6. On company ATS pages (Lever, Greenhouse, Workday), the "Apply" button is often a styled LINK, not a button - look for it!

TARGETING RULES (CRITICAL):
- If CANDIDATE REGISTRY is provided in the prompt, always target by vaultyId.
- Use intent/text targeting only if no suitable vaultyId exists.

RESPONSE FORMAT:
{
  "thinking": "<what I see + how I verified it's the target job + why this is the best next action>",
  "confidence": <0.0 to 1.0>,
  "action": { <EXACTLY ONE action object> }
}

ACTION SCHEMA (use EXACTLY these shapes):
- CLICK: {"type":"CLICK","target":{"by":"vaultyId","id":"<vaultyId>"}} (preferred)
  Fallback: {"type":"CLICK","target":{"by":"intent","intent":"apply","role":"button","text":{"contains":["Apply","Easy Apply"]}}}
- FILL: {"type":"FILL","target":{"by":"vaultyId","id":"<vaultyId>"},"value":"<value>"}
  or {"type":"FILL","target":{"by":"intent","intent":"fill_field","role":"textbox","label":"<field label>"},"value":"<value>"}
- SELECT: {"type":"SELECT","target":{"by":"vaultyId","id":"<vaultyId>"},"value":"<option>"}
- CHECK: {"type":"CHECK","target":{"by":"vaultyId","id":"<vaultyId>"},"checked":true}
- WAIT_FOR: {"type":"WAIT_FOR","target":{"by":"text","text":"<text to appear>"},"timeoutMs":15000}
- ASK_USER: {"type":"ASK_USER","question":"<question>","options":[...],"allowCustom":true}
- DONE: {"type":"DONE","summary":"<evidence of submission>"}

CLICK RULE:
- Prefer vaultyId if available. Use intent or text only if vaultyId is missing.
- Do NOT return shorthand like {"CLICK":"Apply"}. Always return the full object with "type" and "target".
`;

export function buildInitialVisionPrompt(
  observation: PageObservation,
  profile: UserProfile,
  step: number,
  applicationState?: ApplicationState
): string {
  const profileContext = profileToContext(profile);
  const goal = applicationState?.goal;
  const candidatesText = formatCandidateRegistry(observation.candidates);

  const goalLine = goal
    ? `TARGET JOB: "${goal.jobTitle}" at "${goal.company}"\nJOB URL (reference): ${goal.jobUrl}`
    : `TARGET JOB: (unknown - missing applicationState.goal)\nJOB URL (reference): ${observation.url}`;

  const hasEmail = !!profileContext["email"];
  const hasPassword = !!profileContext["password"];

  // Determine context based on step
  const stepContext = step === 1 
    ? "This is STEP 1 - you're likely on a job board. Look for the Apply button."
    : step === 2 
    ? "This is STEP 2 - you may have been redirected to the company's ATS (Lever, Greenhouse, Workday). Look for another Apply button/link to open the actual form."
    : `This is STEP ${step} - you should be in the application form now.`;

  return `INITIAL VISION BOOTSTRAP (Step ${step}/2)
==========================================

${goalLine}
CURRENT PAGE URL: ${observation.url}
PAGE TITLE: ${observation.title}

${stepContext}

PROFILE STATUS:
- email: ${hasEmail ? "available" : "missing"}
- password: ${hasPassword ? "available" : "missing"}
- preferOAuth: ${profile.preferOAuth === true ? "true" : "false"}

YOUR TASK:
1) Look at the screenshot.
2) VERIFY you are acting on the target job (title/company) and NOT another listing.
3) If step 1-2 and no form fields visible, click the "Apply" / "Apply for this job" button/link.
4) If form fields are visible, start filling them.

WHAT TO DO IF THIS IS A JOB LISTINGS PAGE:
- Only click a job card if it clearly matches the target job title/company.
- Otherwise, look for a way to open the application for the target job without switching listings (e.g., already on job detail page).

DOM SUMMARY (may be incomplete vs screenshot):
- Buttons (sample): ${observation.buttons?.slice(0, 10).map(b => `"${b.text}"`).join(", ") || "none"}
- Fields (sample): ${observation.fields?.slice(0, 8).map(f => `${f.type || f.tag}${f.label ? `(${f.label})` : ""}`).join(", ") || "none"}

CANDIDATE REGISTRY (use vaultyId for targeting when possible):
${candidatesText}

PAGE UNDERSTANDING (LLM summary, verify against observation):
${understandingText}

PAGE CONTEXT (truncated):
${(observation.pageContext || "").slice(0, 1200)}
`;
}

// Build vision-enhanced user prompt
export function buildVisionPrompt(
  observation: PageObservation,
  profile: UserProfile,
  step: number,
  loopContext?: LoopContext
): string {
  const profileContext = profileToContext(profile);
  const failedAction = loopContext?.failedAction;
  const failedTarget = failedAction?.target?.text || failedAction?.target?.selector || "unknown";
  const candidatesText = formatCandidateRegistry(observation.candidates);
  
  // Determine credentials status
  const hasEmail = !!profileContext["email"];
  const hasPassword = !!profileContext["password"];
  const hasCredentials = hasEmail && hasPassword;
  const prefersOAuth = profile.preferOAuth === true;
  
  // Build credentials status message
  let credentialsStatus = "";
  if (hasCredentials) {
    credentialsStatus = `✓ User has login credentials (email: ${profileContext["email"]}, password: available)
→ PRIORITY: Try to LOGIN with these credentials first`;
  } else if (hasEmail && !hasPassword) {
    credentialsStatus = `⚠ User has email (${profileContext["email"]}) but NO password saved
→ If password field exists, use REQUEST_VERIFICATION kind="PASSWORD"
→ Or look for OAuth options (Continue with Google, etc.)`;
  } else {
    credentialsStatus = `⚠ No login credentials available
→ Look for OAuth buttons (Continue with Google/LinkedIn)
→ Or signup/registration options`;
  }
  
  if (prefersOAuth) {
    credentialsStatus += `\n→ User PREFERS OAuth login (Continue with Google, etc.)`;
  }

  // Determine what we're trying to accomplish
  const urlLower = observation.url.toLowerCase();
  let currentGoal = "Continue with the job application process";
  if (urlLower.includes("login") || urlLower.includes("signin") || urlLower.includes("sign-in")) {
    currentGoal = "Log in to the account to proceed with the application";
  } else if (urlLower.includes("signup") || urlLower.includes("register") || urlLower.includes("create")) {
    currentGoal = "Create an account to proceed with the application";
  } else if (urlLower.includes("apply") || urlLower.includes("application") || urlLower.includes("career")) {
    currentGoal = "Fill out the job application form";
  }

  return `SCREENSHOT ANALYSIS REQUEST
==========================

CURRENT GOAL: ${currentGoal}
PAGE URL: ${observation.url}
STEP: ${step}

CREDENTIALS STATUS:
${credentialsStatus}

WHAT WENT WRONG:
The previous action "${failedAction?.type || 'unknown'}" targeting "${failedTarget}" FAILED ${loopContext?.failCount || 0} times.
Error: ${loopContext?.error || "target not found"}
${loopContext?.suggestedAlternatives && loopContext.suggestedAlternatives.length > 0 ? `
SUGGESTED ALTERNATIVES (try these instead!):
${loopContext.suggestedAlternatives.map(alt => `- [${alt.context}][${alt.index}] "${alt.text}" ${alt.context === 'MODAL' ? '← PRIORITY: This is in a modal!' : ''}`).join('\n')}
` : ''}
YOUR TASK:
Look at the attached screenshot and find the NEXT BEST ACTION to continue the job application process.

QUESTIONS TO ANSWER:
1. What do you see on the page? (login form? application form? popup blocking?)
2. Is there something blocking the way? (cookie banner, modal, overlay?)
3. What is the single best next action to move forward?
4. Focus on CLICKABLE elements: buttons, links, form fields that need filling.

DOM-DETECTED ELEMENTS (may not match screenshot):
Buttons: ${observation.buttons?.slice(0, 8).map(b => `[${b.index}] "${b.text}"`).join(", ") || "none"}
Fields: ${observation.fields?.slice(0, 6).map(f => `[${f.index}] ${f.type}`).join(", ") || "none"}

CANDIDATE REGISTRY (use vaultyId for targeting when possible):
${candidatesText}

PAGE UNDERSTANDING (LLM summary, verify against observation):
${understandingText}

IMPORTANT: Return the SPECIFIC action to execute next. Prefer vaultyId; use intent/text only if no vaultyId is available.`;
}

// ============================================================
// PAGE UNDERSTANDING PROMPT (pre-planning)
// ============================================================

export const UNDERSTANDING_SYSTEM_PROMPT = `You are a PAGE UNDERSTANDING agent for a job application assistant.

Your job is to interpret the page, NOT to plan or choose actions.
You MUST return a JSON object that summarizes the page and key blockers.

RESPONSE FORMAT (JSON only):
{
  "pageType": "job_listing | application_form | login | signup | review | confirmation | error | unknown",
  "primaryGoal": "<short goal, e.g. fill_form, login, choose_job, submit, wait>",
  "blockers": ["cookie_banner", "captcha", "otp", "file_upload", "modal_blocking", "validation_errors", "unknown"],
  "summary": "<1-2 sentence plain summary of the page>",
  "confidence": 0.0-1.0,
  "requiredFields": [
    { "vaultyId": "<id>", "label": "<label>", "required": true, "missingProfileData": false }
  ],
  "primaryActions": [
    { "vaultyId": "<id>", "intent": "submit_application", "reason": "main CTA" }
  ]
}

RULES:
- Use vaultyId whenever possible (from the candidate registry).
- Do NOT return actions or plans.
- If unsure, use pageType "unknown" and explain in summary.
- Keep blockers conservative; only include blockers you have evidence for.
`;

export function buildUnderstandingPrompt(
  observation: PageObservation,
  profile: UserProfile,
  step: number,
  applicationState?: ApplicationState
): string {
  const profileContext = profileToContext(profile);
  const goalContext = buildGoalContext(applicationState);
  const candidatesText = formatCandidateRegistry(observation.candidates);
  const understandingText = formatPageUnderstanding(observation.understanding);

  const fieldsText = observation.fields
    .map(f => {
      const label = f.label || f.name || f.id || `field_${f.index}`;
      const required = f.required ? "required" : "optional";
      const value = f.value ? `"${f.value.slice(0, 50)}"` : "(empty)";
      return `- ${label} (${required}) value=${value}`;
    })
    .join("\n");

  const buttonsText = observation.buttons
    .map(b => `- ${b.text} [${b.context || "PAGE"}]`)
    .join("\n");

  const profileSummary = Object.entries(profileContext)
    .map(([key, value]) => `${key}: ${value.length > 200 ? value.slice(0, 200) + "..." : value}`)
    .join("\n");

  return `${goalContext}
PAGE UNDERSTANDING REQUEST
==========================
STEP: ${step}
PAGE: ${observation.url}
TITLE: ${observation.title}

PROFILE (for missing data detection):
${profileSummary || "(No profile data provided)"}

FIELDS:
${fieldsText || "(No fields found)"}

BUTTONS:
${buttonsText || "(No buttons found)"}

SPECIAL ELEMENTS:
${observation.specialElements ? JSON.stringify(observation.specialElements) : "(none)"}

CANDIDATE REGISTRY (use vaultyId for references):
${candidatesText}

PREVIOUS UNDERSTANDING (if any):
${understandingText}

PAGE CONTEXT (truncated):
${(observation.pageContext || "").slice(0, 1500)}
`;
}

export function parseUnderstandingResponse(response: string): PageUnderstanding {
  let jsonStr = response.trim();
  if (jsonStr.startsWith("```")) {
    const lines = jsonStr.split("\n");
    lines.shift();
    if (lines[lines.length - 1] === "```") {
      lines.pop();
    }
    jsonStr = lines.join("\n");
  }
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      pageType: parsed.pageType || "unknown",
      primaryGoal: parsed.primaryGoal || "unknown",
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
      summary: String(parsed.summary || ""),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      requiredFields: Array.isArray(parsed.requiredFields) ? parsed.requiredFields : [],
      primaryActions: Array.isArray(parsed.primaryActions) ? parsed.primaryActions : [],
    };
  } catch (e) {
    console.error("[LLM] Failed to parse understanding response:", response);
    return {
      pageType: "unknown",
      primaryGoal: "unknown",
      blockers: [],
      summary: "Unable to parse understanding response.",
      confidence: 0.1,
      requiredFields: [],
      primaryActions: [],
    };
  }
}

export function parseActionResponse(response: string): EnhancedLLMResponse {
  // Try to extract JSON from the response
  let jsonStr = response.trim();
  
  // Remove markdown code blocks if present
  if (jsonStr.startsWith("```")) {
    const lines = jsonStr.split("\n");
    lines.shift(); // Remove opening ```json or ```
    if (lines[lines.length - 1] === "```") {
      lines.pop(); // Remove closing ```
    }
    jsonStr = lines.join("\n");
  }
  
  // Try to find JSON object in the response
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }
  
  try {
    const parsed = JSON.parse(jsonStr);
    
    // Handle both old format (just action) and new format (thinking + confidence + action)
    if (parsed.thinking !== undefined && parsed.action !== undefined) {
      // New enhanced format
      let action = normalizeShorthandAction(parsed.action);
      
      // DEFENSIVE: If LLM returned an array of actions, take only the first one
      if (Array.isArray(action)) {
        console.warn("[LLM] WARNING: LLM returned an array of actions. Taking only the first one:", action);
        if (action.length === 0) {
          throw new Error("LLM returned an empty array of actions");
        }
        action = normalizeShorthandAction(action[0]);
      }
      
      return {
        thinking: String(parsed.thinking || ""),
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
        action: action,
      };
    } else if (parsed.type) {
      // Old format - action object directly
      return {
        thinking: "(No reasoning provided)",
        confidence: 0.7, // Default confidence
        action: normalizeShorthandAction(parsed),
      };
    } else if (Array.isArray(parsed)) {
      // DEFENSIVE: If LLM returned a bare array, take first element
      console.warn("[LLM] WARNING: LLM returned a bare array of actions. Taking only the first one:", parsed);
      if (parsed.length === 0) {
        throw new Error("LLM returned an empty array of actions");
      }
      return {
        thinking: "(No reasoning provided - LLM returned array)",
        confidence: 0.5, // Lower confidence since format was wrong
        action: normalizeShorthandAction(parsed[0]),
      };
    } else {
      throw new Error("Response missing required fields");
    }
  } catch (e) {
    console.error("[LLM] Failed to parse action response:", response);
    throw new Error(`Failed to parse LLM response as JSON: ${e}`);
  }
}

// Interface for parsed planning response
export interface ParsedPlanningResponse {
  thinking: string;
  confidence: number;
  plan: Array<{
    action: unknown;
    fieldName: string;
    expectedResult: string;
  }>;
  currentStepIndex: number;
}

export function parsePlanningResponse(response: string): ParsedPlanningResponse {
  // Try to extract JSON from the response
  let jsonStr = response.trim();
  
  // Remove markdown code blocks if present
  if (jsonStr.startsWith("```")) {
    const lines = jsonStr.split("\n");
    lines.shift();
    if (lines[lines.length - 1] === "```") {
      lines.pop();
    }
    jsonStr = lines.join("\n");
  }
  
  // Try to find JSON object in the response
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }
  
  try {
    const parsed = JSON.parse(jsonStr);
    
    // Validate required fields
    if (!Array.isArray(parsed.plan)) {
      throw new Error("Planning response missing 'plan' array");
    }
    
    // Normalize each action in the plan
    const normalizedPlan = parsed.plan.map((step: { action?: unknown; fieldName?: string; expectedResult?: string }, index: number) => {
      if (!step.action) {
        throw new Error(`Plan step ${index} missing 'action'`);
      }
      
      return {
        action: normalizeShorthandAction(step.action),
        fieldName: step.fieldName || `Step ${index + 1}`,
        expectedResult: step.expectedResult || "Action completed",
      };
    });
    
    return {
      thinking: String(parsed.thinking || ""),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      plan: normalizedPlan,
      currentStepIndex: typeof parsed.currentStepIndex === "number" ? parsed.currentStepIndex : 0,
    };
  } catch (e) {
    console.error("[LLM] Failed to parse planning response:", response);
    throw new Error(`Failed to parse planning response as JSON: ${e}`);
  }
}
