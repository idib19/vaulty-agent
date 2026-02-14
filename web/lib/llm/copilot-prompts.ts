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
The user is viewing a web page and wants a summary. They may also be on a test, quiz, or assessment and want answer suggestions for study help.

Given the page content (and optionally a screenshot), provide:

1. A concise title describing what this page is about
2. A clear summary (3-5 sentences)
3. 3-5 key bullet points
4. If the page contains questions (quiz, test, assessment, form with questions), also provide a "suggestions" array. For each item:
   - "question": short label or the question text
   - "suggestedAnswer": the suggested/correct answer text (required for single-answer; for multiple-choice this can be the correct option text)
   - "rationale": (optional) brief explanation for the correct answer, for study help
   - For MULTIPLE-CHOICE questions only, also include:
     - "options": array of choice strings in order as shown on the page (e.g. ["A) First option", "B) Second option", "C) Third option"])
     - "correctIndex": 0-based index of the correct option in the "options" array

Respond in JSON:
{
  "title": "...",
  "summary": "...",
  "keyPoints": ["...", "...", "..."],
  "suggestions": [
    { "question": "...", "suggestedAnswer": "...", "rationale": "..." },
    { "question": "...", "suggestedAnswer": "...", "options": ["A) ...", "B) ...", "C) ..."], "correctIndex": 1, "rationale": "..." }
  ]
}

Use the first format (suggestedAnswer only) for free-form or single-answer questions. Use the second format (with options and correctIndex) for multiple-choice questions so the user can run a practice quiz. If there are no clear questions on the page, omit "suggestions" or set it to [].

Rules:
- Be concise and informative
- Focus on the main content, ignore navigation, ads, footers
- If it's an article, summarize the argument/story
- If it's a product page, summarize what the product does and pricing
- If it's an email, summarize who it's from, subject, and key asks
- Use plain language
- Suggestions are for study help only; label them clearly as suggested answers, not guaranteed correct answers`;

export function buildCopilotSummarizePrompt(context: CopilotPageContext): string {
  return `Page URL: ${context.url}
Page Title: ${context.title}
${context.selectedText ? `\nSelected Text: ${context.selectedText}` : ""}

Page Content (truncated):
${context.pageText?.slice(0, 4000) || "(no text extracted)"}

Summarize this page.`;
}

export const COPILOT_EXPLAIN_INCORRECT_SYSTEM = `You are Vaulty Copilot, a study-help assistant. The user got a quiz question wrong and wants a deeper explanation.

Respond in plain language only (no JSON, no code blocks). In 2-4 clear sentences:
1. Briefly explain why the answer they chose is wrong or misleading.
2. Explain why the correct answer is right.

Be concise and educational. Use simple language.`;

export interface CopilotExplainContext {
  summary?: string;
  title?: string;
}

export function buildCopilotExplainIncorrectPrompt(
  question: string,
  userAnswer: string,
  correctAnswer: string,
  rationale?: string,
  context?: CopilotExplainContext
): string {
  let text = `Question: ${question}

The user selected: ${userAnswer || "(no answer selected)"}
The correct answer is: ${correctAnswer}
`;
  if (rationale) text += `\nBrief rationale we already showed: ${rationale}\n`;
  if (context?.title) text += `\nPage title: ${context.title}`;
  if (context?.summary) text += `\nPage summary: ${context.summary.slice(0, 800)}`;
  text += "\n\nProvide a deeper explanation (2-4 sentences) of why the chosen answer is wrong and why the correct answer is right.";
  return text;
}
