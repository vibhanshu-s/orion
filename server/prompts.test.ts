import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisPrompt, evaluationPrompt, expertSynthesisPrompt, finalOutputPrompt, planningPrompt, pythonExecutionPrompt, specialistPrompt } from './prompts.js';

const analysis = { goal: 'Compare river cleanup options', constraints: ['Use recent public evidence'], requiredInformation: ['cost'], expectedOutput: 'A sourced comparison' };

test('downstream prompts are grounded in validated analysis and do not create a plan during analysis', async () => {
  const first = await analysisPrompt('Compare river cleanup options');
  const planning = await planningPrompt(analysis, [{ context: 'A saved note', source: 'memo.md' }], 'Focus on Europe.');

  assert.match(first, /Do not create a workflow plan/);
  assert.match(planning, /VALIDATED TASK_ANALYSIS/);
  assert.match(planning, /Focus on Europe/);
  assert.match(planning, /A saved note/);
  assert.doesNotMatch(planning, /USER GOAL:\nCompare river cleanup options/);
});

test('executor, specialist, evaluator and finalizer receive analyzed goal context', async () => {
  const execution = await pythonExecutionPrompt({ analysis, step: { objective: 'Estimate totals' }, context: { values: [2, 3] } });
  const specialist = await specialistPrompt({ analysis, question: 'Compare methods', savedContext: [], directive: 'Find primary sources', agent: 'Evidence Analyst' });
  const evaluation = await evaluationPrompt({ analysis, plan: [], evidence: [], errors: [] });
  const final = await finalOutputPrompt({ analysis, plan: [], evidence: [], evaluations: [], limitations: [] });

  for (const prompt of [execution, specialist, evaluation, final]) {
    assert.match(prompt, /VALIDATED TASK_ANALYSIS/);
    assert.match(prompt, /Compare river cleanup options/);
  }
  assert.match(execution, /hosted Python cannot read local files/);
  assert.match(specialist, /YOUR SPECIALIST EXPERTISE/);
  assert.match(specialist, /authoritative, and preferably primary sources/);
});

test('specialist prompts use distinct lenses and the moderator preserves disagreement', async () => {
  const domain = await specialistPrompt({ analysis, question: 'Explain methods', savedContext: [], directive: 'Explain mechanism', agent: 'Domain Expert' });
  const skeptic = await specialistPrompt({ analysis, question: 'Check caveats', savedContext: [], directive: 'Seek conflicts', agent: 'Skeptic' });
  const synthesis = await expertSynthesisPrompt({
    analysis,
    question: 'Compare methods',
    experts: [
      { agent: 'Domain Expert', lens: 'Explain mechanism', text: 'Memo A', sources: [] },
      { agent: 'Skeptic', lens: 'Seek conflicts', text: 'Memo B', sources: [] },
    ],
  });
  assert.match(domain, /mechanisms, methods, and comparisons/);
  assert.match(skeptic, /counter-evidence, limitations, conflicting findings/);
  assert.match(synthesis, /Evidence Moderator/);
  assert.match(synthesis, /preserve meaningful disagreements/);
  assert.match(synthesis, /Memo A/);
  assert.match(synthesis, /Memo B/);
});
