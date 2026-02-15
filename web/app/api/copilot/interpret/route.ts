import { NextRequest, NextResponse } from "next/server";
import { corsHeaders } from "@/lib/cors";
import { callLLM, callLLMWithVision, getConfiguredProvider, isVisionSupported } from "@/lib/llm/router";
import {
  COPILOT_SUMMARIZE_SYSTEM,
  COPILOT_EXPLAIN_INCORRECT_SYSTEM,
  buildCopilotSummarizePrompt,
  buildCopilotExplainIncorrectPrompt,
  type CopilotPageContext,
} from "@/lib/llm/copilot-prompts";

interface CopilotSummarizeRequest {
  task: "summarize";
  screenshot?: string;
  context: CopilotPageContext;
}

interface CopilotExplainIncorrectRequest {
  task: "explain_incorrect";
  question: string;
  userAnswer: string;
  correctAnswer: string;
  rationale?: string;
  context?: { summary?: string; title?: string };
}

type CopilotInterpretRequest = CopilotSummarizeRequest | CopilotExplainIncorrectRequest;

export interface CopilotSuggestion {
  question: string;
  suggestedAnswer: string;
  rationale?: string;
  /** Multiple choices for quiz mode; when present with valid correctIndex, UI shows interactive quiz */
  options?: string[];
  /** 0-based index of the correct option in `options` */
  correctIndex?: number;
}

interface CopilotEmailDraft {
  subject: string;
  body: string;
  recipientHint?: string;
  contextNote?: string;
}

interface CopilotSummaryResponse {
  type: "summary";
  title: string;
  content: string;
  keyPoints?: string[];
  suggestions?: CopilotSuggestion[];
  emailDraft?: CopilotEmailDraft;
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

    const rawSuggestions = parsed.suggestions ?? parsed.answers;
    let suggestions: CopilotSuggestion[] | undefined;
    if (Array.isArray(rawSuggestions) && rawSuggestions.length > 0) {
      const MAX_SUGGESTIONS = 20;
      const MAX_OPTIONS = 10;
      suggestions = rawSuggestions
        .slice(0, MAX_SUGGESTIONS)
        .filter((s: unknown) => {
          if (s === null || typeof s !== "object") return false;
          const o = s as Record<string, unknown>;
          if (typeof o.question !== "string") return false;
          const hasAnswer = typeof o.suggestedAnswer === "string";
          const opts = Array.isArray(o.options) ? o.options : undefined;
          const hasOptions = opts && opts.length >= 2;
          return hasAnswer || hasOptions;
        })
        .map((s: Record<string, unknown>) => {
          const question = String(s.question);
          let suggestedAnswer = typeof s.suggestedAnswer === "string" ? s.suggestedAnswer : "";
          let options: string[] | undefined;
          let correctIndex: number | undefined;
          const rawOptions = Array.isArray(s.options)
            ? (s.options as unknown[]).slice(0, MAX_OPTIONS).filter((x): x is string => typeof x === "string").map((x) => String(x).trim())
            : [];
          if (rawOptions.length >= 2) {
            options = rawOptions;
            let idx = typeof s.correctIndex === "number" ? Math.floor(s.correctIndex) : NaN;
            if (!Number.isFinite(idx) || idx < 0 || idx >= options.length) idx = 0;
            correctIndex = idx;
            if (!suggestedAnswer) suggestedAnswer = options[correctIndex] ?? "";
          }
          return {
            question,
            suggestedAnswer,
            rationale: typeof s.rationale === "string" ? s.rationale : undefined,
            options,
            correctIndex,
          };
        });
      if (suggestions.length === 0) suggestions = undefined;
    }

    let emailDraft: CopilotEmailDraft | undefined;
    const rawEmailDraft = parsed.emailDraft as Record<string, unknown> | null | undefined;
    if (rawEmailDraft !== null && typeof rawEmailDraft === "object") {
      const subj = rawEmailDraft.subject;
      const b = rawEmailDraft.body;
      if (typeof subj === "string" && typeof b === "string") {
        emailDraft = {
          subject: subj,
          body: b,
          recipientHint: typeof rawEmailDraft.recipientHint === "string" ? rawEmailDraft.recipientHint : undefined,
          contextNote: typeof rawEmailDraft.contextNote === "string" ? rawEmailDraft.contextNote : undefined,
        };
      }
    }

    return {
      type: "summary",
      title,
      content: summary,
      keyPoints: keyPoints?.length ? keyPoints : undefined,
      suggestions,
      emailDraft,
    };
  } catch {
    return {
      type: "summary",
      title: "Summary",
      content,
      keyPoints: undefined,
      suggestions: undefined,
      emailDraft: undefined,
    };
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

function stripMarkdownFences(text: string): string {
  let out = text.trim();
  if (out.startsWith("```")) {
    const lines = out.split("\n");
    lines.shift();
    if (lines[lines.length - 1]?.trim() === "```") lines.pop();
    out = lines.join("\n").trim();
  }
  return out;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CopilotInterpretRequest;
    const { task } = body;

    if (task === "explain_incorrect") {
      const { question, userAnswer, correctAnswer, rationale, context } = body as CopilotExplainIncorrectRequest;
      if (typeof question !== "string" || typeof userAnswer !== "string" || typeof correctAnswer !== "string") {
        return NextResponse.json(
          { error: "Missing or invalid required fields: question, userAnswer, correctAnswer" },
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
      const userPrompt = buildCopilotExplainIncorrectPrompt(
        question,
        userAnswer,
        correctAnswer,
        rationale,
        context
      );
      const response = await callLLM(
        {
          messages: [
            { role: "system", content: COPILOT_EXPLAIN_INCORRECT_SYSTEM },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          maxTokens: 512,
        },
        provider
      );
      const explanation = stripMarkdownFences(response.content);
      return NextResponse.json({ explanation }, { headers: corsHeaders });
    }

    if (task !== "summarize") {
      return NextResponse.json(
        { error: "Unsupported task. Supported: summarize, explain_incorrect" },
        { status: 400, headers: corsHeaders }
      );
    }

    const { screenshot, context } = body as CopilotSummarizeRequest;
    if (!context?.url) {
      return NextResponse.json(
        { error: "Missing required field: context.url" },
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
