// LLM Provider types

export type LLMProvider = "openai" | "anthropic" | "openrouter" | "ollama";

export interface LLMConfig {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model?: string;
  provider: LLMProvider;
}

export interface LLMError {
  message: string;
  code?: string;
  provider: LLMProvider;
}

// Form field types for LLM context
export interface FormField {
  index: number;
  tag: string;
  type: string;
  id: string | null;
  name: string | null;
  label: string;
  placeholder: string | null;
  required: boolean;
  disabled: boolean;
  readonly: boolean;
  value: string;
  options?: { value: string; text: string; selected: boolean }[] | null;
  checked?: boolean | null;
  autocomplete?: string | null;
  pattern?: string | null;
  maxLength?: number | null;
}

export interface FormButton {
  index: number;
  tag: string;
  type: string;
  text: string;
  id: string | null;
  disabled: boolean;
}

export interface PageObservation {
  url: string;
  title: string;
  fields: FormField[];
  buttons: FormButton[];
  pageContext: string;
}

