/**
 * Conversation History Builder
 * 
 * Builds and formats conversation history for LLM context.
 * This helps the agent "remember" what it tried and learn from failures.
 */

import type { 
  ConversationEntry, 
  ConversationSummary, 
  LLMConversationContext,
  ConversationConfig 
} from "./types";
import { DEFAULT_CONVERSATION_CONFIG } from "./types";

/**
 * Create a new conversation entry from agent step data
 */
export function createConversationEntry(
  step: number,
  thinking: string,
  action: { type: string; target?: unknown; value?: string },
  result: { ok: boolean; error?: string },
  observation: { url?: string; title?: string; fields?: unknown[]; buttons?: unknown[] }
): ConversationEntry {
  // Extract human-readable target description
  let targetDesc = "";
  if (action.target) {
    const t = action.target as Record<string, unknown>;
    targetDesc = (t.text as string) || (t.selector as string) || (t.label as string) || 
                 (typeof t.index === "number" ? `index ${t.index}` : "");
  }

  return {
    step,
    timestamp: new Date().toISOString(),
    thinking: thinking?.slice(0, 200) || "", // Truncate long thinking
    action: {
      type: action.type,
      target: targetDesc,
      value: action.value?.slice(0, 50), // Truncate long values
    },
    result: {
      ok: result.ok,
      error: result.error?.slice(0, 100), // Truncate long errors
    },
    context: {
      url: observation.url || "",
      pageTitle: observation.title,
      fieldsCount: observation.fields?.length || 0,
      buttonsCount: observation.buttons?.length || 0,
    },
  };
}

/**
 * Analyze conversation history for patterns
 */
export function analyzePatterns(entries: ConversationEntry[]): ConversationSummary["patterns"] {
  const patterns: ConversationSummary["patterns"] = {};
  
  // Find repeated failures (same action type + target failing multiple times)
  const failureCounts = new Map<string, number>();
  const successCounts = new Map<string, number>();
  
  for (const entry of entries) {
    const key = `${entry.action.type}:${entry.action.target}`;
    
    if (!entry.result.ok) {
      failureCounts.set(key, (failureCounts.get(key) || 0) + 1);
    } else {
      successCounts.set(key, (successCounts.get(key) || 0) + 1);
    }
  }
  
  // Identify repeated failures (2+ failures for same action)
  const repeatedFailures: string[] = [];
  for (const [key, count] of failureCounts) {
    if (count >= 2) {
      repeatedFailures.push(`${key} (failed ${count}x)`);
    }
  }
  if (repeatedFailures.length > 0) {
    patterns.repeatedFailures = repeatedFailures;
  }
  
  // Identify successful strategies
  const successfulStrategies: string[] = [];
  for (const [key, count] of successCounts) {
    if (count >= 1) {
      successfulStrategies.push(key);
    }
  }
  if (successfulStrategies.length > 0) {
    patterns.successfulStrategies = successfulStrategies.slice(0, 5); // Top 5
  }
  
  return patterns;
}

/**
 * Build a summary of the conversation history
 */
export function buildConversationSummary(
  entries: ConversationEntry[],
  config: ConversationConfig = DEFAULT_CONVERSATION_CONFIG
): ConversationSummary {
  const successfulActions = entries.filter(e => e.result.ok).length;
  const failedActions = entries.filter(e => !e.result.ok).length;
  
  return {
    totalSteps: entries.length,
    successfulActions,
    failedActions,
    recentEntries: entries.slice(-config.maxEntriesForLLM),
    patterns: analyzePatterns(entries),
  };
}

/**
 * Format a single entry as an assistant message (what the agent decided)
 */
function formatAsAssistantMessage(entry: ConversationEntry): string {
  const actionDesc = entry.action.value 
    ? `${entry.action.type} "${entry.action.target}" with value "${entry.action.value}"`
    : `${entry.action.type} "${entry.action.target}"`;
  
  return `Step ${entry.step}: ${entry.thinking ? entry.thinking + " → " : ""}${actionDesc}`;
}

/**
 * Format a single entry as a user message (the result/feedback)
 */
function formatAsUserMessage(entry: ConversationEntry, nextEntry?: ConversationEntry): string {
  const resultText = entry.result.ok 
    ? "✓ Success" 
    : `✗ Failed: ${entry.result.error || "unknown error"}`;
  
  // If there's a next step, include its observation context
  if (nextEntry) {
    return `${resultText}. Now on: ${nextEntry.context.url} (${nextEntry.context.fieldsCount} fields, ${nextEntry.context.buttonsCount} buttons)`;
  }
  
  return resultText;
}

/**
 * Build LLM conversation context from history
 */
export function buildLLMConversationContext(
  entries: ConversationEntry[],
  config: ConversationConfig = DEFAULT_CONVERSATION_CONFIG
): LLMConversationContext {
  const summary = buildConversationSummary(entries, config);
  const messages: LLMConversationContext["messages"] = [];
  
  // Convert recent entries to message pairs
  for (let i = 0; i < summary.recentEntries.length; i++) {
    const entry = summary.recentEntries[i];
    const nextEntry = summary.recentEntries[i + 1];
    
    // Assistant message: what the agent decided
    messages.push({
      role: "assistant",
      content: formatAsAssistantMessage(entry),
    });
    
    // User message: the result
    messages.push({
      role: "user", 
      content: formatAsUserMessage(entry, nextEntry),
    });
  }
  
  // Build summary text for system prompt
  let summaryText = `CONVERSATION HISTORY (${summary.totalSteps} steps, ${summary.successfulActions} succeeded, ${summary.failedActions} failed)`;
  
  if (summary.patterns.repeatedFailures && summary.patterns.repeatedFailures.length > 0) {
    summaryText += `\n⚠️ REPEATED FAILURES: ${summary.patterns.repeatedFailures.join(", ")}`;
    summaryText += `\n→ Try a DIFFERENT approach for these actions!`;
  }
  
  return {
    messages,
    summaryText,
  };
}

/**
 * Format conversation history as a single text block
 * (Alternative to message pairs, for simpler integration)
 */
export function formatHistoryAsText(
  entries: ConversationEntry[],
  maxEntries: number = 7
): string {
  if (entries.length === 0) return "";
  
  const recent = entries.slice(-maxEntries);
  const lines: string[] = ["RECENT ACTIONS:"];
  
  for (const entry of recent) {
    const status = entry.result.ok ? "✓" : "✗";
    const actionDesc = entry.action.value 
      ? `${entry.action.type} "${entry.action.target}" = "${entry.action.value}"`
      : `${entry.action.type} "${entry.action.target}"`;
    
    let line = `  ${status} Step ${entry.step}: ${actionDesc}`;
    if (!entry.result.ok && entry.result.error) {
      line += ` (Error: ${entry.result.error})`;
    }
    lines.push(line);
  }
  
  // Add pattern warnings
  const patterns = analyzePatterns(entries);
  if (patterns.repeatedFailures && patterns.repeatedFailures.length > 0) {
    lines.push("");
    lines.push("⚠️ REPEATED FAILURES - TRY DIFFERENT APPROACH:");
    for (const failure of patterns.repeatedFailures) {
      lines.push(`  - ${failure}`);
    }
  }
  
  return lines.join("\n");
}

