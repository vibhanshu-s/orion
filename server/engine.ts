import { Command, MemorySaver } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { currentState, evaluatorResponse, finalOutput, qualityScore, taskAnalysis, workflowPlan, type TaskState, type WorkflowStep } from '../shared/contracts.js';
import { addVectorMemory, searchVectorMemory } from './vectorstore.js';
import { db, emit, getState, getTask, iso, updateTask } from './db.js';
import { chooseAction } from './decision.js';
import { env, gemini, textFrom } from './gemini.js';
import { assertPathContained, isPublicHttpsDestination, safeJoin } from './safety.js';
import { analysisPrompt, evaluationPrompt, finalOutputPrompt, planningPrompt, promptSafety, pythonExecutionPrompt } from './prompts.js';
import { researchCouncil } from './research.js';
import { createWorkflowGraph, type WorkflowContext, type WorkflowHandlers } from './workflowGraph.js';
import { requestedMarkdownFilename, unconfirmedRequestedFilenames } from './artifacts.js';
import { providerRetry } from './providerRetry.js';

class RunLimitError extends Error {}
const active = new Set<string>();
const cancelled = new Set<string>();
const startedAt = new Map<string, number>();
const totalBudget = 20;
const checkpointer = new MemorySaver();

const stateNames = (state: WorkflowContext) => ({
  TASK_ANALYSIS: state.TASK_ANALYSIS ?? null,
  WORKFLOW_PLAN: state.WORKFLOW_PLAN ?? [],
  CURRENT_STATE: state.CURRENT_STATE ?? null,
  QUALITY_SCORE: state.QUALITY_SCORE ?? null,
  completed_steps: state.completed_steps ?? [],
  remaining_steps: state.remaining_steps ?? [],
  knowledge: state.knowledge ?? [],
  errors: state.errors ?? [],
  tool_actions: state.tool_actions ?? 0,
  quality_score: state.score ?? null,
  improvement_passes: state.improvement_passes ?? 0,
  memory: state.memory ?? [],
  agent_discussion: state.agent_discussion ?? [],
  graphRunId: state.graphRunId,
  clarification: state.clarification ?? '',
  clarificationAnswer: state.clarificationAnswer ?? '',
});

function setStatus(taskId: string, status: TaskState, state: WorkflowContext) {
  updateTask(taskId, status, stateNames(state));
  emit(taskId, 'status', { status });
  emit(taskId, 'state', stateNames(state));
}

function persist(taskId: string, state: WorkflowContext) {
  updateTask(taskId, getTask(taskId)?.status ?? 'running', stateNames(state));
  emit(taskId, 'state', stateNames(state));
}

function checkDeadline(taskId: string) {
  if (cancelled.has(taskId)) throw new Error('Task cancelled by user.');
  if (Date.now() - (startedAt.get(taskId) ?? Date.now()) > 600_000) throw new RunLimitError('Ten minute execution limit reached.');
}

function timeCheck(taskId: string) {
  checkDeadline(taskId);
  if ((getState(taskId).tool_actions ?? 0) >= totalBudget) throw new RunLimitError('Tool action limit of 20 reached.');
}

async function geminiRetry<T>(operation: () => Promise<T>, taskId: string): Promise<T> {
  return providerRetry(operation, {
    check: () => checkDeadline(taskId),
    onRetry: (attempt, delayMs) => emit(taskId, 'retry', { attempt, delayMs, message: `Provider temporarily unavailable. Retry ${attempt}/2 in ${Math.ceil(delayMs / 1000)} seconds.` }),
  });
}

