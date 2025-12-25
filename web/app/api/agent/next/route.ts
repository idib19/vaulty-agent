import { NextRequest, NextResponse } from "next/server";
import { corsHeaders } from "@/lib/cors";
import type { PlannerRequest, PlannerResponse, AgentAction } from "@/lib/types";
import type { PageObservation } from "@/lib/llm/types";
import { callLLM, getConfiguredProvider } from "@/lib/llm/router";
import { SYSTEM_PROMPT, buildUserPrompt, parseActionResponse } from "@/lib/llm/prompts";
import { emptyProfile } from "@/lib/profile";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as PlannerRequest;
  
  // Check if LLM is configured
  const provider = getConfiguredProvider();
  const hasApiKey = 
    provider === "ollama" || 
    process.env.OPENAI_API_KEY || 
    process.env.ANTHROPIC_API_KEY || 
    process.env.OPENROUTER_API_KEY;
  
  // Fall back to stub if no LLM configured
  if (!hasApiKey && provider !== "ollama") {
    console.log("[Planner] No LLM configured, using stub rules");
    return handleStubPlanner(body);
  }
  
  try {
    // Build observation for LLM
    const observation: PageObservation = {
      url: body.observation.url,
      title: body.observation.title,
      fields: body.observation.fields || [],
      buttons: body.observation.buttons || [],
      pageContext: body.observation.pageContext || body.observation.text || "",
    };
    
    // Use provided profile or empty
    const profile = body.profile || emptyProfile;
    
    // Build prompt
    const userPrompt = buildUserPrompt(observation, profile, body.step);
    
    console.log(`[Planner] Step ${body.step}, calling ${provider}...`);
    
    // Call LLM
    const response = await callLLM({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      maxTokens: 512,
    });
    
    console.log(`[Planner] LLM response:`, response.content.slice(0, 200));
    
    // Parse action from response
    const action = parseActionResponse(response.content) as AgentAction;
    
    // Determine if we need to force live mode
    const forceLive = 
      action.type === "REQUEST_VERIFICATION" ||
      (action.type === "CLICK" && isSubmitLike(action));
    
    // Add approval requirement for submit-like actions
    if (action.type === "CLICK" && isSubmitLike(action)) {
      action.requiresApproval = true;
    }
    
    return NextResponse.json(
      { action, forceLive } as PlannerResponse,
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("[Planner] LLM error:", error);
    
    // Fall back to stub on error
    console.log("[Planner] Falling back to stub rules");
    return handleStubPlanner(body);
  }
}

function isSubmitLike(action: AgentAction): boolean {
  if (action.type !== "CLICK") return false;
  const target = action.target;
  if ("text" in target) {
    const text = target.text.toLowerCase();
    return ["submit", "apply", "confirm", "pay", "finish", "send", "complete", "place order"].some(k => text.includes(k));
  }
  return false;
}

// Stub planner for when LLM is not configured
function handleStubPlanner(body: PlannerRequest): NextResponse {
  const text = (body.observation.text || body.observation.pageContext || "").toLowerCase();
  
  // Example "verification pause" trigger
  if (text.includes("verification code") || text.includes("enter code") || text.includes("otp")) {
    return NextResponse.json(
      {
        action: { type: "REQUEST_VERIFICATION", kind: "OTP", context: { hint: "Site asked for OTP/code" } },
        forceLive: true,
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }

  // Example "fill first name/last name/email" logic
  if (text.includes("first name")) {
    return NextResponse.json(
      {
        action: { type: "FILL", target: { by: "label", text: "First name" }, value: "Idrissa" },
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }
  if (text.includes("last name")) {
    return NextResponse.json(
      {
        action: { type: "FILL", target: { by: "label", text: "Last name" }, value: "Berthe" },
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }
  if (text.includes("email")) {
    return NextResponse.json(
      {
        action: { type: "FILL", target: { by: "label", text: "Email" }, value: "test@example.com" },
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }

  // Example "click next/continue"
  if (text.includes("next")) {
    return NextResponse.json(
      {
        action: { type: "CLICK", target: { by: "text", text: "Next" } },
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }
  if (text.includes("continue")) {
    return NextResponse.json(
      {
        action: { type: "CLICK", target: { by: "text", text: "Continue" } },
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }

  // Approval gate example: if a Submit-like button exists, require approval
  if (text.includes("submit")) {
    return NextResponse.json(
      {
        action: { type: "CLICK", target: { by: "text", text: "Submit" }, requiresApproval: true },
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }

  // Stop after N steps for safety in MVP
  if (body.step >= 40) {
    return NextResponse.json(
      {
        action: { type: "DONE", summary: "Stopped after 40 steps (MVP safety cap)." },
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }

  // Otherwise ask for more page text (gives the planner more context)
  return NextResponse.json(
    {
      action: { type: "EXTRACT", mode: "visibleText" },
    } as PlannerResponse,
    { headers: corsHeaders }
  );
}
