import { NextRequest, NextResponse } from "next/server";
import { corsHeaders } from "@/lib/cors";
import type { PlannerRequest, PlannerResponse, AgentAction, ApplicationState, ActionPlan, PlannedAction, Target } from "@/lib/types";
import type { PageObservation, LoopContext } from "@/lib/llm/types";
import { callLLM, callLLMWithVision, getConfiguredProvider, isVisionSupported } from "@/lib/llm/router";
import { 
  SYSTEM_PROMPT, 
  VISION_SYSTEM_PROMPT, 
  INITIAL_VISION_SYSTEM_PROMPT, 
  PLANNING_SYSTEM_PROMPT,
  buildUserPrompt, 
  buildVisionPrompt, 
  buildInitialVisionPrompt, 
  buildPlanningPrompt,
  parseActionResponse, 
  parsePlanningResponse,
  ActionHistory 
} from "@/lib/llm/prompts";
import { emptyProfile } from "@/lib/profile";
import { formatHistoryAsText, analyzePatterns } from "@/lib/agent/history";
import type { ConversationEntry } from "@/lib/agent/types";

// Extended planner request with vision, state, and planning support
interface VisionPlannerRequest extends PlannerRequest {
  screenshot?: string; // base64 encoded screenshot
  loopContext?: LoopContext;
  applicationState?: ApplicationState; // Goal-focused agent state
  initialVision?: boolean; // first-step bootstrap vision analysis
  requestPlan?: boolean; // Request multi-step plan instead of single action
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as VisionPlannerRequest;
  
  // Check if LLM is configured
  const provider = getConfiguredProvider();
  const hasApiKey = 
    provider === "ollama" || 
    process.env.OPENAI_API_KEY || 
    process.env.ANTHROPIC_API_KEY || 
    process.env.OPENROUTER_API_KEY;
  
  // Fall back to stub if no LLM configured
  // Note: if !hasApiKey, provider can't be "ollama" (it's already checked in hasApiKey)
  if (!hasApiKey) {
    console.log("[Planner] No LLM configured, using stub rules");
    return handleStubPlanner(body);
  }
  
