import { NextRequest, NextResponse } from "next/server";
import { cors } from "@/lib/cors";
import { verifyExtensionAuth, isAuthError } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { callLLM, callLLMWithVision, getConfiguredProvider, isVisionSupported } from "@/lib/llm/router";
import {
  COPILOT_SUMMARIZE_SYSTEM,
  buildCopilotSummarizePrompt,
  type CopilotPageContext,
} from "@/lib/llm/copilot-prompts";

interface CopilotInterpretRequest {
  task: "summarize";
  screenshot?: string;
  context: CopilotPageContext;
}

interface CopilotSummaryResponse {
  type: "summary";
  title: string;
  content: string;
  keyPoints?: string[];
}

function parseSummaryResponse(content: string): CopilotSummaryResponse {
  try {
    let jsonStr = content.trim();
    if (jsonStr.startsWith("```")) {
      const lines = jsonStr.split("\n");
      lines.shift();
      if (lines[lines.length - 1]?.trim() === "```") {
        lines.pop();
      }
      jsonStr = lines.join("\n");
    }
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    const parsed = JSON.parse(jsonStr);
    const title = typeof parsed.title === "string" ? parsed.title : "Summary";
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    const keyPoints = Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.filter((p: unknown) => typeof p === "string")
      : undefined;

    return {
      type: "summary",
      title,
      content: summary,
      keyPoints: keyPoints?.length ? keyPoints : undefined,
    };
  } catch {
    return {
      type: "summary",
      title: "Summary",
      content,
      keyPoints: undefined,
    };
  }
}

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: cors(request) });
}

export async function POST(request: NextRequest) {
  const auth = await verifyExtensionAuth(request);
  if (isAuthError(auth)) return auth;

  const limited = await enforceRateLimit(request, auth.token, auth.userId, "copilot");
  if (limited) return limited;

  try {
    const body = (await request.json()) as CopilotInterpretRequest;
    const { task, screenshot, context } = body;

    if (!context?.url) {
      return NextResponse.json(
        { error: "missing_context", message: "Could not determine which page to summarize. Try refreshing the page." },
        { status: 400, headers: cors(request) }
      );
    }

    if (task !== "summarize") {
      return NextResponse.json(
        { error: "unsupported_task", message: "This feature isn't available yet. Only page summarization is supported." },
        { status: 400, headers: cors(request) }
      );
    }

    const provider = getConfiguredProvider();
    const hasApiKey =
      provider === "ollama" ||
      !!process.env.OPENAI_API_KEY ||
      !!process.env.ANTHROPIC_API_KEY ||
      !!process.env.OPENROUTER_API_KEY;

    if (!hasApiKey) {
      return NextResponse.json(
        { error: "service_unavailable", message: "The AI service is temporarily unavailable. Please try again later." },
        { status: 503, headers: cors(request) }
      );
    }

    const hasScreenshot = !!screenshot;
    const useVision = hasScreenshot && isVisionSupported(provider);

    const userPrompt = buildCopilotSummarizePrompt(context);

    if (useVision) {
      const response = await callLLMWithVision({
        messages: [
          { role: "system", content: COPILOT_SUMMARIZE_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        images: [{ base64: screenshot!, type: "image/png" }],
        temperature: 0.2,
        maxTokens: 1024,
      });

      const result = parseSummaryResponse(response.content);
      return NextResponse.json(result, { headers: cors(request) });
    }

    const response = await callLLM(
      {
        messages: [
          { role: "system", content: COPILOT_SUMMARIZE_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        maxTokens: 1024,
        jsonMode: true,
      },
      provider
    );

    const result = parseSummaryResponse(response.content);
    return NextResponse.json(result, { headers: cors(request) });
  } catch (err) {
    console.error("[Copilot] Interpret error:", err);
    return NextResponse.json(
      { error: "ai_error", message: "The AI couldn't summarize this page right now. Please try again." },
      { status: 500, headers: cors(request) }
    );
  }
}