function jsonFrom<T>(payload: any, schema: { safeParse: (value: unknown) => any }, label: string): T {
  const text = textFrom(payload).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON.`); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error?.issues?.slice(0, 3).map((issue: any) => issue.message).join('; ');
    throw new Error(`${label} output did not match the required schema${issues ? `: ${issues}` : '.'}`);
  }
  return parsed.data as T;
}

export async function searchMemory(query: string, limit = 5) { return searchVectorMemory(query, limit); }
export async function addMemory(context: string, source: string) { return addVectorMemory(context, source); }

async function runTool(context: WorkflowContext, step: WorkflowStep, decision: any): Promise<WorkflowContext> {
  const name = decision.tool as string;
  const taskId = context.taskId;
  timeCheck(taskId);
  let result = '';
  let agentCount = 0;
  let sources: any[] = [];
  let code: any[] = [];
  const selectedContext = {
    TASK_ANALYSIS: context.TASK_ANALYSIS,
    step,
    memories: context.memory ?? [],
    history: (context.knowledge ?? []).slice(-5),
    attached_inputs: context.imports ?? [],
  };

  if (name === 'web_search') {
    const expertCalls = decision.subagents.length + 1;
    if ((getState(taskId).tool_actions ?? 0) > totalBudget - expertCalls) throw new RunLimitError(`The run lacks room for ${decision.subagents.length} selected experts and the evidence moderator.`);
    const research = await researchCouncil({ taskId, analysis: context.TASK_ANALYSIS, step: step.objective, memories: context.memory ?? [], directives: decision.subagents });
    result = research.result;
    sources = research.sources;
    agentCount = research.agentNotes.length;
    context = {
      ...context,
      agent_discussion: [...(context.agent_discussion ?? []), ...research.discussion.map((item: { agent: string; message: string }) => ({ ...item, at: iso() }))],
      tool_actions: (context.tool_actions ?? 0) + research.toolCalls,
    };
  } else if (name === 'python') {
    const payload = await geminiRetry(async () => gemini(await pythonExecutionPrompt({ analysis: context.TASK_ANALYSIS, step, context: selectedContext }), { tool: 'code_execution', system: promptSafety }), taskId);
    for (const part of payload.candidates?.[0]?.content?.parts ?? []) {
      if (part.executableCode) code.push({ code: part.executableCode.code, language: part.executableCode.language });
      if (part.codeExecutionResult) code.push({ output: part.codeExecutionResult.output, outcome: part.codeExecutionResult.outcome });
    }
    result = textFrom(payload);
    if (!code.some(item => item.code) || !code.some(item => item.output !== undefined)) throw new Error('Gemini returned no completed Python execution; no result was simulated.');
  } else if (name === 'memory_search') {
    const hits = await searchMemory(`${context.TASK_ANALYSIS?.goal ?? context.goal}\n${step.objective}`, 5);
    result = JSON.stringify(hits);
    context = { ...context, memory: [...(context.memory ?? []), ...hits] };
  } else if (name === 'files') {
    const findings = (context.knowledge ?? []).map((item: any) => `### ${item.step}\n\n${item.result}`).join('\n\n');
    const citations = (context.knowledge ?? []).flatMap((item: any) => item.sources ?? []);
    const sourceList = citations.length ? `\n\n## Sources\n\n${citations.map((source: any) => `- [${source.title}](${source.url})`).join('\n')}` : '';
    const body = `# ${context.TASK_ANALYSIS?.goal ?? context.goal}\n\n## ${step.objective}\n\n${decision.expected_output}\n\n${findings}${sourceList}\n`;
    const tasksRoot = path.resolve(process.cwd(), 'data', 'tasks');
    const directory = safeJoin(tasksRoot, taskId);
    await fs.mkdir(directory, { recursive: true });
    const requestedName = requestedMarkdownFilename(step.objective, step.expectedResult);
    const parsedName = path.parse(requestedName ?? `report-${Date.now()}.md`);
    let name = parsedName.base;
    let candidate = safeJoin(directory, name);
    let suffix = 2;
    while (await fs.stat(candidate).then(() => true, () => false)) {
      name = `${parsedName.name}-${suffix++}${parsedName.ext}`;
      candidate = safeJoin(directory, name);
    }
    const file = await assertPathContained(tasksRoot, candidate);
    await fs.writeFile(file, body, 'utf8');
    const artifactId = randomUUID();
    db.prepare('INSERT INTO artifacts(id,task_id,name,path,created_at) VALUES(?,?,?,?,?)').run(artifactId, taskId, path.basename(file), file, iso());
    result = `Created ${path.basename(file)}`;
    emit(taskId, 'artifact', { id: artifactId, name: path.basename(file) });
  } else if (name === 'api_get') {
    const operations = JSON.parse(process.env.ORION_READ_APIS ?? '{}');
    const operation = operations[decision.action] ?? operations[step.objective];
    if (!operation || typeof operation.url !== 'string') throw new Error('No administrator-configured API operation matches this step. Set ORION_READ_APIS in .env.');
    const url = new URL(operation.url);
    const addresses = await dns.lookup(url.hostname, { all: true }).then(records => records.map(record => record.address)).catch(() => []);
    if (!isPublicHttpsDestination(operation.url, addresses)) throw new Error('API must use HTTPS and resolve only to a public hostname.');
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = process.env[`ORION_API_TOKEN_${decision.action.replace(/\W/g, '_').toUpperCase()}`];
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.status >= 300 && response.status < 400) throw new Error('API redirects are blocked; configure the final HTTPS URL.');
    if (!response.ok) throw new Error(`Configured API returned ${response.status}.`);
    result = (await response.text()).slice(0, 20_000);
  } else {
    throw new Error(`Tool ${name} is not permitted.`);
  }

  if (name !== 'web_search') context = { ...context, tool_actions: (context.tool_actions ?? 0) + 1 };
  context = { ...context, knowledge: [...(context.knowledge ?? []), { step: step.objective, tool: name, result, sources, code, at: iso() }] };
  persist(taskId, context);
  if (name !== 'web_search') emit(taskId, 'tool_result', { tool: name, objective: step.objective, result: result.slice(0, 8000), sources, code });
  else emit(taskId, 'tool_result', { tool: name, objective: step.objective, result: `${agentCount} routed specialists searched independently; the Evidence Moderator reconciled their source-backed consensus and disagreements. See the role notes above.`, sources, agent_count: agentCount });
  return context;
}

