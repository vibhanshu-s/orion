import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cosineSimilarity, isPublicAddress, isPublicHttpsDestination, normalizeVector, safeJoin } from './safety.js';
import { assertPathContained } from './safety.js';

test('API destination accepts public HTTPS addresses and rejects non-HTTPS or embedded credentials', () => {
  assert.equal(isPublicHttpsDestination('https://api.example.org/v1/data',['93.184.216.34']),true);
  assert.equal(isPublicHttpsDestination('http://api.example.org/v1/data',['93.184.216.34']),false);
  assert.equal(isPublicHttpsDestination('https://user:secret@api.example.org/v1/data',['93.184.216.34']),false);
});

test('API destination blocks private, loopback, link-local, reserved and mapped address ranges', () => {
  for(const address of ['127.0.0.1','10.0.0.1','172.20.0.10','192.168.1.2','169.254.10.8','100.64.0.1','198.18.0.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1']) {
    assert.equal(isPublicAddress(address),false,address);
  }
  assert.equal(isPublicHttpsDestination('https://public.example.org/',['93.184.216.34','10.0.0.4']),false);
  assert.equal(isPublicHttpsDestination('https://127.0.0.1/',['127.0.0.1']),false);
});

test('task artifacts stay inside their task directory', () => {
  const base='D:\\orion\\data\\tasks\\task-1';
  assert.equal(safeJoin(base,'report.md'),'D:\\orion\\data\\tasks\\task-1\\report.md');
  assert.throws(()=>safeJoin(base,'..\\..\\secret.txt'),/outside/);
});

test('artifact paths reject symlink escapes outside the allowed root', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-safety-'));
  const root = path.join(fixture, 'tasks');
  const outside = path.join(fixture, 'outside');
  const escape = path.join(root, 'escape');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  try {
    await fs.symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(assertPathContained(root, path.join(escape, 'report.md')), /symlink outside/);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('vectors normalize and cosine similarity ranks aligned evidence', () => {
  const a=normalizeVector([3,4]);
  assert.deepEqual(a,[0.6,0.8]);
  assert.equal(cosineSimilarity(a,a),1);
  assert.equal(cosineSimilarity(a,[-1,0]),-0.6);
  assert.equal(cosineSimilarity(a,[1]),0);
  assert.throws(()=>normalizeVector([0,0]),/empty or invalid/);
});
