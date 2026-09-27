import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { actionDecision } from '../shared/contracts.js';
import { env } from './gemini.js';
import { promptSafety } from './prompts.js';
import { scheduleProvider } from './providerQueue.js';

const decisionSchema = actionDecision.extend({ confidence: z.number().min(0).max(1) });
const model = () => new ChatGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, temperature: 0, maxRetries: 0 });
export function validateDistinctExpertRoles<T extends { subagents: Array<{ name: string }> }>(decision: T): T {
  if (new Set(decision.subagents.map(agent => agent.name)).size !== decision.subagents.length) {
    throw new Error('The decision controller must assign each specialist role at most once.');
  }
  return decision;
}
const directivePrompt = ChatPromptTemplate.fromMessages([
  ['system', `${promptSafety} You are ORION's JEV-style JSON decision controller, one role of the configured model. Return one validated directive for exactly one next action and activate exactly two distinct specialist roles only when choosing web_search; for other tools, keep their assignments dormant. Choose from Evidence Analyst (primary and authoritative sources), Domain Expert (definitions, mechanisms, methods, and context), and Skeptic (counter-evidence, limitations, conflicting claims, and uncertainty). Select the most relevant mix for this task, give each a distinct directive under 300 characters, and never duplicate a role. Prefer the proposed plan tool unless evidence justifies another; always use files for a save/report step; never choose api_get unless a configured operation clearly matches. Confidence is an uncertainty estimate, not a correctness guarantee.`],
  ['human', 'Validated TASK_ANALYSIS:\n{analysis}\n\nWORKFLOW_PLAN:\n{plan}\n\nCURRENT STEP:\n{step}\n\nRECENT EVIDENCE:\n{evidence}\n\nConfigured read-only API operations:\n{apiNames}']
]);

export async function decisionHealth() {
  const configured = Boolean(env.GEMINI_API_KEY);
  return { configured, model: env.GEMINI_MODEL, provider: 'Gemini API · JEV-style JSON decision controller', freeTierNote: 'Gemini 3.5 Flash-Lite supports free-tier text generation. Document research mode avoids Google Search grounding. Project quota still applies.' };
}

export async function chooseAction(input: { analysis: unknown; plan: unknown[]; step: unknown; evidence: unknown[]; apiNames: string[] }) {
  if (!env.GEMINI_API_KEY) throw new Error('Add GEMINI_API_KEY to .env before starting a run.');
  const structured = model().withStructuredOutput(decisionSchema);
  const chain = directivePrompt.pipe(structured);
  const answer = await scheduleProvider(() => chain.invoke({
    analysis: JSON.stringify(input.analysis),
    plan: JSON.stringify(input.plan),
    step: JSON.stringify(input.step),
    evidence: JSON.stringify(input.evidence),
    apiNames: JSON.stringify(input.apiNames),
  }));
  const validated = validateDistinctExpertRoles(decisionSchema.parse(answer));
  return { ...validated, subagents: validated.subagents.slice(0, 2) };
}