  try {
    // Build observation for LLM (with special elements)
    const observation: PageObservation = {
      url: body.observation.url,
      title: body.observation.title,
      fields: body.observation.fields || [],
      buttons: body.observation.buttons || [],
      pageContext: body.observation.pageContext || body.observation.text || "",
      specialElements: body.observation.specialElements,
      candidates: body.observation.candidates || [],
      registryVersion: body.observation.registryVersion,
    };
    
    // Use provided profile or empty
    const profile = body.profile || emptyProfile;
    
    // Convert action history to the format expected by buildUserPrompt
    const actionHistory: ActionHistory[] | undefined = body.actionHistory?.map(h => ({
      step: h.step,
      action: h.action,
      result: h.result,
    }));
    
    // Check if this is a vision request
    const hasScreenshot = !!body.screenshot;
    const hasLoopContext = !!body.loopContext?.isLoop;
    const useVision = hasScreenshot && isVisionSupported(provider);
    const isInitialVision = body.initialVision === true;
    const requestPlan = body.requestPlan === true;
    
    // Get application state for goal context
    const applicationState = body.applicationState;
    
    console.log(`[Planner] 📋 Request details:`, {
      step: body.step,
      goal: applicationState ? `${applicationState.goal.jobTitle} at ${applicationState.goal.company}` : "none",
      progress: applicationState?.progress?.estimatedProgress || 0,
      phase: applicationState?.progress?.phase || "unknown",
      hasScreenshot: hasScreenshot,
      screenshotSize: hasScreenshot ? `${Math.round((body.screenshot!.length * 3) / 4 / 1024)} KB` : "none",
      hasLoopContext: hasLoopContext,
      loopFailCount: body.loopContext?.failCount,
      provider: provider,
      visionSupported: isVisionSupported(provider),
      useVision: useVision,
      initialVision: isInitialVision,
      requestPlan: requestPlan
    });
    
    // ============================================================
    // MULTI-STEP PLANNING MODE
    // ============================================================
    if (requestPlan) {
      const hasScreenshotForPlan = !!body.screenshot;
      const useVisionForPlan = hasScreenshotForPlan && isVisionSupported(provider);
      
      console.log(`[Planner] 📋 PLANNING MODE: Creating multi-step plan for form filling...`);
      console.log(`[Planner] 📋 Vision-enhanced: ${useVisionForPlan ? "YES" : "NO (text-only)"}`);
      
      // Build planning prompt with conversation history
      let planningPrompt = buildPlanningPrompt(observation, profile, body.step, applicationState);
      
      // Add conversation history context for learning from past actions
      if (body.actionHistory && body.actionHistory.length > 0) {
        const entries = body.actionHistory.map(h => ({
          step: h.step,
          timestamp: h.timestamp || new Date().toISOString(),
          thinking: h.thinking || "",
          action: {
            type: h.action?.type || "unknown",
            target: h.action?.target || "",
            value: h.action?.value,
          },
          result: h.result || { ok: true },
          context: h.context || { url: "", fieldsCount: 0, buttonsCount: 0 },
        })) as ConversationEntry[];
        
        const historyText = formatHistoryAsText(entries, 5);
        if (historyText) {
          planningPrompt = `${historyText}\n\n---\n\n${planningPrompt}`;
          console.log(`[Planner] 📜 Added ${entries.length} history entries to planning context`);
        }
      }
      
      console.log(`[Planner] 📝 Planning prompt length: ${planningPrompt.length} chars`);
      
      const planStartTime = Date.now();
      let planResponse;
      
      if (useVisionForPlan) {
        // Vision-enhanced planning with screenshot
        const screenshotSizeKB = Math.round((body.screenshot!.length * 3) / 4 / 1024);
        console.log(`[Planner] 📸 Using vision with screenshot (${screenshotSizeKB} KB)`);
        
        planResponse = await callLLMWithVision({
          messages: [
            { role: "system", content: PLANNING_SYSTEM_PROMPT },
            { role: "user", content: planningPrompt },
          ],
          images: [{ base64: body.screenshot!, type: "image/png" }],
          temperature: 0.1,
          maxTokens: 2048,
        });
      } else {
        // Text-only planning fallback
        planResponse = await callLLM({
          messages: [
            { role: "system", content: PLANNING_SYSTEM_PROMPT },
            { role: "user", content: planningPrompt },
          ],
          temperature: 0.1,
          maxTokens: 2048,
        });
      }
      
      const planDuration = Date.now() - planStartTime;
      console.log(`[Planner] ✅ Planning response received in ${planDuration}ms`);
      console.log(`[Planner] 📄 Planning response preview:`, planResponse.content.slice(0, 400));
      
      try {
        const parsed = parsePlanningResponse(planResponse.content);
        
        // Build ActionPlan object
        const plan: ActionPlan = {
          thinking: parsed.thinking,
          confidence: parsed.confidence,
          plan: parsed.plan.map((step) => ({
            action: step.action as AgentAction,
            fieldName: step.fieldName,
            expectedResult: step.expectedResult,
            completed: false,
          })),
          currentStepIndex: 0,
          startUrl: observation.url,
          createdAt: new Date().toISOString(),
        };
        
        console.log(`[Planner] 📋 Plan created with ${plan.plan.length} steps:`);
        plan.plan.forEach((step, i) => {
          const action = step.action as AgentAction;
          console.log(`  ${i + 1}. ${action.type} → "${step.fieldName}"`);
        });
        
        // Return the first action along with the full plan
        const firstAction = plan.plan[0]?.action as AgentAction;
        
        if (!firstAction) {
          // Empty plan - might mean form is already complete
          return NextResponse.json(
            {
              action: { type: "CLICK", target: { by: "text", text: "Submit" } } as AgentAction,
              thinking: "Form appears complete. Looking for submit button.",
              confidence: 0.6,
              plan: plan,
            } as PlannerResponse,
            { headers: corsHeaders }
          );
        }
        
        return NextResponse.json(
          {
            action: firstAction,
            thinking: parsed.thinking,
            confidence: parsed.confidence,
            plan: plan,
            forceLive: false,
          } as PlannerResponse,
          { headers: corsHeaders }
        );
      } catch (planError) {
        console.error(`[Planner] ❌ Failed to parse planning response:`, planError);
        // Fall through to normal single-action mode
        console.log(`[Planner] ⚠️ Falling back to single-action mode...`);
      }
    }
    
    let response;
    
    if (useVision) {
      // VISION MODE: Use screenshot for visual analysis
      const visionStartTime = Date.now();
      console.log(`[Planner] 🔍 Step ${body.step}, using VISION mode (${isInitialVision ? "initial bootstrap" : "loop recovery"})...`);

      let systemPrompt = VISION_SYSTEM_PROMPT;
      let visionPrompt = "";

      if (isInitialVision) {
        systemPrompt = INITIAL_VISION_SYSTEM_PROMPT;
        visionPrompt = buildInitialVisionPrompt(observation, profile, body.step, applicationState);
      } else {
      console.log(`[Planner] 🔄 Loop context:`, {
        failedActionType: body.loopContext?.failedAction?.type,
        targetDescription: body.loopContext?.failedAction?.target?.text || body.loopContext?.failedAction?.target?.selector,
        failCount: body.loopContext?.failCount,
        error: body.loopContext?.error
      });
        visionPrompt = buildVisionPrompt(observation, profile, body.step, body.loopContext);
      }
      
      console.log(`[Planner] 📝 Vision prompt length: ${visionPrompt.length} chars`);
      console.log(`[Planner] 🤖 Calling vision-enabled LLM (${provider})...`);
      
      response = await callLLMWithVision({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: visionPrompt },
        ],
        images: [{ base64: body.screenshot!, type: "image/png" }],
        temperature: 0.1,
        maxTokens: 1024,
      });
      
