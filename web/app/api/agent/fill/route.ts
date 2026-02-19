import { NextRequest, NextResponse } from "next/server";
import { cors } from "@/lib/cors";
import { callLLM } from "@/lib/llm/router";
import { verifyExtensionAuth, isAuthError } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";

interface FillRequest {
  html: string;
  profile: Record<string, unknown>;
}

interface FieldMapping {
  selector: string;
  value: string;
  type: "input" | "select" | "checkbox" | "radio" | "textarea";
}

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: cors(request) });
}

export async function POST(request: NextRequest) {
  const auth = await verifyExtensionAuth(request);
  if (isAuthError(auth)) return auth;

  const limited = await enforceRateLimit(request, auth.token, auth.userId, "fill");
  if (limited) return limited;

  let body: FillRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { mapping: [], error: "invalid_request", message: "The request was malformed. Please try again." },
      { status: 400, headers: cors(request) }
    );
  }

  const { html, profile } = body;

  if (!html || !profile) {
    return NextResponse.json(
      { mapping: [], error: "missing_data", message: "Could not read the page or your profile is empty. Make sure you've saved your profile." },
      { status: 400, headers: cors(request) }
    );
  }

  const flatProfile = flattenProfile(profile);
  const formHTML = extractFormHTML(html);
  const prompt = buildPrompt(formHTML, flatProfile);

  try {
    const response = await callLLM({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
    });

    const mapping = parseMapping(response.content);

    return NextResponse.json({ mapping }, { headers: cors(request) });
  } catch (err) {
    console.error("[fill] LLM call failed:", err);
    return NextResponse.json(
      { mapping: [], error: "ai_error", message: "The AI couldn't process this form right now. Please try again." },
      { status: 500, headers: cors(request) }
    );
  }
}

function buildPrompt(html: string, flatProfile: Record<string, string>): string {
  return `You are a form-filling assistant. Map form fields to user profile values.

USER PROFILE (key: value):
${JSON.stringify(flatProfile, null, 2)}

FORM HTML:
${html}

Return ONLY a valid JSON array — no explanation, no markdown, no code fences.
Each item must be exactly:
[
  { "selector": "#email", "value": "user@example.com", "type": "input" }
]

Rules:
- selector priority: id > name attribute > aria-label > placeholder (use CSS attribute selectors)
- type must be one of: input | select | checkbox | radio | textarea
- For select, value must exactly match a visible <option> text
- For checkbox/radio, value must be "true" or "false"
- Only include fields you can confidently map
- Skip hidden fields, CSRF tokens, honeypots, already-filled fields`;
}

function parseMapping(text: string): FieldMapping[] {
  try {
    const clean = text.replace(/```json|```/gi, "").trim();
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) throw new Error("Not an array");
    return parsed;
  } catch {
    console.warn("[fill] Failed to parse LLM response:", text);
    return [];
  }
}

function extractFormHTML(fullHTML: string): string {
  const formMatches = [...fullHTML.matchAll(/<form[\s\S]*?<\/form>/gi)];
  if (formMatches.length > 0) return formMatches.map((m) => m[0]).join("\n\n");

  const fieldMatches = [
    ...fullHTML.matchAll(
      /<(input|select|textarea|button|label)[^>]*>[\s\S]*?<\/\1>|<(input|select|textarea|button)[^>]*\/?>/gi
    ),
  ];
  return fieldMatches.map((m) => m[0]).join("\n");
}

function flattenProfile(profile: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (key === "updatedAt") continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue) flat[`${key}.${subKey}`] = String(subValue);
      }
    } else if (value) {
      flat[key] = String(value);
    }
  }
  const firstName = profile.firstName;
  const lastName = profile.lastName;
  if (firstName && lastName) {
    flat.fullName = `${firstName} ${lastName}`;
  }
  return flat;
}
