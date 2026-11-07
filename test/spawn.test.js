import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseSpec, spawnWorkers } from '../src/spawn.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const paths = { runs: path.resolve('/s/runs'), worktrees: path.resolve('/s/worktrees') };
const repo = path.resolve('/code/shop');

function fakes({ live = [], dirty = false, notReady = [], existingRun = null } = {}) {
  const log = [];
  let pane = 1;
  const files = {};
  if (existingRun) files[path.join(paths.runs, `${existingRun.task}.json`)] = JSON.stringify(existingRun);
  const herdr = {
    agentList: async () => live.map((name) => ({ name })),
    paneSplit: async (o) => { log.push(['split', o]); return `w1:p${++pane}`; },
    tabCreate: async (o) => { log.push(['tab', o]); return { tabId: 'w1:t2', paneId: `w1:p${++pane}` }; },
    paneClose: async (id) => { log.push(['close', id]); },
    agentStart: async (o) => {
      log.push(['start', o]);
      return notReady.includes(o.name) ? { ok: false, code: 'agent_not_ready', message: 'trust prompt' } : { ok: true };
    },
  };
  const git = {
    head: async () => 'abc123',
    commonDir: async () => path.join(repo, '.git'),
    isDirty: async () => dirty,
    addWorktree: async (r, wt, branch, base) => { log.push(['worktree', { wt, branch, base }]); },
    removeWorktree: async (r, wt) => { log.push(['rmworktree', wt]); },
    deleteBranch: async (r, b) => { log.push(['rmbranch', b]); },
  };
  const io = {
    writeFile: (f, d) => { files[f] = d; },
    readFile: (f) => {
      if (!(f in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[f];
    },
    mkdir: () => {},
    appendFile: (f, d) => { files[f] = (files[f] ?? '') + d; },
  };
  return { herdr, git, io, log, files };
}

const call = (f, over = {}) => spawnWorkers({
  herdr: f.herdr, git: f.git, paths, config: DEFAULT_CONFIG, repo, task: 'fix-login', pane: 'w1:p1', ...f.io, ...over,
});

test('parseSpec keeps colon in model', () => {
  assert.deepEqual(parseSpec('w1=opencode:ollama/qwen2.5-coder:7b'), { name: 'w1', kind: 'opencode', model: 'ollama/qwen2.5-coder:7b' });
  assert.deepEqual(parseSpec('claude1=claude'), { name: 'claude1', kind: 'claude', model: null });
  assert.throws(() => parseSpec('Bad=claude'), (e) => e.code === 'BAD_SPEC');
});

test('rejects unknown kind before creating anything', async () => {
  const f = fakes();
  await assert.rejects(call(f, { specs: ['w1=claude', 'w2=notreal'] }), (e) => e.code === 'UNKNOWN_KIND');
  assert.equal(f.log.length, 0);
});

test('rejects name of a live agent', async () => {
  const f = fakes({ live: ['w1'] });
  await assert.rejects(call(f, { specs: ['w1=claude'] }), (e) => e.code === 'NAME_TAKEN');
});

test('rejects too many workers and bad task', async () => {
  const f = fakes();
  const seven = Array.from({ length: 7 }, (_, i) => `w${i}=claude`);
  await assert.rejects(call(f, { specs: seven }), (e) => e.code === 'TOO_MANY');
  await assert.rejects(call(f, { specs: ['w1=claude'], task: 'Fix Login' }), (e) => e.code === 'BAD_TASK');
});

test('three workers: splits and cwd per worktree', async () => {
  const f = fakes();
  const { workers } = await call(f, { specs: ['w1=claude', 'w2=agy', 'w3=pi'] });
  const splits = f.log.filter(([k]) => k === 'split').map(([, o]) => o);
  assert.deepEqual(splits.map((s) => [s.direction, Number(s.ratio.toFixed(4))]), [['right', 0.5], ['down', 0.3333], ['down', 0.5]]);
  assert.deepEqual(splits.map((s) => s.cwd), workers.map((w) => w.worktree));
  assert.equal(splits[0].pane, 'w1:p1');
  const root = workers[0].worktree.slice(0, -'w1'.length);
  assert.ok(root.startsWith(paths.worktrees));
  assert.deepEqual(workers.map((w) => w.branch), ['foreman-work/fix-login/w1', 'foreman-work/fix-login/w2', 'foreman-work/fix-login/w3']);
  assert.deepEqual(workers.map((w) => w.status), ['ready', 'ready', 'ready']);
});

test('five workers use two columns', async () => {
  const f = fakes();
  await call(f, { specs: ['a=claude', 'b=claude', 'c=claude', 'd=claude', 'e=claude'] });
  const splits = f.log.filter(([k]) => k === 'split').map(([, o]) => [o.direction, Number(o.ratio.toFixed(4))]);
  assert.deepEqual(splits, [['right', 0.3333], ['right', 0.5], ['down', 0.3333], ['down', 0.5], ['down', 0.5]]);
});

test('new tab puts workers in a fresh tab', async () => {
  const f = fakes();
  const { workers } = await call(f, { specs: ['w1=claude'], newTab: true });
  const tab = f.log.find(([k]) => k === 'tab')[1];
  assert.equal(tab.cwd, workers[0].worktree);
  assert.equal(f.log.filter(([k]) => k === 'split').length, 0);
});

test('passes model args to agent start', async () => {
  const f = fakes();
  await call(f, { specs: ['w1=opencode:github-copilot/gpt-5.3-codex'] });
  const start = f.log.find(([k]) => k === 'start')[1];
  assert.deepEqual(start.args, ['--model', 'github-copilot/gpt-5.3-codex']);
  assert.equal(start.timeoutMs, DEFAULT_CONFIG.startTimeoutMs);
});

test('model for a kind without probe is dropped with a warning', async () => {
  const f = fakes();
  const { warnings } = await call(f, { specs: ['w1=kimi:k3'] });
  assert.deepEqual(f.log.find(([k]) => k === 'start')[1].args, []);
  assert.ok(warnings.some((w) => /kimi/.test(w)));
});

test('not_ready worker does not stop others', async () => {
  const f = fakes({ notReady: ['w1'] });
  const { workers } = await call(f, { specs: ['w1=claude', 'w2=agy'] });
  assert.equal(workers[0].status, 'not_ready');
  assert.match(workers[0].error, /agent_not_ready: trust prompt/);
  assert.equal(workers[1].status, 'ready');
});

test('warns on dirty repo', async () => {
  const f = fakes({ dirty: true });
  const { warnings } = await call(f, { specs: ['w1=claude'] });
  assert.ok(warnings.some((w) => /uncommitted changes/.test(w)));
});

test('saves run record with base sha', async () => {
  const f = fakes();
  await call(f, { specs: ['w1=claude'] });
  const saved = JSON.parse(f.files[path.join(paths.runs, 'fix-login.json')]);
  assert.equal(saved.base, 'abc123');
  assert.equal(saved.repo, repo);
  assert.equal(saved.workers[0].paneId, 'w1:p2');
  assert.equal(saved.workers[0].reportDir, path.join(saved.workers[0].worktree, '.foreman'));
});

test('reports live in the worktree and are excluded from git once', async () => {
  const f = fakes();
  const exclude = path.join(repo, '.git', 'info', 'exclude');
  f.files[exclude] = 'node_modules/\n';
  await call(f, { specs: ['w1=claude', 'w2=agy'] });
  assert.equal(f.files[exclude], 'node_modules/\n.foreman/\n');
  await call(f, { specs: ['w3=claude'] });
  assert.equal(f.files[exclude], 'node_modules/\n.foreman/\n');
});

test('adding workers to an existing run keeps its base', async () => {
  const existingRun = { task: 'fix-login', repo, base: 'old999', createdAt: 'x', workers: [{ name: 'w1', kind: 'claude' }] };
  const f = fakes({ existingRun });
  await assert.rejects(call(f, { specs: ['w1=agy'] }), (e) => e.code === 'NAME_TAKEN');
  await call(f, { specs: ['w2=agy'] });
  const saved = JSON.parse(f.files[path.join(paths.runs, 'fix-login.json')]);
  assert.equal(saved.base, 'old999');
  assert.deepEqual(saved.workers.map((w) => w.name), ['w1', 'w2']);
  assert.equal(f.log.find(([k]) => k === 'worktree')[1].base, 'old999');
});

test('pane failure rolls back created worktrees', async () => {
  const f = fakes();
  f.herdr.paneSplit = async () => { throw Object.assign(new Error('no pane'), { code: 'pane_not_found' }); };
  await assert.rejects(call(f, { specs: ['w1=claude', 'w2=claude'] }), (e) => e.code === 'pane_not_found');
  assert.equal(f.log.filter(([k]) => k === 'rmworktree').length, 2);
  assert.equal(f.log.filter(([k]) => k === 'rmbranch').length, 2);
});

test('claude workers start lean by default; --full keeps everything', async () => {
  const f = fakes();
  await call(f, { specs: ['w1=claude:sonnet'] });
  const args = f.log.find(([k]) => k === 'start')[1].args;
  assert.deepEqual(args.slice(0, 2), ['--model', 'sonnet']);
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--disable-slash-commands'));
  const g = fakes();
  await call(g, { specs: ['w1=claude'], full: true });
  assert.deepEqual(g.log.find(([k]) => k === 'start')[1].args, []);
  const h = fakes();
  await call(h, { specs: ['w1=claude'], config: { ...DEFAULT_CONFIG, lean: false } });
  assert.deepEqual(h.log.find(([k]) => k === 'start')[1].args, []);
});

test('effort is passed where supported and warned about elsewhere', async () => {
  const f = fakes();
  const { warnings } = await call(f, { specs: ['w1=agy', 'w2=opencode'], effort: 'low' });
  const starts = f.log.filter(([k]) => k === 'start').map(([, o]) => [o.name, o.args]);
  assert.deepEqual(starts, [['w1', ['--effort', 'low']], ['w2', []]]);
  assert.ok(warnings.some((w) => /opencode/.test(w) && /effort/.test(w)));
});

test('rejects an unknown effort level before creating anything', async () => {
  const f = fakes();
  await assert.rejects(call(f, { specs: ['w1=claude'], effort: 'turbo' }), (e) => e.code === 'BAD_EFFORT');
  assert.equal(f.log.length, 0);
});