      const visionDuration = Date.now() - visionStartTime;
      console.log(`[Planner] ✅ Vision LLM response received in ${visionDuration}ms`);
      console.log(`[Planner] 📄 Vision response length: ${response.content.length} chars`);
      console.log(`[Planner] 📄 Vision response preview:`, response.content.slice(0, 300));
    } else {
      // NORMAL MODE: Text-based analysis
      if (hasScreenshot && !isVisionSupported(provider)) {
        console.log(`[Planner] ⚠️ Screenshot provided but vision not supported for provider: ${provider}`);
        console.log(`[Planner] ⚠️ Falling back to text-only analysis`);
      } else if (hasScreenshot && !useVision) {
        console.log(`[Planner] ⚠️ Screenshot provided but useVision=false (checking logic)`);
      } else {
        console.log(`[Planner] 📝 Step ${body.step}, using NORMAL mode (text-only analysis)`);
      }
      
      // Build prompt with action history AND application state
      const userPrompt = buildUserPrompt(observation, profile, body.step, actionHistory, applicationState);
      
      // Build conversation history context if we have rich history
      let conversationContext = "";
      if (body.actionHistory && body.actionHistory.length > 0) {
        // Convert to ConversationEntry format if needed
        const entries = body.actionHistory.map(h => ({
          step: h.step,
          timestamp: h.timestamp || new Date().toISOString(),
          thinking: h.thinking || "",
          action: {
            type: h.action?.type || "unknown",
            target: h.action?.target || "",
            value: h.action?.value,
          },
          result: h.result || { ok: true },
          context: h.context || { url: "", fieldsCount: 0, buttonsCount: 0 },
        })) as ConversationEntry[];
        
        conversationContext = formatHistoryAsText(entries, 7);
        
        // Check for patterns that need attention
        const patterns = analyzePatterns(entries);
        if (patterns.repeatedFailures && patterns.repeatedFailures.length > 0) {
          console.log(`[Planner] ⚠️ Detected repeated failures:`, patterns.repeatedFailures);
        }
      }
      
      // Combine user prompt with conversation history
      const fullPrompt = conversationContext 
        ? `${conversationContext}\n\n---\n\n${userPrompt}`
        : userPrompt;
      
      console.log(`[Planner] 📝 User prompt length: ${fullPrompt.length} chars (history: ${conversationContext.length})`);
      
      const llmStartTime = Date.now();
      console.log(`[Planner] 🤖 Calling LLM (${provider})...`);
      
      // Call LLM with slightly higher token limit for thinking
      response = await callLLM({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: fullPrompt },
        ],
        temperature: 0.1,
        maxTokens: 768,
      });
      
      const llmDuration = Date.now() - llmStartTime;
      console.log(`[Planner] ✅ LLM response received in ${llmDuration}ms`);
      console.log(`[Planner] 📄 LLM response length: ${response.content.length} chars`);
      console.log(`[Planner] 📄 LLM response preview:`, response.content.slice(0, 200));
    }
    
    // Parse enhanced response (with thinking and confidence)
    console.log(`[Planner] 🔍 Parsing LLM response...`);
    const parsed = parseActionResponse(response.content);
    const action = parsed.action as AgentAction;
    const thinking = parsed.thinking;
    const confidence = parsed.confidence;
    
    // Extract target info for logging (not all action types have target)
    const actionWithTarget = action as { target?: Target };
    const targetInfo = actionWithTarget.target 
      ? ((actionWithTarget.target as { text?: string }).text || 
         (actionWithTarget.target as { selector?: string }).selector || 
         (actionWithTarget.target as { id?: string }).id ||
         (actionWithTarget.target as { intent?: string }).intent ||
         `index ${(actionWithTarget.target as { index?: number }).index}`)
      : "none";
    
    console.log(`[Planner] ✅ Parsed action:`, {
      type: action.type,
      target: targetInfo,
      value: action.type === "FILL" ? ((action as { value?: string }).value?.slice(0, 30) + "...") : undefined,
      thinking: thinking?.slice(0, 100) + "...",
      confidence: confidence
    });
    
    if (useVision) {
      console.log(`[Planner] 🎯 Vision analysis result: ${action.type} with confidence ${confidence}`);
    }
    
    // Determine if we need to force live mode
    const forceLive = 
      action.type === "REQUEST_VERIFICATION" ||
      action.type === "ASK_USER" ||
      (action.type === "CLICK" && isSubmitLike(action, observation));
    
    // Add approval requirement for submit-like actions
    if (action.type === "CLICK" && isSubmitLike(action, observation)) {
      action.requiresApproval = true;
    }
    
    // Auto-trigger ASK_USER for very low confidence (if not already asking)
    if (confidence < 0.3 && action.type !== "ASK_USER" && action.type !== "DONE") {
      console.log(`[Planner] Low confidence (${confidence}), suggesting user confirmation`);
      // We could convert to ASK_USER here, but for now just log it
      // The frontend can use the confidence score to prompt the user
    }
    
    return NextResponse.json(
      { 
        action, 
        thinking,
        confidence,
        forceLive 
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("[Planner] LLM error:", error);
    
    // Fall back to stub on error
    console.log("[Planner] Falling back to stub rules");
    return handleStubPlanner(body);
  }
}

