/**
 * Copilot-specific prompts for the Vaulty Web Copilot feature.
 * Used for on-demand page summarization and future capabilities.
 */

export interface CopilotPageContext {
  url: string;
  title: string;
  selectedText?: string;
  pageText?: string;
}

export const COPILOT_SUMMARIZE_SYSTEM = `You are Vaulty Copilot, a helpful web browsing assistant.
The user is viewing a web page and wants a summary.

Given the page content (and optionally a screenshot), provide:
1. A concise title describing what this page is about
2. A clear summary (3-5 sentences)
3. 3-5 key bullet points

Respond in JSON:
{
  "title": "...",
  "summary": "...",
  "keyPoints": ["...", "...", "..."]
}

Rules:
- Be concise and informative
- Focus on the main content, ignore navigation, ads, footers
- If it's an article, summarize the argument/story
- If it's a product page, summarize what the product does and pricing
- If it's an email, summarize who it's from, subject, and key asks
- Use plain language`;

export function buildCopilotSummarizePrompt(context: CopilotPageContext): string {
  return `Page URL: ${context.url}
Page Title: ${context.title}
${context.selectedText ? `\nSelected Text: ${context.selectedText}` : ""}

Page Content (truncated):
${context.pageText?.slice(0, 4000) || "(no text extracted)"}

Summarize this page.`;
}
