import type { LLMProvider, LLMRequest, LLMResponse, LLMVisionRequest } from "./types";
import { callOpenAI, callOpenAIWithVision } from "./providers/openai";
import { callAnthropic } from "./providers/anthropic";
import { callOpenRouter } from "./providers/openrouter";
import { callOllama } from "./providers/ollama";

export function getConfiguredProvider(): LLMProvider {
  const provider = process.env.LLM_PROVIDER?.toLowerCase() as LLMProvider;
  
  // Validate provider
  if (provider && ["openai", "anthropic", "openrouter", "ollama"].includes(provider)) {
    return provider;
  }
  
  // Auto-detect based on available API keys
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  
  // Default to ollama for local development
  return "ollama";
}

export async function callLLM(request: LLMRequest, provider?: LLMProvider): Promise<LLMResponse> {
  const selectedProvider = provider || getConfiguredProvider();
  
  console.log(`[LLM Router] Using provider: ${selectedProvider}`);
  
  switch (selectedProvider) {
    case "openai":
      return callOpenAI(request);
    case "anthropic":
      return callAnthropic(request);
    case "openrouter":
      return callOpenRouter(request);
    case "ollama":
      return callOllama(request);
    default:
      throw new Error(`Unknown LLM provider: ${selectedProvider}`);
  }
}

// Vision-enabled LLM call (currently only supports OpenAI GPT-4o)
export async function callLLMWithVision(request: LLMVisionRequest, provider?: LLMProvider): Promise<LLMResponse> {
  const selectedProvider = provider || getConfiguredProvider();
  
  console.log(`[LLM Router] Using vision provider: ${selectedProvider}`);
  
  // Currently only OpenAI supports vision well
  // For other providers, we fall back to text-only with a warning
  switch (selectedProvider) {
    case "openai":
      return callOpenAIWithVision(request);
    case "anthropic":
      // Anthropic Claude 3 supports vision, but we'd need to implement it
      console.warn("[LLM Router] Anthropic vision not implemented, falling back to text-only");
      return callAnthropic(request);
    case "openrouter":
      // OpenRouter can route to vision models, but needs special handling
      console.warn("[LLM Router] OpenRouter vision not implemented, falling back to text-only");
      return callOpenRouter(request);
    case "ollama":
      // Some Ollama models support vision (llava, bakllava)
      console.warn("[LLM Router] Ollama vision not implemented, falling back to text-only");
      return callOllama(request);
    default:
      throw new Error(`Unknown LLM provider: ${selectedProvider}`);
  }
}

// Check if vision is supported for the current provider
export function isVisionSupported(provider?: LLMProvider): boolean {
  const selectedProvider = provider || getConfiguredProvider();
  // Currently only OpenAI is fully supported for vision
  return selectedProvider === "openai" && !!process.env.OPENAI_API_KEY;
}

// Convenience function for simple prompts
export async function prompt(
  userMessage: string, 
  systemMessage?: string,
  options?: { provider?: LLMProvider; jsonMode?: boolean }
): Promise<string> {
  const messages = [];
  
  if (systemMessage) {
    messages.push({ role: "system" as const, content: systemMessage });
  }
  
  messages.push({ role: "user" as const, content: userMessage });
  
  const response = await callLLM({
    messages,
    jsonMode: options?.jsonMode,
  }, options?.provider);
  
  return response.content;
}

