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

// Image for vision requests
export interface LLMImage {
  base64: string;
  type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

// Vision-enabled LLM request
export interface LLMVisionRequest extends LLMRequest {
  images: LLMImage[];
}

// Suggested alternative element for retry
export interface AlternativeElement {
  index: number;
  text: string;
  context: string; // MODAL, NAV, MAIN, etc.
  priority: number;
}

// Failed action structure for loop context
export interface FailedAction {
  type?: string;
  target?: {
    by?: string;
    text?: string;
    selector?: string;
    index?: number;
    elementType?: string;
  };
  value?: string;
  [key: string]: unknown;
}

// Loop context for vision recovery
export interface LoopContext {
  isLoop: boolean;
  failedAction?: FailedAction;
  failCount: number;
  error?: string;
  suggestedAlternatives?: AlternativeElement[];
  loopType?: 'semantic' | 'fill' | 'technical';
  targetDescription?: string;
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

// Element context types
export type ElementContext = "MODAL" | "NAV" | "SIDEBAR" | "MAIN" | "FOOTER" | "FORM" | "PAGE";

// Dropdown option for custom dropdowns
export interface DropdownOption {
  index: number;
  text: string;
  value: string;
  selected: boolean;
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
  // Validation error detection
  hasError?: boolean;
  errorMessage?: string | null;
  // Element context (MODAL, NAV, MAIN, etc.)
  context?: ElementContext;
  // Custom dropdown detection (for div-based comboboxes)
  isCustomDropdown?: boolean;
  dropdownExpanded?: boolean;
  dropdownOptions?: DropdownOption[];
  ariaControls?: string | null;
}

export interface FormButton {
  index: number;
  tag: string;
  type: string;
  text: string;
  id: string | null;
  disabled: boolean;
  // Element context (MODAL, NAV, MAIN, etc.)
  context?: ElementContext;
}

// Special elements detected on the page
export interface SpecialElements {
  hasCaptcha?: boolean;
  captchaType?: "recaptcha" | "hcaptcha" | "cloudflare" | "unknown";
  hasOAuthButtons?: string[]; // ["google", "linkedin", "github", etc.]
  hasFileUpload?: boolean;
  hasPasswordField?: boolean;
  hasCookieBanner?: boolean;
  // OTP/Verification code detection
  hasOtpField?: boolean;
  otpFieldCount?: number;
  otpFieldIndices?: number[];
}

export interface PageObservation {
  url: string;
  title: string;
  fields: FormField[];
  buttons: FormButton[];
  pageContext: string;
  specialElements?: SpecialElements;
  // Modal awareness
  hasActiveModal?: boolean;
  modalTitle?: string | null;
}