const handlers: WorkflowHandlers = {
  async analyze(context) {
    const existing = taskAnalysis.safeParse(context.TASK_ANALYSIS);
    if (existing.success && context.clarificationAnswer) return { TASK_ANALYSIS: existing.data };
    setStatus(context.taskId, 'analyzing', context);
    emit(context.taskId, 'action_decision', { action: 'Understand the requested goal', reason: 'Extract constraints, required information, and desired output before planning actions.', tool: `Gemini analysis · ${env.GEMINI_MODEL}`, expected_output: 'Validated TASK_ANALYSIS' });
    const payload = await geminiRetry(async () => gemini(await analysisPrompt(context.goal), { system: promptSafety, schema: true }), context.taskId);
    const responseSchema = z.object({ TASK_ANALYSIS: taskAnalysis, clarification: z.string().max(1000).optional().default('') });
    const response = jsonFrom<{ TASK_ANALYSIS: z.infer<typeof taskAnalysis>; clarification: string }>(payload, responseSchema, 'Goal analysis');
    const analysis = taskAnalysis.parse(response.TASK_ANALYSIS);
    persist(context.taskId, { ...context, TASK_ANALYSIS: analysis, clarification: response.clarification.trim() });
    return { TASK_ANALYSIS: analysis, clarification: response.clarification.trim() };
  },
  async requestClarification(context) {
    setStatus(context.taskId, 'waiting_for_clarification', context);
    emit(context.taskId, 'clarification', { question: context.clarification });
    return {};
  },
  async resolveClarification(context) {
    const answer = String(context.clarificationAnswer ?? '').trim();
    if (!answer) throw new Error('A clarification answer is required to continue this workflow.');
    const analysis = taskAnalysis.parse({ ...context.TASK_ANALYSIS, constraints: [...new Set([...(context.TASK_ANALYSIS?.constraints ?? []), `User clarification: ${answer}`])] });
    setStatus(context.taskId, 'planning', { ...context, TASK_ANALYSIS: analysis, clarification: '', clarificationAnswer: answer });
    emit(context.taskId, 'action_decision', { action: 'Continue from the saved analysis', reason: 'Apply your clarification to the analyzed goal before retrieving context and planning.', tool: 'LangGraph resume', expected_output: 'Updated TASK_ANALYSIS' });
    return { TASK_ANALYSIS: analysis, clarification: '' };
  },
  async retrieveMemory(context) {
    setStatus(context.taskId, 'planning', context);
    emit(context.taskId, 'action_decision', { action: 'Retrieve relevant memory before planning', reason: 'Ground the plan in saved documents and prior successful workflows.', tool: 'memory_search', expected_output: 'Up to five related memory excerpts' });
    let memory: unknown[] = [];
    let errors = context.errors ?? [];
    try { memory = await searchMemory(context.TASK_ANALYSIS?.goal ?? context.goal, 5); }
    catch (error: any) { errors = [...errors, `Memory retrieval unavailable: ${error.message}`]; }
    persist(context.taskId, { ...context, memory, errors });
    return { memory, errors };
  },
  async plan(context) {
    setStatus(context.taskId, 'planning', context);
    const payload = await geminiRetry(async () => gemini(await planningPrompt(context.TASK_ANALYSIS, context.memory ?? [], context.clarificationAnswer), { system: promptSafety, schema: true }), context.taskId);
    const text = textFrom(payload).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let raw: any;
    try { raw = JSON.parse(text); } catch { throw new Error('Planner returned invalid JSON.'); }
    const checked = workflowPlan.safeParse({ TASK_ANALYSIS: context.TASK_ANALYSIS, WORKFLOW_PLAN: raw.WORKFLOW_PLAN });
    if (!checked.success) throw new Error('Planner output did not match the workflow schema.');
    let plan: WorkflowStep[] = checked.data.WORKFLOW_PLAN;
    const reportStep: WorkflowStep = { objective: 'Save a concise report with findings and sources', suggestedTool: 'files', expectedResult: 'A downloadable Markdown report' };
    if (!plan.some(step => step.suggestedTool === 'files')) plan = plan.length < 8 ? [...plan, reportStep] : [...plan.slice(0, 7), reportStep];
    const next = { ...context, TASK_ANALYSIS: checked.data.TASK_ANALYSIS, WORKFLOW_PLAN: plan, completed_steps: [], remaining_steps: plan.map(step => step.objective), stepIndex: 0 };
    setStatus(context.taskId, 'running', next);
    emit(context.taskId, 'plan', { TASK_ANALYSIS: next.TASK_ANALYSIS, WORKFLOW_PLAN: plan });
    return { WORKFLOW_PLAN: plan, completed_steps: [], remaining_steps: next.remaining_steps, stepIndex: 0 };
  },
  async decide(context) {
    timeCheck(context.taskId);
    const step = context.WORKFLOW_PLAN?.[context.stepIndex ?? 0];
    if (!step) throw new Error('The workflow graph reached a decision without a remaining plan step.');
    const apiNames = Object.keys(JSON.parse(process.env.ORION_READ_APIS ?? '{}'));
    let decision: any;
    try {
      decision = await geminiRetry(() => chooseAction({ analysis: context.TASK_ANALYSIS, plan: context.WORKFLOW_PLAN ?? [], step, evidence: (context.knowledge ?? []).slice(-5), apiNames }), context.taskId);
    } catch (error: any) {
      throw new Error(`The JSON decision controller was unavailable or returned invalid structured output: ${error.message}`);
    }
    if (step.suggestedTool === 'files') decision.tool = 'files';
    if (decision.tool === 'api_get' && !apiNames.length) decision.tool = step.suggestedTool === 'api_get' ? 'web_search' : step.suggestedTool;
    emit(context.taskId, 'decision', { provider: `JEV-style JSON controller · ${env.GEMINI_MODEL}`, route: decision.tool, confidence: decision.confidence, subagents: decision.subagents });
    emit(context.taskId, 'action_decision', decision);
    return { currentStep: step, currentDecision: decision };
  },
  async execute(context) {
    const step = context.currentStep as WorkflowStep | undefined;
    if (!step || !context.currentDecision) throw new Error('The executor did not receive a validated decision and plan step.');
    timeCheck(context.taskId);
    return runTool(context, step, context.currentDecision);
  },
  async observe(context) {
    const step = context.currentStep as WorkflowStep | undefined;
    if (!step) throw new Error('The observer did not receive the completed plan step.');
    const index = context.stepIndex ?? 0;
    const completed = [...(context.completed_steps ?? []), step.objective];
    const remaining = (context.WORKFLOW_PLAN ?? []).slice(index + 1).map(item => item.objective);
    const current = currentState.parse({ completed_steps: completed, remaining_steps: remaining, knowledge: context.knowledge ?? [], errors: context.errors ?? [] });
    const next = { ...context, completed_steps: completed, remaining_steps: remaining, stepIndex: index + 1, CURRENT_STATE: current };
    persist(context.taskId, next);
    return { completed_steps: completed, remaining_steps: remaining, stepIndex: index + 1, CURRENT_STATE: current };
  },
  async evaluate(context) {
    setStatus(context.taskId, 'evaluating', context);
    const response = await geminiRetry(async () => gemini(await evaluationPrompt({ analysis: context.TASK_ANALYSIS, plan: context.WORKFLOW_PLAN ?? [], evidence: context.knowledge ?? [], errors: context.errors ?? [] }), { system: promptSafety, schema: true }), context.taskId);
    const parsed = jsonFrom<z.infer<typeof evaluatorResponse>>(response, evaluatorResponse, 'Evaluator');
    const checks = { goal_coverage: parsed.goal_coverage, factual_support: parsed.factual_support, source_reliability: parsed.source_reliability, calculation_evidence: parsed.calculation_evidence, completeness: parsed.completeness };
    const score = Object.values(checks).reduce((sum, value) => sum + (value ? 20 : 0), 0);
    const quality = qualityScore.parse({ score, checks, gaps: parsed.gaps, estimate: true });
    const pass = (context.evaluationPass ?? 0) + 1;
    persist(context.taskId, { ...context, QUALITY_SCORE: quality, score, gaps: parsed.gaps, evaluationPass: pass });
    emit(context.taskId, 'evaluation', { score, estimate: true, checks, gaps: parsed.gaps, pass, QUALITY_SCORE: quality });
    return { QUALITY_SCORE: quality, score, gaps: parsed.gaps, evaluationPass: pass };
  },
  async improve(context) {
    const gaps = (context.gaps ?? []).slice(0, 2);
    if (!gaps.length) return {};
    const pass = (context.improvement_passes ?? 0) + 1;
    emit(context.taskId, 'improvement', { pass, gaps });
    let updated: WorkflowContext = { ...context, improvement_passes: pass };
    for (const gap of gaps) {
      timeCheck(context.taskId);
      const step: WorkflowStep = { objective: String(gap).slice(0, 400), suggestedTool: 'web_search', expectedResult: 'Evidence addressing the evaluator gap' };
      const decision = await geminiRetry(() => chooseAction({ analysis: updated.TASK_ANALYSIS, plan: updated.WORKFLOW_PLAN ?? [], step, evidence: (updated.knowledge ?? []).slice(-5), apiNames: [] }), context.taskId);
      updated = await runTool(updated, step, { ...decision, tool: 'web_search', action: step.objective, reason: 'Address an evaluator-identified evidence gap.', expected_output: step.expectedResult });
    }
    persist(context.taskId, updated);
    return { improvement_passes: pass, knowledge: updated.knowledge, agent_discussion: updated.agent_discussion, tool_actions: updated.tool_actions };
  },
  async finalize(context) {
    const limitations = [...(context.errors ?? [])];
    if ((context.score ?? 0) < 85) limitations.push(`Evaluator estimated ${context.score ?? 0}/100 after improvement; unresolved gaps remain.`);
    if ((context.tool_actions ?? 0) >= totalBudget) limitations.push('The run reached its 20 action limit.');
    const fileSteps = (context.WORKFLOW_PLAN ?? []).filter((step: WorkflowStep) => step.suggestedTool === 'files');
    const requestedNames = fileSteps.map((step: WorkflowStep) => requestedMarkdownFilename(step.objective, step.expectedResult)).filter((name: string | undefined): name is string => Boolean(name));
    const actualNames = (context.knowledge ?? []).filter((item: any) => item.tool === 'files').map((item: any) => /^Created\s+(.+)$/.exec(String(item.result))?.[1]).filter((name: string | undefined): name is string => Boolean(name));
    for (const requestedName of unconfirmedRequestedFilenames(requestedNames, actualNames)) limitations.push(`The plan requested ${requestedName}, but the Files tool did not confirm saving that exact name. Saved files: ${actualNames.join(', ') || 'none'}.`);
    const output = jsonFrom<z.infer<typeof finalOutput>>(
      await geminiRetry(async () => gemini(await finalOutputPrompt({ analysis: context.TASK_ANALYSIS, plan: context.WORKFLOW_PLAN ?? [], evidence: context.knowledge ?? [], evaluations: context.QUALITY_SCORE ? [context.QUALITY_SCORE] : [], limitations }), { system: promptSafety, schema: true }), context.taskId),
      finalOutput,
      'FINAL_OUTPUT'
    );
    let status: TaskState = limitations.length || (context.score ?? 0) < 85 ? 'partial' : 'completed';
    let memorySaved = false;
    if (status === 'completed') {
      try {
        await addMemory(JSON.stringify({ goal: context.TASK_ANALYSIS?.goal, summary: output.summary, important_results: output.important_results.slice(0, 8) }), `successful workflow ${context.taskId}`);
        memorySaved = true;
      } catch (error: any) {
        const message = `Could not save this workflow to memory: ${error.message}`;
        context = { ...context, errors: [...(context.errors ?? []), message] };
        output.limitations = [...output.limitations, message];
        status = 'partial';
      }
    }
    const savedState = { ...context, CURRENT_STATE: currentState.parse({ completed_steps: context.completed_steps ?? [], remaining_steps: context.remaining_steps ?? [], knowledge: context.knowledge ?? [], errors: context.errors ?? [] }), FINAL_OUTPUT: output, memory_saved: memorySaved };
    updateTask(context.taskId, status, stateNames(savedState), output);
    emit(context.taskId, 'final_output', output);
    emit(context.taskId, 'status', { status });
    return savedState;
  },
};

