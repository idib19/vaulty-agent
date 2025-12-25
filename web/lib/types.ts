import type { UserProfile } from "./profile";
import type { FormField, FormButton } from "./llm/types";

export type AgentMode = "live" | "background";

export type Target =
  | { by: "role"; role: string; name?: string }
  | { by: "label"; text: string }
  | { by: "text"; text: string; exact?: boolean }
  | { by: "css"; selector: string }
  | { by: "id"; selector: string }
  | { by: "index"; index: number; elementType: "field" | "button" }
  | { by: "xpath"; xpath: string };

export type VerificationKind = "OTP" | "EMAIL_CODE" | "CAPTCHA" | "PASSWORD" | "OAUTH";

export type AgentAction =
  | { type: "NAVIGATE"; url: string }
  | { type: "CLICK"; target: Target; requiresApproval?: boolean }
  | { type: "FILL"; target: Target; value: string; clear?: boolean }
  | { type: "SELECT"; target: Target; value: string }
  | { type: "CHECK"; target: Target; checked?: boolean }
  | { type: "WAIT_FOR"; target: Target; timeoutMs?: number }
  | { type: "EXTRACT"; target?: Target; mode: "visibleText" | "html" | "fields" }
  | { type: "REQUEST_VERIFICATION"; kind: VerificationKind; context?: Record<string, unknown> }
  | { type: "DONE"; summary: string };

// Enhanced observation with structured fields
export type Observation = {
  url: string;
  title: string;
  text?: string; // Legacy: truncated visible text
  fields?: FormField[];
  buttons?: FormButton[];
  pageContext?: string;
};

export type PlannerRequest = {
  jobId: string;
  step: number;
  mode: AgentMode;
  observation: Observation;
  profile?: UserProfile;
  state?: Record<string, unknown>;
};

export type PlannerResponse = {
  action: AgentAction;
  // Optional: force bring tab to front if needed (captcha/login)
  forceLive?: boolean;
};
