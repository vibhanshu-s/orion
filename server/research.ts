import { env, gemini, textFrom } from './gemini.js';
import { emit } from './db.js';
import { providerRetry } from './providerRetry.js';
import { promptSafety, specialistPrompt, expertSynthesisPrompt, type SpecialistName } from './prompts.js';

type Source = { title: string; url: string };
type Note = { agent: SpecialistName; lens: string; text: string; sources: Source[] };
type Directive = { name: SpecialistName; directive: string };
export type ResearchAdapters = {
  generate: typeof gemini;
  report: typeof emit;
  wait: (milliseconds: number) => Promise<void>;
};

const adapters: ResearchAdapters = {
  generate: gemini,
  report: emit,
  wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};

export function providerFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown provider error');
  let message = raw.replace(/\s+/g, ' ').trim();
  if (env.GEMINI_API_KEY) message = message.replaceAll(env.GEMINI_API_KEY, '[redacted]');
  message = message.replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]');
  if (message.length > 320) message = `${message.slice(0, 317)}…`;
  if (/\b429\b|resource_exhausted|rate.?limit|quota/i.test(raw)) {
    return `${message} Check model and Search grounding quotas for this API project.`;
  }
  if (/\b403\b|permission|access denied/i.test(raw)) {
    return `${message} Check that this API project and key have access to the selected model and Search grounding.`;
  }
  if (/\b400\b|google_search|grounding|not supported|invalid argument/i.test(raw)) {
    return `${message} Check that Google Search grounding is enabled for this project and supported by the selected model.`;
  }
  return message;
}

async function generateWithRetry(operation: () => ReturnType<typeof gemini>, io: ResearchAdapters, taskId: string) {
  return providerRetry(operation, { wait: io.wait, onRetry: (attempt, delayMs) =>
    io.report(taskId, 'retry', { attempt, delayMs, message: `Provider busy. Retry ${attempt}/2 in ${Math.ceil(delayMs / 1000)} seconds.` }) });
}

function sourcesFrom(payload: any): Source[] {
  const chunks = payload.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  return chunks.flatMap((chunk: any) => chunk.web?.uri ? [{ title: chunk.web.title ?? chunk.web.uri, url: chunk.web.uri }] : []).filter((source: Source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

async function runExpert(input: { taskId: string; analysis: unknown; step: string; memories: unknown[] }, agent: Directive, io: ResearchAdapters): Promise<Note> {
  io.report(input.taskId, 'agent_status', { agent: agent.name, role: 'Research specialist', status: 'spawned', detail: agent.directive });
  const payload = await generateWithRetry(() => specialistPrompt({
    analysis: input.analysis,
    question: input.step,
    savedContext: input.memories,
    directive: agent.directive,
    agent: agent.name,
  }).then(prompt => io.generate(prompt, { ...(process.env.RESEARCH_MODE === 'documents' ? {} : { tool: 'google_search' as const }), system: `${promptSafety} ${process.env.RESEARCH_MODE === 'documents' ? 'Use only the supplied document excerpts. Cite their source labels. No live web search was performed. State gaps honestly.' : ''}` })), io, input.taskId);
  const text = textFrom(payload).trim();
  if (!text) throw new Error(`${agent.name} returned no research notes.`);
  const note = { agent: agent.name, lens: agent.directive, text: text.slice(0, 9000), sources: sourcesFrom(payload) };
  io.report(input.taskId, 'agent_message', { agent: agent.name, role: 'Research specialist', phase: 'finding', message: note.text.slice(0, 1600), sources: note.sources });
  io.report(input.taskId, 'agent_status', { agent: agent.name, role: 'Research specialist', status: 'ready', detail: `${note.sources.length} linked sources` });
  return note;
}

export async function researchCouncil(input: { taskId: string; analysis: unknown; step: string; memories: unknown[]; directives: Directive[] }, io: ResearchAdapters = adapters) {
  if (process.env.RESEARCH_MODE === 'documents' && io === adapters && !input.memories.length) throw new Error('Document research mode: import a reference document before research. Google Search grounding is disabled to avoid paid tools.');
  const allowedNames = new Set<SpecialistName>(['Evidence Analyst', 'Domain Expert', 'Skeptic']);
  const directives = input.directives.filter((agent, index, all) => allowedNames.has(agent.name)
    && agent.directive.trim().length >= 8
    && all.findIndex(other => other.name === agent.name) === index);
  if (directives.length < 2 || directives.length > 3) {
    throw new Error('The decision controller must activate two or three distinct approved specialist roles.');
  }
  io.report(input.taskId, 'agent_status', { agent: 'Decision controller', role: 'Mixture-of-experts controller', status: 'starting', detail: `Activating ${directives.map(agent => agent.name).join(', ')} on ${input.step}` });
  const settled: PromiseSettledResult<Note>[] = [];
  for (const agent of directives) {
    try { settled.push({ status: 'fulfilled', value: await runExpert(input, agent, io) }); }
    catch (reason) {
      if (/\b429\b|quota|resource_exhausted/i.test(String(reason))) {
        io.report(input.taskId, 'agent_status', { agent: agent.name, role: 'Research specialist', status: 'failed', detail: providerFailure(reason) });
        throw new Error(`Research stopped to protect your quota; remaining specialists were not called. ${providerFailure(reason)}`);
      }
      settled.push({ status: 'rejected', reason });
    }
  }
  const notes = settled.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [result.value];
    const agent = directives[index];
    io.report(input.taskId, 'agent_status', { agent: agent.name, role: 'Research specialist', status: 'failed', detail: providerFailure(result.reason) });
    return [];
  });
  if (notes.length < 2) {
    const failures = settled.flatMap((result, index) => result.status === 'rejected' ? [`${directives[index].name}: ${providerFailure(result.reason)}`] : []);
    throw new Error(`Only ${notes.length} of ${directives.length} research specialists returned usable evidence. ${failures.join(' ')}`);
  }

  io.report(input.taskId, 'agent_status', { agent: 'Evidence Moderator', role: 'Evidence synthesis', status: 'synthesizing', detail: 'Comparing specialist claims, source support, and disagreements.' });
  const synthesisPayload = await generateWithRetry(async () => io.generate(await expertSynthesisPrompt({
    analysis: input.analysis,
    question: input.step,
    experts: notes.map(({ agent, lens, text, sources }) => ({ agent, lens, text, sources })),
  }), { system: promptSafety }), io, input.taskId);
  const synthesis = textFrom(synthesisPayload).trim().slice(0, 5000);
  if (!synthesis) throw new Error('The Evidence Moderator returned no synthesis.');
  io.report(input.taskId, 'agent_message', { agent: 'Evidence Moderator', role: 'Evidence synthesis', phase: 'consensus and dissent', message: synthesis });
  io.report(input.taskId, 'agent_status', { agent: 'Evidence Moderator', role: 'Evidence synthesis', status: 'ready', detail: 'Specialist evidence reconciled; disagreements preserved.' });

  const sources = [...new Map(notes.flatMap(note => note.sources).map(source => [source.url, source])).values()];
  const result = [
    ...notes.map(note => `## ${note.agent} — ${note.lens}\n${note.text}`),
    `## Evidence Moderator — consensus and dissent\n${synthesis}`,
  ].join('\n\n');
  io.report(input.taskId, 'agent_status', { agent: 'Decision controller', role: 'Mixture-of-experts controller', status: 'complete', detail: `${notes.length} specialists and one moderator returned; ${sources.length} unique sources.` });
  return { result, sources, agentNotes: notes, discussion: [{ agent: 'Evidence Moderator', message: synthesis }], toolCalls: notes.length + 1 };
}
