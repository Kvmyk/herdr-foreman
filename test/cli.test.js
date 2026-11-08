import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main, route } from '../src/cli.js';

function harness(ops = {}, extra = {}) {
  let out = '';
  let err = '';
  const calls = [];
  const deps = {
    env: {},
    cwd: path.resolve('/code/shop'),
    paths: { runs: '/s/runs', journal: '/s/journal.jsonl', config: '/s/config.json', worktrees: '/s/wt', knowledgeCache: '/s/k', modelsDevCache: '/s/m', overrides: '/s/o' },
    readFile: (f) => {
      if (extra.files && f in extra.files) return extra.files[f];
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    appendFile: () => {},
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    ops: {
      start: async (o) => { calls.push(['start', o.task]); return { ok: true, message: 'started' }; },
      inventory: async () => [{ kind: 'claude', status: 'ready', version: '2', models: [{ id: 'opus', access: 'subscription' }], defaultModel: null, reason: null }],
      ...ops,
    },
    ...extra.deps,
  };
  return { deps, calls, out: () => out, err: () => err };
}

test('quoted task with spaces starts', async () => {
  const h = harness();
  assert.equal(await main(['dodaj logowanie przez Google'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'dodaj logowanie przez Google']]);
});

test('task starting with subcommand word starts', async () => {
  const h = harness();
  assert.equal(await main(['status', 'aplikacji', 'jest', 'zły'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'status aplikacji jest zły']]);
});

test('status with flags is a subcommand', async () => {
  const h = harness({ status: async (o) => { h.calls.push(['status', o.task]); return []; } });
  assert.equal(await main(['status', '--task', 'fix-login', '--json'], h.deps), 0);
  assert.deepEqual(h.calls, [['status', 'fix-login']]);
});

test('misspelled flag on a subcommand is a usage error', async () => {
  const h = harness();
  assert.equal(await main(['status', '--tsk', 'x'], h.deps), 2);
  assert.equal(h.calls.length, 0);
  assert.match(h.err(), /status/);
});

test('double dash forces start', async () => {
  const h = harness();
  assert.equal(await main(['--', 'agents', 'are', 'slow'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'agents are slow']]);
});

test('no args prints help and returns 2', async () => {
  const h = harness();
  assert.equal(await main([], h.deps), 2);
  assert.match(h.out(), /foreman "<task>"/);
});

test('agents --json prints inventory', async () => {
  const h = harness();
  assert.equal(await main(['agents', '--json'], h.deps), 0);
  assert.equal(JSON.parse(h.out())[0].kind, 'claude');
});

test('agents without --json prints a table', async () => {
  const h = harness();
  assert.equal(await main(['agents'], h.deps), 0);
  assert.match(h.out(), /claude\s+ready/);
});

test('journal add rejects invalid file with exit 2', async () => {
  const h = harness({}, { files: { '/tmp/j.json': JSON.stringify([{ task: 't', category: 'nope' }]) } });
  assert.equal(await main(['journal', 'add', '/tmp/j.json'], h.deps), 2);
  assert.match(h.err(), /invalid journal entry/);
});

test('failed start returns 1 with message', async () => {
  const h = harness({ start: async () => ({ ok: false, message: 'foreman needs a git repository' }) });
  assert.equal(await main(['fix it'], h.deps), 1);
  assert.match(h.err(), /git repository/);
});

test('cleanup without task lists leftovers', async () => {
  const h = harness({ leftovers: async () => [{ task: 'old-run', repo: '/r', worktrees: ['/w/a'], liveWorkers: ['w1'] }] });
  assert.equal(await main(['cleanup'], h.deps), 0);
  assert.match(h.out(), /old-run/);
  assert.match(h.out(), /foreman cleanup --all/);
});

test('cleanup --all cleans every leftover run', async () => {
  const h = harness({ cleanupAll: async (o) => { h.calls.push(['all', o.deleteBranch]); return [{ task: 'old-run', closedPanes: [], removedWorktrees: ['/w/a'], deletedBranches: [], errors: [] }]; } });
  assert.equal(await main(['cleanup', '--all'], h.deps), 0);
  assert.deepEqual(h.calls, [['all', false]]);
});

test('close-leader closes the calling pane', async () => {
  const h = harness({ closeLeader: async () => { h.calls.push(['close']); return { closed: 'w1:p9' }; } });
  assert.equal(await main(['close-leader'], h.deps), 0);
  assert.deepEqual(h.calls, [['close']]);
});

test('cleanup words still start a task', async () => {
  const h = harness();
  assert.equal(await main(['cleanup', 'the', 'old', 'code'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'cleanup the old code']]);
});

test('wait prints compact json', async () => {
  const h = harness({ wait: async (o) => { h.calls.push(['wait', o.task, o.phase, o.only, o.timeoutMs]); return { result: 'done', elapsedS: 3, workers: { w1: 'done' } }; } });
  assert.equal(await main(['wait', '--task', 't', '--phase', 'investigate', '--only', 'w1', '--timeout', '1000'], h.deps), 0);
  assert.deepEqual(h.calls, [['wait', 't', 'investigate', ['w1'], 1000]]);
  assert.equal(h.out(), '{"result":"done","elapsedS":3,"workers":{"w1":"done"}}\n');
});

test('wait rejects an unknown phase', async () => {
  const h = harness({ wait: async () => ({}) });
  assert.equal(await main(['wait', '--task', 't', '--phase', 'later'], h.deps), 2);
});

test('spawn passes effort and full', async () => {
  const h = harness({ spawn: async (o) => { h.calls.push(['spawn', o.effort, o.full, o.specs, o.auto]); return { workers: [], warnings: [] }; } });
  assert.equal(await main(['spawn', '--task', 't', '--effort', 'low', '--full', 'w1=claude', '--json'], h.deps), 0);
  assert.deepEqual(h.calls, [['spawn', 'low', true, ['w1=claude'], false]]);
});

test('spawn --auto is passed through', async () => {
  const h = harness({ spawn: async (o) => { h.calls.push(['spawn', o.auto, o.branch]); return { workers: [], warnings: [] }; } });
  assert.equal(await main(['spawn', '--task', 't', '--auto', '--branch', 'feat/x', 'w1=claude', '--json'], h.deps), 0);
  assert.deepEqual(h.calls, [['spawn', true, 'feat/x']]);
});

test('land passes --title', async () => {
  const h = harness({ land: async (o) => { h.calls.push(['land', o.task, o.title]); return { ok: true, branch: 'feat/x' }; } });
  assert.equal(await main(['land', '--task', 't', '--title', 'add x', '--json'], h.deps), 0);
  assert.equal(await main(['land', '--task', 't', '--json'], h.deps), 0);
  assert.deepEqual(h.calls, [['land', 't', 'add x'], ['land', 't', null]]);
});

test('spawn without --branch is a usage error when foreman says so', async () => {
  const h = harness({ spawn: async () => { throw Object.assign(new Error('needs --branch'), { code: 'BRANCH_REQUIRED' }); } });
  assert.equal(await main(['spawn', '--task', 't', 'w1=claude'], h.deps), 2);
});

test('-f reads the task from a file', async () => {
  const h = harness({}, { deps: { readFile: (f) => (f === 'task.md' ? 'line one\nline two\n' : '') } });
  assert.equal(await main(['-f', 'task.md'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'line one\nline two']]);
});

test('-f with a missing or empty file explains in plain words', async () => {
  const missing = harness({}, { deps: { readFile: () => { throw new Error('ENOENT'); } } });
  assert.equal(await main(['-f', 'x.md'], missing.deps), 2);
  assert.match(missing.err(), /could not read the file x\.md/);
  const empty = harness({}, { deps: { readFile: () => '  \n' } });
  assert.equal(await main(['--file', 'x.md'], empty.deps), 2);
  assert.match(empty.err(), /is empty/);
  assert.equal(route(['-f']).kind, 'usage');
});

test('a task piped in on stdin starts; a terminal still shows help', async () => {
  const piped = harness({}, { deps: { readStdin: async () => 'fix the thing\nplease\n' } });
  assert.equal(await main([], piped.deps), 0);
  assert.deepEqual(piped.calls, [['start', 'fix the thing\nplease']]);
  const tty = harness({}, { deps: { readStdin: async () => null } });
  assert.equal(await main([], tty.deps), 2);
});
