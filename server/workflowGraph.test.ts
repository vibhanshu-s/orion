import test from 'node:test';
import assert from 'node:assert/strict';
import { Command, MemorySaver } from '@langchain/langgraph';
import { createWorkflowGraph, type WorkflowContext, type WorkflowHandlers } from './workflowGraph.js';

const plan = [
  { objective: 'Gather evidence', suggestedTool: 'web_search', expectedResult: 'Two specialist memos' },
  { objective: 'Save report', suggestedTool: 'files', expectedResult: 'A Markdown file' },
];

function handlersFor(overrides: Partial<WorkflowHandlers> = {}, calls: string[] = []): WorkflowHandlers {
  const add = (name: string) => async () => { calls.push(name); return {}; };
  return {
    analyze: async () => { calls.push('analyze'); return { TASK_ANALYSIS: { goal: 'A test goal', constraints: [], requiredInformation: [], expectedOutput: 'A result' } }; },
    requestClarification: async () => { calls.push('requestClarification'); return {}; },
    resolveClarification: async context => { calls.push('resolveClarification'); return { answerApplied: context.clarificationAnswer }; },
    retrieveMemory: add('retrieveMemory'),
    plan: async () => { calls.push('plan'); return { WORKFLOW_PLAN: plan, stepIndex: 0 }; },
    decide: add('decide'),
    execute: add('execute'),
    observe: async context => { calls.push('observe'); return { stepIndex: (context.stepIndex ?? 0) + 1 }; },
    evaluate: async () => { calls.push('evaluate'); return { score: 100, gaps: [], evaluationPass: 1 }; },
    improve: add('improve'),
    finalize: async () => { calls.push('finalize'); return { completed: true }; },
    ...overrides,
  };
}

function initialContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return { taskId: 'graph-test', goal: 'A test goal', graphRunId: 'graph-test-run', ...overrides };
}

test('LangGraph runs plan, act, observe, and evaluate nodes in sequence', async () => {
  const calls: string[] = [];
  const graph = createWorkflowGraph(handlersFor({}, calls), new MemorySaver());
  const result = await graph.invoke({ context: initialContext() }, { configurable: { thread_id: 'sequence-test' }, recursionLimit: 40 });

  assert.deepEqual(calls, ['analyze', 'retrieveMemory', 'plan', 'decide', 'execute', 'observe', 'decide', 'execute', 'observe', 'evaluate', 'finalize']);
  assert.equal(result.context.completed, true);
});

test('LangGraph pauses at clarification and resumes the same analyzed workflow', async () => {
  const calls: string[] = [];
  const handlers = handlersFor({
    analyze: async () => { calls.push('analyze'); return { TASK_ANALYSIS: { goal: 'Choose a region', constraints: [], requiredInformation: ['region'], expectedOutput: 'A regional report' }, clarification: 'Which region should I focus on?' }; },
  }, calls);
  const graph = createWorkflowGraph(handlers, new MemorySaver());
  const config = { configurable: { thread_id: 'clarification-test' }, recursionLimit: 40 };
  const paused: any = await graph.invoke({ context: initialContext() }, config);

  assert.equal(paused.__interrupt__?.[0]?.value?.question, 'Which region should I focus on?');
  assert.deepEqual(calls, ['analyze', 'requestClarification']);

  const resumed = await graph.invoke(new Command({ resume: 'Europe' }), config);
  assert.equal(resumed.context.answerApplied, 'Europe');
  assert.deepEqual(calls.slice(0, 3), ['analyze', 'requestClarification', 'resolveClarification']);
  assert.equal(calls.includes('finalize'), true);
});

test('LangGraph loops through bounded improvement when evaluation reports a gap', async () => {
  const calls: string[] = [];
  let evaluations = 0;
  const handlers = handlersFor({
    plan: async () => { calls.push('plan'); return { WORKFLOW_PLAN: plan.slice(0, 1), stepIndex: 0 }; },
    evaluate: async () => { calls.push('evaluate'); evaluations += 1; return { score: evaluations === 1 ? 60 : 90, gaps: evaluations === 1 ? ['Add one missing source'] : [], evaluationPass: evaluations }; },
    improve: async () => { calls.push('improve'); return { improvement_passes: 1 }; },
  }, calls);
  const graph = createWorkflowGraph(handlers, new MemorySaver());
  await graph.invoke({ context: initialContext() }, { configurable: { thread_id: 'improvement-test' }, recursionLimit: 40 });

  assert.equal(evaluations, 2);
  assert.equal(calls.filter(call => call === 'improve').length, 1);
  assert.equal(calls.at(-1), 'finalize');
});
