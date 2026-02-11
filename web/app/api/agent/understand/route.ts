import { NextRequest, NextResponse } from "next/server";
import { corsHeaders } from "@/lib/cors";
import type { PlannerRequest, ApplicationState } from "@/lib/types";
import type { PageObservation } from "@/lib/llm/types";
import { callLLM, callLLMWithVision, getConfiguredProvider, isVisionSupported } from "@/lib/llm/router";
import { UNDERSTANDING_SYSTEM_PROMPT, buildUnderstandingPrompt, parseUnderstandingResponse } from "@/lib/llm/prompts";
import { emptyProfile } from "@/lib/profile";

interface UnderstandingRequest extends PlannerRequest {
  screenshot?: string;
  applicationState?: ApplicationState;
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

function stubUnderstanding(observation: PageObservation) {
  const text = `${observation.title}\n${observation.pageContext || ""}`.toLowerCase();
  let pageType = "unknown";
  if (text.includes("thank you") || text.includes("application submitted") || text.includes("confirmation")) {
    pageType = "confirmation";
  } else if (text.includes("sign in") || text.includes("log in")) {
    pageType = "login";
  } else if (text.includes("sign up") || text.includes("create account")) {
    pageType = "signup";
  } else if (observation.fields?.length > 0) {
    pageType = "application_form";
  } else if (text.includes("apply") || text.includes("job")) {
    pageType = "job_listing";
  }

  const blockers: string[] = [];
  if (observation.specialElements?.hasCaptcha) blockers.push("captcha");
  if (observation.specialElements?.hasOtpField) blockers.push("otp");
  if (observation.specialElements?.hasFileUpload) blockers.push("file_upload");
  if (observation.specialElements?.hasCookieBanner) blockers.push("cookie_banner");

  return {
    pageType,
    primaryGoal: pageType === "login" ? "login" : pageType === "application_form" ? "fill_form" : "unknown",
    blockers,
    summary: "Stub understanding (LLM not configured).",
    confidence: 0.2,
    requiredFields: [],
    primaryActions: [],
  };
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as UnderstandingRequest;
  const provider = getConfiguredProvider();
  const hasApiKey =
    provider === "ollama" ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENROUTER_API_KEY;

  const observation: PageObservation = {
    url: body.observation.url,
    title: body.observation.title,
    fields: body.observation.fields || [],
    buttons: body.observation.buttons || [],
    pageContext: body.observation.pageContext || body.observation.text || "",
    specialElements: body.observation.specialElements,
    candidates: body.observation.candidates || [],
    registryVersion: body.observation.registryVersion,
    understanding: body.observation.understanding,
    hasActiveModal: body.observation.hasActiveModal,
    modalTitle: body.observation.modalTitle,
  };

  if (!hasApiKey) {
    return NextResponse.json(
      { understanding: stubUnderstanding(observation) },
      { headers: corsHeaders }
    );
  }

  const profile = body.profile || emptyProfile;
  const applicationState = body.applicationState;
  const hasScreenshot = !!body.screenshot;
  const useVision = hasScreenshot && isVisionSupported(provider);

  const prompt = buildUnderstandingPrompt(observation, profile, body.step, applicationState);

  let response;
  if (useVision) {
    response = await callLLMWithVision({
      messages: [
        { role: "system", content: UNDERSTANDING_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      images: [{ base64: body.screenshot!, type: "image/png" }],
      temperature: 0.1,
      maxTokens: 1200,
    });
  } else {
    response = await callLLM({
      messages: [
        { role: "system", content: UNDERSTANDING_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      maxTokens: 1200,
    });
  }

  const understanding = parseUnderstandingResponse(response.content);
  return NextResponse.json({ understanding }, { headers: corsHeaders });
}
