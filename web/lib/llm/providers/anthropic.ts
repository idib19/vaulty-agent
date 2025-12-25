import type { LLMRequest, LLMResponse } from "../types";

const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";

export async function callAnthropic(request: LLMRequest): Promise<LLMResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  // Extract system message if present
  const systemMessage = request.messages.find(m => m.role === "system");
  const userMessages = request.messages.filter(m => m.role !== "system");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens ?? 1024,
      ...(systemMessage && { system: systemMessage.content }),
      messages: userMessages.map(m => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  
  return {
    content: data.content[0]?.text || "",
    usage: data.usage ? {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
      totalTokens: data.usage.input_tokens + data.usage.output_tokens,
    } : undefined,
    model: data.model,
    provider: "anthropic",
  };
}

