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
          plan: parsed.plan.map((step) => {
            const resolved = resolveActionTargetWithCandidates(step.action as AgentAction, observation);
            return {
              action: resolved.action as AgentAction,
              fieldName: step.fieldName,
              expectedResult: step.expectedResult,
              completed: false,
            };
          }),
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
    let action = parsed.action as AgentAction;
    const thinking = parsed.thinking;
    const confidence = parsed.confidence;

    const resolvedAction = resolveActionTargetWithCandidates(action, observation);
    action = resolvedAction.action;
    if (resolvedAction.matchedCandidate) {
      console.log(`[Planner] 🔧 Resolved target to vaultyId "${resolvedAction.matchedCandidate.vaultyId}" (score ${resolvedAction.score?.toFixed(2)})`);
    }
    
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

type TargetHints = {
  text?: string | { exact?: string; contains?: string[] };
  label?: string;
  role?: string;
  attributes?: { id?: string; name?: string; dataTestId?: string };
  context?: { form?: string; section?: string; modalTitle?: string };
  intent?: string;
};

function normalizeText(value: string | undefined | null): string {
  return (value || "").toLowerCase().trim();
}

function extractAttributesFromSelector(selector: string): { id?: string; name?: string; dataTestId?: string } {
  const attrs: { id?: string; name?: string; dataTestId?: string } = {};
  if (selector.startsWith("#")) {
    attrs.id = selector.slice(1);
    return attrs;
  }
  const idMatch = selector.match(/#([A-Za-z0-9\-_:.]+)/);
  if (idMatch) attrs.id = idMatch[1];

  const nameMatch = selector.match(/\[name=["']?([^"'\]]+)["']?\]/i);
  if (nameMatch) attrs.name = nameMatch[1];

  const testIdMatch = selector.match(/\[data-testid=["']?([^"'\]]+)["']?\]/i) ||
    selector.match(/\[data-test-id=["']?([^"'\]]+)["']?\]/i);
  if (testIdMatch) attrs.dataTestId = testIdMatch[1];
  return attrs;
}

function buildTargetHints(action: AgentAction, observation: PageObservation): TargetHints {
  const target = (action as { target?: Target }).target;
  const hints: TargetHints = {};
  if (!target) return hints;

  if (action.type === "CLICK") hints.role = "button";
  if (action.type === "FILL") hints.role = "textbox";
  if (action.type === "SELECT" || action.type === "SELECT_CUSTOM") hints.role = "combobox";
  if (action.type === "CHECK") hints.role = "checkbox";

  if (target.by === "text") {
    hints.text = target.text;
  } else if (target.by === "label") {
    hints.label = target.text;
    hints.text = target.text;
  } else if (target.by === "id") {
    hints.attributes = { id: target.selector };
  } else if (target.by === "role") {
    hints.role = target.role;
    if (target.name) hints.text = target.name;
  } else if (target.by === "index") {
    if (target.elementType === "field") {
      const field = observation.fields?.find(f => f.index === target.index);
      if (field) {
        hints.label = field.label || field.name || field.id || "";
        hints.text = hints.label;
        hints.attributes = {
          id: field.id || undefined,
          name: field.name || undefined,
        };
        if (field.tag === "select" || field.type === "select") hints.role = "combobox";
        if (field.type === "checkbox" || field.type === "radio") hints.role = "checkbox";
      }
    } else if (target.elementType === "button") {
      const button = observation.buttons?.find(b => b.index === target.index);
      if (button) {
        hints.text = button.text;
        hints.role = "button";
        hints.attributes = { id: button.id || undefined };
        hints.context = button.context ? { form: undefined, section: undefined, modalTitle: button.context === "MODAL" ? observation.modalTitle || undefined : undefined } : undefined;
      }
    }
  } else if (target.by === "css") {
    hints.attributes = extractAttributesFromSelector(target.selector);
  } else if (target.by === "intent") {
    hints.intent = target.intent;
    hints.role = target.role || hints.role;
    hints.text = target.text || hints.text;
    hints.label = target.label || hints.label;
    hints.attributes = target.attributes || hints.attributes;
    hints.context = target.context || hints.context;
  }

  if (!hints.context && observation.hasActiveModal) {
    hints.context = { modalTitle: observation.modalTitle || undefined };
  }

  return hints;
}

function candidateAppliesToAction(action: AgentAction, candidate: { type?: string; role?: string; attributes?: { type?: string | null } }): boolean {
  const candidateType = normalizeText(candidate.type);
  const role = normalizeText(candidate.role);
  const inputType = normalizeText(candidate.attributes?.type);

  switch (action.type) {
    case "CLICK":
      return candidateType === "button" || candidateType === "link" || role === "button";
    case "FILL":
      return candidateType === "input" || candidateType === "textarea" || role === "textbox";
    case "SELECT":
      return candidateType === "select" || role === "combobox";
    case "SELECT_CUSTOM":
      return candidateType === "custom-dropdown" || role === "combobox";
    case "CHECK":
      return inputType === "checkbox" || inputType === "radio" || role === "checkbox";
    case "UPLOAD_FILE":
      return inputType === "file";
    default:
      return true;
  }
}

function computeTextMatchScore(targetText: TargetHints["text"], candidate: { text?: string; label?: string; ariaLabel?: string }) {
  const pool = [candidate.text, candidate.label, candidate.ariaLabel].filter(Boolean).map(normalizeText);
  if (pool.length === 0 || !targetText) return { score: 0, reason: "" };

  const exactTargets: string[] = [];
  const containsTargets: string[] = [];
  if (typeof targetText === "string") {
    exactTargets.push(targetText);
  } else {
    if (targetText.exact) exactTargets.push(targetText.exact);
    if (targetText.contains) containsTargets.push(...targetText.contains);
  }

  for (const exact of exactTargets) {
    const wanted = normalizeText(exact);
    if (pool.some(t => t === wanted)) return { score: 1, reason: "text:exact" };
  }
  for (const part of containsTargets) {
    const wanted = normalizeText(part);
    if (pool.some(t => t.includes(wanted))) return { score: 0.7, reason: "text:contains" };
  }
  return { score: 0, reason: "" };
}

function computeLabelMatchScore(label: string | undefined, candidate: { label?: string }) {
  if (!label || !candidate.label) return { score: 0, reason: "" };
  const wanted = normalizeText(label);
  const candidateLabel = normalizeText(candidate.label);
  if (candidateLabel === wanted) return { score: 1, reason: "label:exact" };
  if (candidateLabel.includes(wanted) || wanted.includes(candidateLabel)) return { score: 0.7, reason: "label:contains" };
  return { score: 0, reason: "" };
}

function computeRoleMatchScore(role: string | undefined, candidate: { role?: string }) {
  if (!role || !candidate.role) return { score: 0, reason: "" };
  if (normalizeText(role) === normalizeText(candidate.role)) return { score: 1, reason: "role" };
  return { score: 0, reason: "" };
}

function computeAttributeMatchScore(attrs: TargetHints["attributes"], candidate: { attributes?: { id?: string | null; name?: string | null; dataTestId?: string | null } }) {
  if (!attrs || !candidate.attributes) return { score: 0, reason: "" };
  if (attrs.id && candidate.attributes.id === attrs.id) return { score: 1, reason: "attr:id" };
  if (attrs.dataTestId && candidate.attributes.dataTestId === attrs.dataTestId) return { score: 1, reason: "attr:data-testid" };
  if (attrs.name && candidate.attributes.name === attrs.name) return { score: 0.7, reason: "attr:name" };
  return { score: 0, reason: "" };
}

function computeContextMatchScore(context: TargetHints["context"], candidate: { formId?: string | null; sectionHeading?: string | null; context?: string }, observation: PageObservation) {
  let score = 0;
  let reason = "";

  if (context?.form && candidate.formId) {
    const wanted = normalizeText(context.form);
    const formId = normalizeText(candidate.formId);
    if (formId && (formId === wanted || formId.includes(wanted))) {
      score = 1;
      reason = "context:form";
    }
  }

  if (context?.section && candidate.sectionHeading) {
    const wanted = normalizeText(context.section);
    const section = normalizeText(candidate.sectionHeading);
    if (section && (section === wanted || section.includes(wanted))) {
      score = Math.max(score, 0.7);
      reason = reason || "context:section";
    }
  }

  if (context?.modalTitle && candidate.context === "MODAL") {
    score = Math.max(score, 0.6);
    reason = reason || "context:modal";
  }

  if (observation.hasActiveModal && candidate.context === "MODAL") {
    score = Math.max(score, 0.6);
    reason = reason || "context:modal";
  }

  return { score, reason };
}

function computeCandidateScore(hints: TargetHints, candidate: { text?: string; label?: string; ariaLabel?: string; role?: string; attributes?: { id?: string | null; name?: string | null; dataTestId?: string | null }; formId?: string | null; sectionHeading?: string | null; context?: string; isVisible?: boolean; isEnabled?: boolean }, observation: PageObservation) {
  const reasons: string[] = [];

  const attrScore = computeAttributeMatchScore(hints.attributes, candidate);
  if (attrScore.score === 1) {
    return { score: 1, reasons: [attrScore.reason] };
  }

  const textScore = computeTextMatchScore(hints.text, candidate);
  if (textScore.score) reasons.push(textScore.reason);

  let intentScore = 0;
  if (!textScore.score && hints.intent) {
    const tokens = normalizeText(hints.intent).split(/[_\s-]+/).filter(Boolean);
    const pool = [candidate.text, candidate.label, candidate.ariaLabel].filter(Boolean).map(normalizeText);
    if (tokens.length && pool.some(t => tokens.some(tok => t.includes(tok)))) {
      intentScore = 0.6;
      reasons.push("intent");
    }
  }

  const roleScore = computeRoleMatchScore(hints.role, candidate);
  if (roleScore.score) reasons.push(roleScore.reason);

  const labelScore = computeLabelMatchScore(hints.label, candidate);
  if (labelScore.score) reasons.push(labelScore.reason);

  if (attrScore.score) reasons.push(attrScore.reason);

  const contextScore = computeContextMatchScore(hints.context, candidate, observation);
  if (contextScore.score) reasons.push(contextScore.reason);

  const visibilityScore = candidate.isVisible && candidate.isEnabled ? 1 : 0;
  if (visibilityScore) reasons.push("visible");

  const score =
    0.40 * Math.max(textScore.score, intentScore) +
    0.20 * roleScore.score +
    0.15 * labelScore.score +
    0.10 * attrScore.score +
    0.10 * contextScore.score +
    0.05 * visibilityScore;

  return { score, reasons };
}

function resolveActionTargetWithCandidates(action: AgentAction, observation: PageObservation): { action: AgentAction; matchedCandidate?: { vaultyId: string }; score?: number } {
  const target = (action as { target?: Target }).target;
  if (!target || target.by === "vaultyId") return { action };
  if (!observation.candidates || observation.candidates.length === 0) return { action };

  const hints = buildTargetHints(action, observation);
  const candidates = observation.candidates.filter(c => candidateAppliesToAction(action, c));
  if (candidates.length === 0) return { action };

  let best: { candidate: { vaultyId: string }; score: number } | null = null;
  for (const candidate of candidates) {
    const result = computeCandidateScore(hints, candidate, observation);
    if (!best || result.score > best.score) {
      best = { candidate, score: result.score };
    }
  }

  if (!best || best.score < 0.45) return { action };

  const resolvedTarget: Target = {
    by: "vaultyId",
    id: best.candidate.vaultyId,
    text: (target as { text?: string }).text,
    intent: (target as { intent?: string }).intent,
  };

  const resolvedAction = { ...action, target: resolvedTarget } as AgentAction;
  return { action: resolvedAction, matchedCandidate: best.candidate, score: best.score };
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
