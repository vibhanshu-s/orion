import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRetry } from './providerRetry.js';
import { createProviderQueue } from './providerQueue.js';

test('503 retries are bounded with exponential backoff', async () => {
  let calls = 0;
  let waited = 0;
  await assert.rejects(providerRetry(async () => { calls++; throw new Error('Gemini API 503: high demand'); }, {
    random: () => 0, wait: async ms => { waited += ms; },
  }), /503/);
  assert.equal(calls, 3);
  assert.equal(waited, 30000);
});
test('quota errors stop without consuming more requests', async () => {
  let calls = 0;
  await assert.rejects(providerRetry(async () => { calls++; throw new Error('Gemini API 429: quota exceeded'); }), /429/);
  assert.equal(calls, 1);
});
test('cancellation interrupts provider backoff before another request', async () => {
  let cancelled = false;
  let calls = 0;
  await assert.rejects(providerRetry(async () => { calls++; throw new Error('503'); }, {
    check: () => { if (cancelled) throw new Error('cancelled'); },
    wait: async () => { cancelled = true; },
  }), /cancelled/);
  assert.equal(calls, 1);
});
test('shared queue serializes callers, spaces starts and recovers after failures', async () => {
  let now = 100;
  const starts: number[] = [];
  let active = 0;
  const queue = createProviderQueue(15000, () => now, async ms => { now += ms; });
  const work = (fail = false) => queue(async () => {
    assert.equal(active++, 0);
    starts.push(now);
    await Promise.resolve();
    active--;
    if (fail) throw new Error('fixture');
  });
  await Promise.allSettled([work(), work(true), work()]);
  assert.deepEqual(starts, [100, 15100, 30100]);
});
