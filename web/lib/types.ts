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

// ASK_USER option for multi-choice questions
export interface AskUserOption {
  id: string;
  label: string;
}

// ASK_USER action - when the agent needs user input
export interface AskUserAction {
  type: "ASK_USER";
  question: string;
  options: AskUserOption[];
  allowCustom?: boolean; // Allow free-text response
  context?: Record<string, unknown>;
}

export type AgentAction =
  | { type: "NAVIGATE"; url: string }
  | { type: "CLICK"; target: Target; requiresApproval?: boolean }
  | { type: "FILL"; target: Target; value: string; clear?: boolean }
  | { type: "SELECT"; target: Target; value: string }
  | { type: "SELECT_CUSTOM"; target: Target; value: string } // For custom dropdowns (div-based comboboxes)
  | { type: "CHECK"; target: Target; checked?: boolean }
  | { type: "WAIT_FOR"; target: Target; timeoutMs?: number }
  | { type: "EXTRACT"; target?: Target; mode: "visibleText" | "html" | "fields" }
  | { type: "UPLOAD_FILE"; target: Target; fileType?: "resume" }
  | { type: "REQUEST_VERIFICATION"; kind: VerificationKind; context?: Record<string, unknown> }
  | AskUserAction
  | { type: "DONE"; summary: string };

// Special elements detected on the page
export interface SpecialElements {
  hasCaptcha?: boolean;
  captchaType?: "recaptcha" | "hcaptcha" | "cloudflare" | "unknown";
  hasOAuthButtons?: string[]; // ["google", "linkedin", "github", etc.]
  hasFileUpload?: boolean;
  hasPasswordField?: boolean;
  hasCookieBanner?: boolean;
}

// Enhanced observation with structured fields
export type Observation = {
  url: string;
  title: string;
  text?: string; // Legacy: truncated visible text
  fields?: FormField[];
  buttons?: FormButton[];
  pageContext?: string;
  specialElements?: SpecialElements;
};

// Action history for context
export interface ActionHistoryEntry {
  step: number;
  timestamp?: string;
  thinking?: string;
  action: {
    type: string;
    target?: string;
    value?: string;
    [key: string]: unknown;
  };
  result?: {
    ok: boolean;
    error?: string;
  };
  context?: {
    url?: string;
    pageTitle?: string;
    fieldsCount?: number;
    buttonsCount?: number;
  };
  url?: string; // Legacy: some entries use url directly
}

export type PlannerRequest = {
  jobId: string;
  step: number;
  mode: AgentMode;
  observation: Observation;
  profile?: UserProfile;
  state?: Record<string, unknown>;
  actionHistory?: ActionHistoryEntry[]; // Previous actions for context
  applicationState?: ApplicationState; // Goal-focused state tracking
};

// Enhanced planner response with thinking and confidence
export type PlannerResponse = {
  action: AgentAction;
  // Agent's reasoning process (for HUD display)
  thinking?: string;
  // Confidence score 0.0-1.0
  confidence?: number;
  // Force bring tab to front if needed (captcha/login/ask_user)
  forceLive?: boolean;
  // Multi-step plan (when planning mode is active)
  plan?: ActionPlan;
};

// ============================================================
// MULTI-STEP PLANNING - Phase 2
// ============================================================

// A single planned action with human-readable metadata
export interface PlannedAction {
  action: AgentAction;
  fieldName: string;       // Human-readable: "Full name", "Email", "Phone", etc.
  expectedResult: string;  // "Field filled with IDRISSA BERTHE"
  completed?: boolean;     // Track execution status
  result?: {
    ok: boolean;
    error?: string;
  };
}

// A complete plan for filling a form section
export interface ActionPlan {
  thinking: string;        // LLM's analysis of the form
  confidence: number;      // Overall plan confidence
  plan: PlannedAction[];   // Ordered list of actions
  currentStepIndex: number; // Which step we're on (0-based)
  startUrl: string;        // URL when plan was created (for re-plan detection)
  createdAt: string;       // ISO timestamp
}

// Extended planner request with planning support
export interface PlanningRequest extends PlannerRequest {
  requestPlan?: boolean;   // Request a full plan instead of single action
  currentPlan?: ActionPlan; // Current plan for re-planning context
}

