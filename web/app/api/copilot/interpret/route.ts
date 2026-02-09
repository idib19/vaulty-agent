import { NextRequest, NextResponse } from "next/server";
import { corsHeaders } from "@/lib/cors";
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

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CopilotInterpretRequest;
    const { task, screenshot, context } = body;

    if (!context?.url) {
      return NextResponse.json(
        { error: "Missing required field: context.url" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (task !== "summarize") {
      return NextResponse.json(
        { error: "Unsupported task. MVP supports only: summarize" },
        { status: 400, headers: corsHeaders }
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
        { error: "No LLM configured. Set OPENAI_API_KEY or another provider." },
        { status: 503, headers: corsHeaders }
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
      return NextResponse.json(result, { headers: corsHeaders });
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
    return NextResponse.json(result, { headers: corsHeaders });
  } catch (err) {
    console.error("[Copilot] Interpret error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json(
      { error: message },
      { status: 500, headers: corsHeaders }
    );
  }
}