const graph = createWorkflowGraph(handlers, checkpointer);

function taskContext(taskId: string, saved: Record<string, any> = {}, graphRunId = randomUUID()): WorkflowContext {
  return {
    ...saved,
    taskId,
    goal: getTask(taskId)?.goal ?? '',
    graphRunId,
    completed_steps: saved.completed_steps ?? [],
    remaining_steps: saved.remaining_steps ?? [],
    knowledge: saved.knowledge ?? [],
    errors: saved.errors ?? [],
    tool_actions: saved.tool_actions ?? 0,
    memory: saved.memory ?? [],
    agent_discussion: saved.agent_discussion ?? [],
    stepIndex: saved.stepIndex ?? 0,
    improvement_passes: saved.improvement_passes ?? 0,
    evaluationPass: saved.evaluationPass ?? 0,
  };
}

async function run(taskId: string, options: { answer?: string; resume?: boolean; savedContext?: Record<string, any> } = {}) {
  if (active.has(taskId)) return;
  active.add(taskId);
  startedAt.set(taskId, Date.now());
  let context = taskContext(taskId, options.savedContext ?? getState(taskId));
  if (options.answer) context = { ...context, clarificationAnswer: options.answer };
  try {
    const config = { configurable: { thread_id: context.graphRunId }, recursionLimit: 100 };
    const input = options.resume ? new Command({ resume: options.answer }) : { context };
    const result: any = await graph.invoke(input as any, config);
    if (result.__interrupt__?.length) return;
  } catch (error: any) {
    const isCancelled = cancelled.has(taskId);
    const isPartial = error instanceof RunLimitError;
    const message = isCancelled ? 'Task cancelled by user.' : String(error?.message ?? 'Workflow failed.');
    context = taskContext(taskId, getState(taskId));
    context = { ...context, errors: [...(context.errors ?? []), message] };
    const current = currentState.parse({ completed_steps: context.completed_steps ?? [], remaining_steps: context.remaining_steps ?? [], knowledge: context.knowledge ?? [], errors: context.errors });
    const output = finalOutput.parse({
      summary: isCancelled ? 'Task cancelled; completed evidence was saved.' : isPartial ? 'Run limit reached; partial evidence was saved.' : 'Task could not complete; completed evidence was saved.',
      completed_actions: context.completed_steps ?? [],
      important_results: (context.knowledge ?? []).map((item: any) => item.result),
      limitations: [message],
      next_possible_actions: [isPartial ? 'Review the partial result or adjust the configured run limits.' : 'Review the saved task history and retry after resolving the issue.'],
    });
    const status: TaskState = isCancelled ? 'cancelled' : isPartial ? 'partial' : 'failed';
    context = { ...context, CURRENT_STATE: current, FINAL_OUTPUT: output };
    updateTask(taskId, status, stateNames(context), output, message);
    emit(taskId, isPartial ? 'limit' : 'error', { message });
    emit(taskId, 'final_output', output);
    emit(taskId, 'status', { status });
  } finally {
    active.delete(taskId);
    startedAt.delete(taskId);
    cancelled.delete(taskId);
  }
}