// User response to ASK_USER action
export interface UserResponse {
  jobId: string;
  selectedOptionId?: string; // If user picked an option
  customResponse?: string; // If user typed a custom response
  skipped?: boolean; // If user chose to skip
}

// ============================================================
// APPLICATION STATE - Goal-focused agent tracking
// ============================================================

// Goal context for the application (set at start, persists)
export interface ApplicationGoal {
  jobUrl: string;
  jobTitle: string;
  company: string;
  startedAt: string; // ISO timestamp
}

// Application phases
export type ApplicationPhase =
  | "navigating"     // Going to job page
  | "logging_in"     // Authentication required
  | "filling_form"   // Main application form
  | "reviewing"      // Review/confirm page
  | "submitting"     // Final submit
  | "completed";     // Success

// Progress tracking
export interface ApplicationProgress {
  phase: ApplicationPhase;
  sectionsCompleted: string[];
  currentSection: string | null;
  fieldsFilledThisPage: string[];
  estimatedProgress: number; // 0-100
}

// Types of blockers
export type BlockerType =
  | "login_required"
  | "captcha"
  | "file_upload"
  | "verification"
  | "error";

// Blocker awareness
export interface ApplicationBlocker {
  type: BlockerType | null;
  description: string | null;
  attemptsMade: number;
}

// Memory of patterns (what worked, what failed)
export interface ApplicationMemory {
  successfulPatterns: string[];
  failedPatterns: string[];
  pagesVisited: string[];
}

// Data passed from external app (Vaulty web dashboard)
export interface ExternalJobData {
  coverLetter?: string;
  resumeId?: string;
  resumeUrl?: string;
  customFields?: Record<string, string>; // e.g., {"salary_expectation": "100k"}
  source?: "linkedin" | "indeed" | "glassdoor" | "ziprecruiter" | "manual" | string;
  priority?: number;
  notes?: string;
}

// Full application state - the "brain" of the agent
export interface ApplicationState {
  goal: ApplicationGoal;
  progress: ApplicationProgress;
  blockers: ApplicationBlocker;
  memory: ApplicationMemory;
  external?: ExternalJobData; // Data from external app
}

// ============================================================
// EXTERNAL MESSAGING TYPES
// ============================================================

// Message to start a job from external app
export interface ExternalStartJobMessage {
  type: "START_JOB_FROM_EXTERNAL";
  payload: {
    jobUrl: string;
    jobTitle?: string;
    company?: string;
    coverLetter?: string;
    resumeId?: string;
    customFields?: Record<string, string>;
    mode?: "live" | "background";
  };
}

// Message to get extension status
export interface ExternalGetStatusMessage {
  type: "GET_EXTENSION_STATUS";
}

// Message to get job status
export interface ExternalGetJobStatusMessage {
  type: "GET_JOB_STATUS";
  jobId: string;
}

// Response for extension status
export interface ExternalStatusResponse {
  ok: boolean;
  installed?: boolean;
  version?: string;
  error?: string;
}

// Response for job start
export interface ExternalJobStartResponse {
  ok: boolean;
  jobId?: string;
  message?: string;
  error?: string;
}

// Status update callback (extension -> web app)
export interface ExternalJobStatusUpdate {
  type: "JOB_STATUS_UPDATE";
  jobId: string;
  status: "started" | "running" | "paused" | "done" | "error";
  progress?: number;
  phase?: ApplicationPhase;
  error?: string;
}

// Helper to create initial state
export function createInitialApplicationState(
  jobUrl: string,
  jobTitle?: string,
  company?: string
): ApplicationState {
  return {
    goal: {
      jobUrl,
      jobTitle: jobTitle || "Unknown Position",
      company: company || "Unknown Company",
      startedAt: new Date().toISOString(),
    },
    progress: {
      phase: "navigating",
      sectionsCompleted: [],
      currentSection: null,
      fieldsFilledThisPage: [],
      estimatedProgress: 0,
    },
    blockers: {
      type: null,
      description: null,
      attemptsMade: 0,
    },
    memory: {
      successfulPatterns: [],
      failedPatterns: [],
      pagesVisited: [],
    },
  };
}
