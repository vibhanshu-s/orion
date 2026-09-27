import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResearchAdapters } from './research.js';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-research-test-'));
process.env.ORION_DATA_DIR = testDataDir;
process.env.RESEARCH_MODE = 'grounded'; // Explicit provider fixtures, never live calls.
const { env } = await import('./gemini.js');
const { researchCouncil } = await import('./research.js');
after(async () => {
  const { db } = await import('./db.js');
  db.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

const directives = [
  { name: 'Evidence Analyst' as const, directive: 'Find a source that directly supports the central claim.' },
  { name: 'Skeptic' as const, directive: 'Find limitations and conflicting evidence for the same claim.' },
];
const payload = (text: string, sourced = false) => ({
  candidates: [{
    content: { parts: [{ text }] },
    ...(sourced ? { groundingMetadata: { groundingChunks: [{ web: { title: 'Example source', uri: 'https://example.org/evidence' } }] } } : {}),
  }],
});
const input = { taskId: 'fixture-task', analysis: { goal: 'Test evidence' }, step: 'Find evidence', memories: [], directives };

test('quota exhaustion stops before another specialist or moderator is called', async () => {
  let calls = 0;
  await assert.rejects(researchCouncil(input, {
    report: () => {}, wait: async () => {},
    generate: async () => { calls++; throw new Error('Gemini API 429: quota exceeded'); },
  }), /remaining specialists were not called/);
  assert.equal(calls, 1);
});

test('specialists execute sequentially and moderator retries without repeating research', async () => {
  let active = 0;
  let researchCalls = 0;
  let synthesisCalls = 0;
  await researchCouncil(input, {
    report: () => {}, wait: async () => {},
    generate: async (_contents, options) => {
      assert.equal(active++, 0);
      await Promise.resolve();
      active--;
      if (options?.tool) { researchCalls++; return payload('Supported evidence', true); }
      if (++synthesisCalls === 1) throw new Error('503 temporarily unavailable');
      return payload('Qualified synthesis');
    },
  });
  assert.equal(researchCalls, 2);
  assert.equal(synthesisCalls, 2);
});

test('specialists retry transient provider errors and return moderated, sourced evidence', async () => {
  const events: Array<{ type: string; data: any }> = [];
  const waits: number[] = [];
  let firstSpecialistAttempts = 0;
  const io: ResearchAdapters = {
    report: (_taskId, type, data) => { events.push({ type, data }); },
    wait: async milliseconds => { waits.push(milliseconds); },
    generate: async (contents, options) => {
      if (options?.tool === 'google_search') {
        const prompt = String(contents);
        if (prompt.includes('Evidence Analyst') && firstSpecialistAttempts++ === 0) throw new Error('Gemini API 503: high demand');
        return payload(`${prompt.includes('Evidence Analyst') ? 'Evidence memo' : 'Counter-evidence memo'} supports a qualified finding.`, true);
      }
      return payload('The sources agree on the main point, while one limitation remains.');
    },
  };
  const result = await researchCouncil(input, io);

  assert.equal(firstSpecialistAttempts, 2);
  assert.ok(waits.reduce((sum, ms) => sum + ms, 0) >= 10000);
  assert.equal(result.agentNotes.length, 2);
  assert.equal(result.sources.length, 1);
  assert.match(result.result, /Evidence Moderator — consensus and dissent/);
  assert.ok(events.some(event => event.data.role === 'Research specialist'));
  assert.ok(events.some(event => event.data.agent === 'Decision controller' && event.data.status === 'complete'));
});

test('failed specialists expose actionable provider diagnostics without leaking credentials', async () => {
  const events: Array<{ type: string; data: any }> = [];
  const secret = env.GEMINI_API_KEY ?? 'fixture-secret';
  const io: ResearchAdapters = {
    report: (_taskId, type, data) => { events.push({ type, data }); },
    wait: async () => {},
    generate: async () => { throw new Error(`Gemini API 403: Search grounding access denied ${secret}`); },
  };

  await assert.rejects(researchCouncil(input, io), error => {
    assert.match((error as Error).message, /Only 0 of 2 research specialists/);
    assert.match((error as Error).message, /Search grounding access denied/);
    assert.match((error as Error).message, /Check that this API project and key have access/);
    assert.doesNotMatch((error as Error).message, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
  const failures = events.filter(event => event.type === 'agent_status' && event.data.status === 'failed');
  assert.equal(failures.length, 2);
  assert.ok(failures.every(event => event.data.role === 'Research specialist' && /403/.test(event.data.detail)));
});
