import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendEntries, readEntries, computeStats } from '../src/journal.js';

const CATEGORIES = ['analysis', 'security-audit', 'testing', 'bugfix', 'feature', 'refactor', 'test-writing', 'docs'];
const base = {
  task: 't1', category: 'security-audit', kind: 'claude', model: 'opus',
  proposed: 4, approved: 3, rejected: 1, testsPassed: true, reviewPassed: true, fixRounds: 0, stuck: false,
};

function memlog() {
  let text = '';
  return {
    appendFile: (_p, data) => { text += data; },
    readFile: () => text,
    get text() { return text; },
    set text(v) { text = v; },
  };
}

test('appends one json line per entry with timestamp', () => {
  const log = memlog();
  const n = appendEntries([base, { ...base, task: 't2' }], { path: '/j', appendFile: log.appendFile, categories: CATEGORIES, now: Date.parse('2026-11-07T10:00:00Z') });
  assert.equal(n, 2);
  const lines = log.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].at, '2026-11-07T10:00:00.000Z');
  assert.equal(lines[1].task, 't2');
});

test('rejects entry with unknown category', () => {
  const log = memlog();
  assert.throws(
    () => appendEntries([{ ...base, category: 'vibes' }], { path: '/j', appendFile: log.appendFile, categories: CATEGORIES }),
    (err) => err.code === 'INVALID_ENTRY' && /category/.test(err.message),
  );
});

test('batch is all-or-nothing', () => {
  const log = memlog();
  assert.throws(() => appendEntries([base, { ...base, fixRounds: -1 }], { path: '/j', appendFile: log.appendFile, categories: CATEGORIES }));
  assert.equal(log.text, '');
});

test('stats per category and pair', () => {
  const entries = [
    base,
    { ...base, proposed: 2, approved: 2, rejected: 0, fixRounds: 1 },
    { ...base, proposed: 0, approved: 0, rejected: 0, reviewPassed: null, stuck: true },
    { ...base, kind: 'opencode', model: 'github-copilot/gpt-5.3-codex', proposed: 5, approved: 1, rejected: 4, reviewPassed: false },
  ];
  const stats = computeStats(entries);
  const rows = stats['security-audit'];
  assert.equal(rows.length, 2);
  const claude = rows.find((r) => r.kind === 'claude');
  assert.equal(claude.n, 3);
  assert.equal(claude.approvalRate, 5 / 6);
  assert.equal(claude.firstPassRate, 1 / 2);
  assert.equal(claude.stuckRate, 1 / 3);
  assert.equal(claude.trusted, false);
  assert.equal(rows[0].kind, 'claude');
});

test('trusted only from minSamples', () => {
  const entries = Array.from({ length: 5 }, () => base);
  assert.equal(computeStats(entries)['security-audit'][0].trusted, true);
  assert.equal(computeStats(entries.slice(0, 4))['security-audit'][0].trusted, false);
});

test('skips corrupted lines', () => {
  const log = memlog();
  log.text = `${JSON.stringify(base)}\nnot json\n\n${JSON.stringify({ ...base, task: 'x' })}\n`;
  assert.equal(readEntries({ path: '/j', readFile: log.readFile }).length, 2);
});

test('missing journal reads as empty', () => {
  const readFile = () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; };
  assert.deepEqual(readEntries({ path: '/j', readFile }), []);
});
