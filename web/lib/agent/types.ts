/**
 * Agent Conversation History Types
 * 
 * These types support maintaining rich conversation history
 * across agent steps for improved context and learning.
 */

import type { AgentAction, Observation } from "../types";

/**
 * A single entry in the conversation history
 */
export interface ConversationEntry {
  step: number;
  timestamp: string;
  
  // What the agent was thinking
  thinking: string;
  
  // What action it decided to take
  action: {
    type: string;
    target?: string;  // Human-readable target description
    value?: string;   // For FILL actions
  };
  
  // The outcome
  result: {
    ok: boolean;
    error?: string;
  };
  
  // Page context at this step
  context: {
    url: string;
    pageTitle?: string;
    fieldsCount: number;
    buttonsCount: number;
  };
}

/**
 * Summarized conversation for LLM context
 * (Keeps token usage manageable)
 */
export interface ConversationSummary {
  totalSteps: number;
  successfulActions: number;
  failedActions: number;
  
  // Recent entries (last 5-7 for detailed context)
  recentEntries: ConversationEntry[];
  
  // Patterns detected
  patterns: {
    repeatedFailures?: string[];  // Actions that keep failing
    successfulStrategies?: string[];  // What's working
  };
}

/**
 * Format for including in LLM messages
 */
export interface LLMConversationContext {
  // Formatted as assistant/user message pairs
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  
  // Summary text for system prompt injection
  summaryText: string;
}

/**
 * Configuration for conversation history
 */
export interface ConversationConfig {
  maxEntries: number;           // Max entries to keep (default: 20)
  maxEntriesForLLM: number;     // Max entries to send to LLM (default: 7)
  includeFullHistory: boolean;  // Whether to include older entries as summary
}

export const DEFAULT_CONVERSATION_CONFIG: ConversationConfig = {
  maxEntries: 20,
  maxEntriesForLLM: 7,
  includeFullHistory: true,
};

