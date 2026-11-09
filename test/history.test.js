import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  updateRun, afterWait, afterMerge, afterLand, afterCleanup, summarizeRuns, describeRun, formatRuns, formatShow, isLive, taskFile, phaseOf,
} from '../src/history.js';
import { main } from '../src/cli.js';

const paths = { home: path.resolve('/s'), runs: path.resolve('/s/runs') };
const wt = (name) => path.resolve('/s/worktrees/shop-abc/fix-login', name);
const now = () => Date.parse('2026-11-09T10:00:00Z');

function run(over = {}) {
  return {
    task: 'fix-login',
    repo: path.resolve('/code/shop'),
    base: 'abc1234567',
    branch: 'fix/login',
    createdAt: '2026-11-09T09:00:00.000Z',
    workers: [
      { name: 'w1', kind: 'claude', model: 'opus', paneId: 'p2', worktree: wt('w1'), branch: 'wip/login/w1', reportDir: path.join(wt('w1'), '.foreman'), startedAt: '2026-11-09T09:00:00.000Z' },
      { name: 'w2', kind: 'codex', model: null, paneId: 'p3', worktree: wt('w2'), branch: 'wip/login/w2', reportDir: path.join(wt('w2'), '.foreman') },
    ],
    ...over,
  };
}

function store(initial) {
  const files = {};
  if (initial) files[path.join(paths.runs, `${initial.task}.json`)] = JSON.stringify(initial);
  return {
    files,
    paths,
    readFile: (f) => {
      if (!(f in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[f];
    },
    writeFile: (f, d) => { files[f] = d; },
    mkdir: () => {},
    now,
  };
}

test('updateRun saves the change with updatedAt and keeps the rest', () => {
  const s = store(run());
  const next = updateRun('fix-login', () => ({ phase: 'investigate' }), s);
  assert.equal(next.phase, 'investigate');
  assert.equal(next.updatedAt, '2026-11-09T10:00:00.000Z');
  const saved = JSON.parse(s.files[path.join(paths.runs, 'fix-login.json')]);
  assert.equal(saved.phase, 'investigate');
  assert.equal(saved.branch, 'fix/login');
});

test('updateRun never throws: missing run or failing write', () => {
  assert.equal(updateRun('nope', () => ({}), store()), null);
  const s = store(run());
  s.writeFile = () => { throw new Error('disk full'); };
  assert.equal(updateRun('fix-login', () => ({ phase: 'x' }), s), null);
});

test('afterWait sets the phase and stamps workers that are done', () => {
  const r = run();
  const change = afterWait(r, { phase: 'investigate', result: { result: 'attention', workers: { w1: 'done', w2: { state: 'blocked' } } }, now });
  assert.equal(change.phase, 'investigate');
  assert.equal(change.workers[0].endedAt, '2026-11-09T10:00:00.000Z');
  assert.equal(change.workers[0].endedPhase, 'investigate');
  assert.equal(change.workers[1].endedAt, undefined);
  // The same phase again keeps the first time; a new phase stamps again.
  const later = () => now() + 60000;
  const again = afterWait({ ...r, workers: change.workers }, { phase: 'investigate', result: { workers: { w1: 'done' } }, now: later });
  assert.equal(again.workers[0].endedAt, '2026-11-09T10:00:00.000Z');
  const impl = afterWait({ ...r, workers: change.workers }, { phase: 'implement', result: { workers: { w1: 'done' } }, now: later });
  assert.equal(impl.workers[0].endedAt, '2026-11-09T10:01:00.000Z');
});

test('merge, land and cleanup move the phase and set the outcome', () => {
  assert.deepEqual(afterMerge(run(), { result: { merged: [] }, now }), {});
  const merged = { ...run(), ...afterMerge(run({ merged: ['w2'] }), { result: { merged: ['w1', 'w2'] }, now }) };
  assert.equal(merged.phase, 'merged');
  assert.deepEqual(merged.merged, ['w2', 'w1']);
  assert.deepEqual(afterLand(merged, { result: { ok: false }, now }), {});
  const landed = { ...merged, ...afterLand(merged, { result: { ok: true }, now }) };
  assert.equal(landed.outcome, 'landed');
  assert.equal(afterCleanup(landed, { deleteBranch: true, now }).outcome, 'landed');
  assert.equal(afterCleanup(merged, { now }).outcome, 'branch-kept');
  assert.equal(afterCleanup(merged, { deleteBranch: true, now }).outcome, 'discarded');
  assert.equal(afterCleanup(run(), { now }).outcome, 'discarded');
  assert.equal(afterCleanup(run(), { now }).phase, 'cleaned');
});

test('old records without a phase read as spawned', () => {
  assert.equal(phaseOf(run()), 'spawned');
  assert.equal(phaseOf(run({ phase: 'merged' })), 'merged');
});

test('isLive needs the name and the worker pane or worktree', () => {
  const w = run().workers[0];
  assert.equal(isLive(w, [{ name: 'w1', pane_id: 'p2' }]), true);
  assert.equal(isLive(w, [{ name: 'w1', pane_id: 'p9' }]), false);
  assert.equal(isLive(w, [{ name: 'w1', cwd: path.join(wt('w1'), 'src') }]), true);
  assert.equal(isLive(w, [{ name: 'w1', cwd: path.resolve('/elsewhere') }]), false);
  assert.equal(isLive(w, [{ name: 'w2', pane_id: 'p2' }]), false);
});

test('summarizeRuns lists newest first with live workers and worktrees', () => {
  const older = run({ task: 'old', createdAt: '2026-11-01T00:00:00.000Z', phase: 'cleaned', outcome: 'landed' });
  const rows = summarizeRuns({ runs: [older, run({ phase: 'investigate' })], exists: (p) => p === wt('w1'), agents: [{ name: 'w1', pane_id: 'p2' }] });
  assert.deepEqual(rows.map((r) => r.task), ['fix-login', 'old']);
  assert.deepEqual(rows[0].liveWorkers, ['w1']);
  assert.equal(rows[0].worktrees, 1);
  assert.equal(rows[1].outcome, 'landed');
  const text = formatRuns(rows);
  assert.match(text, /fix-login\s+investigate/);
  assert.match(text, /cleaned \(landed\)/);
  assert.match(text, /1 live/);
  assert.equal(formatRuns([]), 'no foreman runs yet\n');
});

test('describeRun reads the task text and lists reports', () => {
  const s = store();
  s.files[taskFile(paths, 'fix-login')] = 'fix the login\nand its tests\n';
  const report = path.join(wt('w1'), '.foreman', 'proposals.md');
  const d = describeRun(run({ phase: 'merged', merged: ['w1'], mergedAt: '2026-11-09T09:30:00.000Z' }), { ...s, exists: (p) => p === report || p === wt('w2'), agents: [] });
  assert.equal(d.text, 'fix the login\nand its tests');
  assert.deepEqual(d.workers.map((w) => w.state), ['removed', 'stopped']);
  assert.deepEqual(d.workers[0].reports, [report]);
  const text = formatShow(d);
  assert.match(text, /asked\s+fix the login$/m);
  assert.match(text, /merged\s+w1/);
  assert.match(text, /w1\s+claude:opus/);
  assert.ok(text.includes(report));
});

test('foreman runs and show route to their ops; show of a task sentence starts a leader', async () => {
  let out = '';
  const calls = [];
  const deps = {
    env: {},
    paths,
    readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    stdout: { write: (x) => { out += x; } },
    stderr: { write: () => {} },
    ops: {
      runs: async () => { calls.push('runs'); return []; },
      show: async ({ task }) => { calls.push(`show ${task}`); return describeRun(run(), { paths, readFile: () => '', exists: () => false }); },
      start: async ({ task }) => { calls.push(`start ${task}`); return { ok: true }; },
    },
  };
  assert.equal(await main(['runs'], deps), 0);
  assert.match(out, /no foreman runs yet/);
  assert.equal(await main(['show', '--task', 'fix-login', '--json'], deps), 0);
  assert.equal(JSON.parse(out.split('\n').filter(Boolean).at(-1)).task, 'fix-login');
  assert.equal(await main(['show', 'me', 'the', 'login', 'bug'], deps), 0);
  assert.deepEqual(calls, ['runs', 'show fix-login', 'start show me the login bug']);
});
