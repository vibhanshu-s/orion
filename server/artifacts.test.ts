import assert from 'node:assert/strict';
import test from 'node:test';
import { requestedMarkdownFilename, unconfirmedRequestedFilenames } from './artifacts.js';

test('requested Markdown report names are preserved while paths are rejected', () => {
  assert.equal(requestedMarkdownFilename('Save a report to calculation-report.md.'), 'calculation-report.md');
  assert.equal(requestedMarkdownFilename('Write the result as `quarterly.summary.md`'), 'quarterly.summary.md');
  assert.equal(requestedMarkdownFilename('Save the report to ../../outside.md'), undefined);
  assert.equal(requestedMarkdownFilename('Save a report without a specific filename'), undefined);
});

test('finalization identifies requested artifact names that evidence did not confirm', () => {
  assert.deepEqual(unconfirmedRequestedFilenames(['calculation-report.md'], ['report-123.md']), ['calculation-report.md']);
  assert.deepEqual(unconfirmedRequestedFilenames(['calculation-report.md'], ['calculation-report.md']), []);
});