function isSubmitLike(action: AgentAction, observation?: PageObservation): boolean {
  if (action.type !== "CLICK") return false;
  const target = action.target;
  if ("text" in target && target.text) {
    const text = target.text.toLowerCase();
    return ["submit", "apply", "confirm", "pay", "finish", "send", "complete", "place order"].some(k => text.includes(k));
  }
  if (target.by === "intent" && typeof target.intent === "string") {
    const intent = target.intent.toLowerCase();
    return ["submit", "apply", "confirm", "pay", "finish", "send", "complete", "place order"].some(k => intent.includes(k));
  }
  if (target.by === "vaultyId" && observation?.candidates?.length) {
    const candidate = observation.candidates.find(c => c.vaultyId === target.id);
    const text = (candidate?.text || candidate?.label || candidate?.ariaLabel || "").toLowerCase();
    return ["submit", "apply", "confirm", "pay", "finish", "send", "complete", "place order"].some(k => text.includes(k));
  }
  return false;
}

// Stub planner for when LLM is not configured
function handleStubPlanner(body: PlannerRequest): NextResponse {
  const text = (body.observation.text || body.observation.pageContext || "").toLowerCase();
  const specialElements = body.observation.specialElements;
  
  // Check for captcha first
  if (specialElements?.hasCaptcha) {
    return NextResponse.json(
      {
        action: { 
          type: "REQUEST_VERIFICATION", 
          kind: "CAPTCHA", 
          context: { hint: `${specialElements.captchaType || "Unknown"} captcha detected` } 
        },
        thinking: "I detected a captcha on the page that needs human verification.",
        confidence: 0.95,
        forceLive: true,
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }
  
  // Example "verification pause" trigger
  if (text.includes("verification code") || text.includes("enter code") || text.includes("otp")) {
    return NextResponse.json(
      {
        action: { type: "REQUEST_VERIFICATION", kind: "OTP", context: { hint: "Site asked for OTP/code" } },
        thinking: "The page is asking for a verification code. I need the user to enter it.",
        confidence: 0.9,
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
        thinking: "I see a first name field that needs to be filled.",
        confidence: 0.8,
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }
  if (text.includes("last name")) {
    return NextResponse.json(
      {
        action: { type: "FILL", target: { by: "label", text: "Last name" }, value: "Berthe" },
        thinking: "I see a last name field that needs to be filled.",
        confidence: 0.8,
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }
  if (text.includes("email")) {
    return NextResponse.json(
      {
        action: { type: "FILL", target: { by: "label", text: "Email" }, value: "test@example.com" },
        thinking: "I see an email field that needs to be filled.",
        confidence: 0.8,
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }

  // Example "click next/continue"
  if (text.includes("next")) {
    return NextResponse.json(
      {
        action: { type: "CLICK", target: { by: "text", text: "Next" } },
        thinking: "I see a Next button to proceed to the next step.",
        confidence: 0.85,
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }
  if (text.includes("continue")) {
    return NextResponse.json(
      {
        action: { type: "CLICK", target: { by: "text", text: "Continue" } },
        thinking: "I see a Continue button to proceed.",
        confidence: 0.85,
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }

  // Approval gate example: if a Submit-like button exists, require approval
  if (text.includes("submit")) {
    return NextResponse.json(
      {
        action: { type: "CLICK", target: { by: "text", text: "Submit" }, requiresApproval: true },
        thinking: "The form appears complete. I'll click Submit but require user approval first.",
        confidence: 0.7,
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }

  // Stop after N steps for safety in MVP
  if (body.step >= 40) {
    return NextResponse.json(
      {
        action: { type: "DONE", summary: "Stopped after 40 steps (MVP safety cap)." },
        thinking: "Reached the maximum step limit. Stopping for safety.",
        confidence: 1.0,
      } as PlannerResponse,
      { headers: corsHeaders }
    );
  }

  // Otherwise ask for more page text (gives the planner more context)
  return NextResponse.json(
    {
      action: { type: "EXTRACT", mode: "visibleText" },
      thinking: "I need more context about the page to determine the next action.",
      confidence: 0.5,
    } as PlannerResponse,
    { headers: corsHeaders }
  );
}