export function queueRun(taskId: string) { void run(taskId); }

export function answerClarification(taskId: string, answer: string) {
  const task = getTask(taskId);
  if (!task || task.status !== 'waiting_for_clarification' || active.has(taskId)) return false;
  const saved = getState(taskId);
  const graphRunId = typeof saved.graphRunId === 'string' ? saved.graphRunId : randomUUID();
  const config = { configurable: { thread_id: graphRunId } };
  void (async () => {
    let canResume = false;
    try {
      const snapshot = await graph.getState(config);
      canResume = snapshot.next?.includes('await_clarification') ?? false;
    } catch { canResume = false; }
    emit(taskId, 'clarification_answer', { received: true });
    if (canResume) {
      updateTask(taskId, 'queued', { ...stateNames(taskContext(taskId, saved, graphRunId)), clarificationAnswer: answer.trim() });
      emit(taskId, 'status', { status: 'queued' });
      await run(taskId, { answer: answer.trim(), resume: true, savedContext: saved });
    } else {
      const recovered = { ...saved, clarificationAnswer: answer.trim(), graphRunId };
      updateTask(taskId, 'queued', stateNames(taskContext(taskId, recovered, graphRunId)));
      emit(taskId, 'status', { status: 'queued' });
      await run(taskId, { answer: answer.trim(), savedContext: recovered });
    }
  })();
  return true;
}

export function cancel(taskId: string) {
  const task = getTask(taskId);
  if (task?.status === 'waiting_for_clarification' && !active.has(taskId)) {
    const message = 'Task cancelled by user.';
    updateTask(taskId, 'cancelled', getState(taskId), null, message);
    emit(taskId, 'status', { status: 'cancelled' });
    emit(taskId, 'error', { message });
    return;
  }
  cancelled.add(taskId);
}
