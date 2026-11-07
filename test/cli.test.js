import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main, summarizeModels } from '../src/cli.js';

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

test('summarizeModels keeps default and subscription first and caps the list', () => {
  const models = [
    ...Array.from({ length: 50 }, (_, i) => ({ id: `openrouter/m${i}`, access: 'api' })),
    { id: 'github-copilot/gpt-5.3-codex', access: 'subscription' },
    { id: 'ollama/qwen', access: 'local' },
  ];
  const s = summarizeModels({ models, defaultModel: 'openrouter/m7' }, 10);
  assert.equal(s.models.length, 10);
  assert.deepEqual(s.models.slice(0, 3).map((m) => m.id), ['openrouter/m7', 'github-copilot/gpt-5.3-codex', 'ollama/qwen']);
  assert.equal(s.modelsTotal, 52);
  assert.equal(s.modelsOmitted, 42);
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
