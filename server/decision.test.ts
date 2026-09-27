import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDistinctExpertRoles } from './decision.js';

test('decision controller rejects duplicate roles before any specialist runs', () => {
  const decision = {
    action: 'Compare two approaches',
    reason: 'The topic has both technical and evidence questions.',
    tool: 'web_search' as const,
    expected_output: 'Source-backed comparison',
    confidence: 0.8,
    subagents: [
      { name: 'Domain Expert', directive: 'Explain the methods and relevant technical context.' },
      { name: 'Domain Expert', directive: 'Find a second description of the methods.' },
    ],
  };
  assert.throws(() => validateDistinctExpertRoles(decision), /assign each specialist role at most once/);
  const distinct = { ...decision, subagents: [decision.subagents[0], { ...decision.subagents[1], name: 'Skeptic' }] };
  assert.equal(validateDistinctExpertRoles(distinct).subagents.length, 2);
});
