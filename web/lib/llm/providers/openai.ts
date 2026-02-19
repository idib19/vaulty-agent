import type { LLMRequest, LLMResponse, LLMVisionRequest } from "../types";

const DEFAULT_MODEL = "gpt-4o-mini";
const VISION_MODEL = "gpt-4o-mini"; // Vision-capable model (gpt-4o and gpt-4o-mini both support vision)

export async function callOpenAI(request: LLMRequest): Promise<LLMResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: request.messages,
      temperature: request.temperature ?? 0.1,
      max_tokens: request.maxTokens ?? 1024,
      ...(request.jsonMode && { response_format: { type: "json_object" } }),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  
  return {
    content: data.choices[0]?.message?.content || "",
    usage: data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    } : undefined,
    model: data.model,
    provider: "openai",
  };
}

// Vision-enabled OpenAI call using GPT-4o
export async function callOpenAIWithVision(request: LLMVisionRequest): Promise<LLMResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  // Always use gpt-4o for vision (it's the best vision model)
  const model = VISION_MODEL;

  // Transform messages to include images
  const messagesWithImages = request.messages.map((m, idx) => {
    // Add images to the last user message
    if (m.role === "user" && idx === request.messages.length - 1 && request.images?.length > 0) {
      return {
        role: "user" as const,
        content: [
          { type: "text" as const, text: m.content },
          ...request.images.map(img => ({
            type: "image_url" as const,
            image_url: {
              url: `data:${img.type};base64,${img.base64}`,
              detail: "high" as const, // Use high detail for better analysis
            }
          }))
        ]
      };
    }
    return {
      role: m.role,
      content: m.content,
    };
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: messagesWithImages,
      temperature: request.temperature ?? 0.1,
      max_tokens: request.maxTokens ?? 1024,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI Vision API error: ${response.status} - ${error}`);
  }

  const data = await response.json();

  return {
    content: data.choices[0]?.message?.content || "",
    usage: data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    } : undefined,
    model: data.model,
    provider: "openai",
  };
}

