import type { FormField, FormButton, PageObservation } from "./types";
import type { UserProfile } from "../profile";
import { profileToContext } from "../profile";

export const SYSTEM_PROMPT = `You are an autonomous Job Application Agent.\n\nMISSION\n- Apply to the job at the provided URL.\n- Your goal is to reach a successful submission on a job board or employer ATS.\n\nOPERATING RULES\n- Work step-by-step. Prefer ONE action per step.\n- Use ONLY the user's profile data provided. Do not invent information.\n- Prefer filling empty required fields first; skip fields that are already filled.\n- When identifiers exist, prefer targeting by id (by:\"id\"). Otherwise use index targeting (by:\"index\").\n- For multi-step flows, use Next/Continue buttons to proceed.\n\nJOB APPLICATION SPECIFICS\n- Login vs signup:\n  - If a login form is present and the profile has email+password, login.\n  - If the site requires account creation, sign up using profile email/password.\n  - If there is a \"confirm password\" field, fill it with the same password.\n  - If password is missing and a password field is required, request PASSWORD verification.\n- OAuth:\n  - If the user prefers OAuth and a \"Continue with Google\" style option exists, click it and then request OAUTH verification.\n- Common ATS fields:\n  - Name, email, phone, location/address.\n  - Work authorization / visa / sponsorship questions: do NOT guess; if required and missing, request verification.\n  - Experience, education, skills, links (LinkedIn/GitHub/portfolio): use profile/resume context.\n  - Resume/CV file uploads: do not attempt file uploads; if a text resume field exists, paste resume text.\n\nSUBMISSION & SUCCESS\n- When the application form is complete, click the most appropriate submit/apply button.\n- Use DONE only when there is evidence the application is submitted (confirmation message/page, \"thank you\", \"application submitted\", \"we received\", confirmation number, etc.).\n- If you hit blockers (captcha, OTP, email code, password prompt, OAuth popup), use REQUEST_VERIFICATION.\n\nRESPONSE FORMAT\n- Respond with ONLY a JSON object. No markdown, no explanation.\n\nACTIONS (choose exactly one)\n- FILL: {\"type\":\"FILL\",\"target\":{\"by\":\"id\",\"selector\":\"<id>\"},\"value\":\"<value>\"}\n  or {\"type\":\"FILL\",\"target\":{\"by\":\"index\",\"index\":<n>,\"elementType\":\"field\"},\"value\":\"<value>\"}\n- SELECT: {\"type\":\"SELECT\",\"target\":{\"by\":\"id\",\"selector\":\"<id>\"},\"value\":\"<option_value>\"}\n- CHECK: {\"type\":\"CHECK\",\"target\":{\"by\":\"id\",\"selector\":\"<id>\"},\"checked\":true}\n- CLICK: {\"type\":\"CLICK\",\"target\":{\"by\":\"text\",\"text\":\"<button_text>\"}}\n  or {\"type\":\"CLICK\",\"target\":{\"by\":\"index\",\"index\":<n>,\"elementType\":\"button\"}}\n- WAIT_FOR: {\"type\":\"WAIT_FOR\",\"target\":{\"by\":\"text\",\"text\":\"<text>\"},\"timeoutMs\":5000}\n- REQUEST_VERIFICATION: {\"type\":\"REQUEST_VERIFICATION\",\"kind\":\"OTP\"|\"EMAIL_CODE\"|\"CAPTCHA\"|\"PASSWORD\"|\"OAUTH\",\"context\":{\"hint\":\"<why>\"}}\n- DONE: {\"type\":\"DONE\",\"summary\":\"<evidence of successful submission>\"}`; 

export function buildUserPrompt(
  observation: PageObservation,
  profile: UserProfile,
  step: number
): string {
  const profileContext = profileToContext(profile);
  
  // Format fields for LLM
  const fieldsText = observation.fields
    .filter(f => !f.disabled && !f.readonly)
    .map(f => {
      let desc = `[${f.index}] ${f.tag}`;
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
      return desc;
    })
    .join("\n");
  
  // Format buttons for LLM
  const buttonsText = observation.buttons
    .filter(b => !b.disabled)
    .map(b => {
      let desc = `[${b.index}] ${b.tag}`;
      if (b.type) desc += ` type="${b.type}"`;
      if (b.id) desc += ` id="${b.id}"`;
      desc += ` text="${b.text}"`;
      return desc;
    })
    .join("\n");
  
  // Format profile for LLM
  // IMPORTANT: If password is present, we include the REAL password value so the model can fill password fields.
  // (We do NOT log the full prompt server-side.)
  const profileEntries = Object.entries(profileContext);
  const hasPassword = !!profileContext["password"];
  const profileText = profileEntries
    .map(([key, value]) => {
      // Truncate long values (resume text can be large)
      const displayValue = value.length > 800 ? value.slice(0, 800) + "..." : value;
      return `${key}: ${displayValue}`;
    })
    .join("\n");
  
  const passwordNote = hasPassword ? "" : "\npassword: (NOT SET - use REQUEST_VERIFICATION kind=PASSWORD)";
  
  // Check OAuth preference
  const oauthNote = profile.preferOAuth ? "\nOAuth preference: User prefers 'Login with Google' style buttons" : "";
  
  return `STEP: ${step}
PAGE: ${observation.url}
TITLE: ${observation.title}

USER PROFILE:
${profileText || "(No profile data provided)"}${passwordNote}${oauthNote}

FORM FIELDS:
${fieldsText || "(No editable fields found)"}

BUTTONS:
${buttonsText || "(No buttons found)"}

PAGE CONTEXT (truncated):
${observation.pageContext.slice(0, 2000)}

What is the next action to take? Respond with JSON only.`;
}

export function parseActionResponse(response: string): unknown {
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
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("[LLM] Failed to parse action response:", response);
    throw new Error(`Failed to parse LLM response as JSON: ${e}`);
  }
}
