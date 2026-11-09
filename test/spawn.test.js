import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseSpec, spawnWorkers } from '../src/spawn.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const paths = { runs: path.resolve('/s/runs'), worktrees: path.resolve('/s/worktrees') };
const repo = path.resolve('/code/shop');

function fakes({ takenBranches = [], live = [], dirty = false, notReady = [], existingRun = null } = {}) {
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
    createSnapshot: async (r, msg) => { log.push(['snapshot', msg]); return 'snap111'; },
    addWorktree: async (r, wt, branch, base) => { log.push(['worktree', { wt, branch, base }]); },
    validBranchName: async (r, n) => !n.includes('..') && !n.includes(' '),
    branchExists: async (r, b) => takenBranches.includes(b),
    worktreeConfigEnabled: async () => false,
    armPushGuard: async (wt) => { log.push(['guard', wt]); },
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
  herdr: f.herdr, git: f.git, paths, config: DEFAULT_CONFIG, repo, task: 'fix-login', pane: 'w1:p1', branch: 'feat/fix-login', ...f.io, ...over,
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

test('three workers: stacked right of the leader, cwd per worktree', async () => {
  const f = fakes();
  const { workers } = await call(f, { specs: ['w1=claude', 'w2=agy', 'w3=pi'] });
  const splits = f.log.filter(([k]) => k === 'split').map(([, o]) => o);
  assert.deepEqual(splits.map((s) => [s.direction, Number(s.ratio.toFixed(4))]), [['right', 0.4], ['down', 0.3333], ['down', 0.5]]);
  assert.deepEqual(splits.map((s) => s.cwd), workers.map((w) => w.worktree));
  assert.equal(splits[0].pane, 'w1:p1');
  const root = workers[0].worktree.slice(0, -'w1'.length);
  assert.ok(root.startsWith(paths.worktrees));
  assert.deepEqual(workers.map((w) => w.branch), ['wip/fix-login/w1', 'wip/fix-login/w2', 'wip/fix-login/w3']);
  assert.deepEqual(workers.map((w) => w.status), ['ready', 'ready', 'ready']);
});

test('grid layout keeps equal columns beside the leader', async () => {
  const f = fakes();
  await call(f, { specs: ['a=claude', 'b=claude', 'c=claude'], config: { ...DEFAULT_CONFIG, layout: 'grid' } });
  const splits = f.log.filter(([k]) => k === 'split').map(([, o]) => [o.direction, Number(o.ratio.toFixed(4))]);
  assert.deepEqual(splits, [['right', 0.5], ['down', 0.3333], ['down', 0.5]]);
});

test('grid layout: four workers go to a new tab', async () => {
  const f = fakes();
  const { warnings } = await call(f, { specs: ['a=claude', 'b=claude', 'c=claude', 'd=claude'], config: { ...DEFAULT_CONFIG, layout: 'grid' } });
  assert.equal(f.log.filter(([k]) => k === 'tab').length, 1);
  assert.ok(warnings.some((w) => /4 workers/.test(w) && /new tab/.test(w)));
});

test('new tab stacks up to four workers in one column', async () => {
  const f = fakes();
  await call(f, { specs: ['a=claude', 'b=claude', 'c=claude', 'd=claude'], newTab: true });
  const splits = f.log.filter(([k]) => k === 'split').map(([, o]) => [o.direction, Number(o.ratio.toFixed(4))]);
  assert.deepEqual(splits, [['down', 0.25], ['down', 0.3333], ['down', 0.5]]);
});

test('five workers use two stacked columns, in a new tab of their own', async () => {
  const f = fakes();
  const { warnings } = await call(f, { specs: ['a=claude', 'b=claude', 'c=claude', 'd=claude', 'e=claude'] });
  const splits = f.log.filter(([k]) => k === 'split').map(([, o]) => [o.direction, Number(o.ratio.toFixed(4))]);
  assert.deepEqual(splits, [['right', 0.5], ['down', 0.3333], ['down', 0.5], ['down', 0.5]]);
  assert.equal(f.log.filter(([k]) => k === 'tab').length, 1);
  assert.ok(warnings.some((w) => /5 workers/.test(w) && /new tab/.test(w)));
});

test('up to four workers stay beside the leader', async () => {
  const f = fakes();
  const { warnings } = await call(f, { specs: ['a=claude', 'b=claude', 'c=claude', 'd=claude'] });
  const splits = f.log.filter(([k]) => k === 'split').map(([, o]) => [o.direction, Number(o.ratio.toFixed(4))]);
  assert.deepEqual(splits, [['right', 0.4], ['down', 0.25], ['down', 0.3333], ['down', 0.5]]);
  assert.equal(f.log.filter(([k]) => k === 'tab').length, 0);
  assert.ok(!warnings.some((w) => /new tab/.test(w)));
});

test('more than four workers need no leader pane', async () => {
  const f = fakes();
  await call(f, { specs: ['a=claude', 'b=claude', 'c=claude', 'd=claude', 'e=claude'], pane: null });
  assert.equal(f.log.filter(([k]) => k === 'tab').length, 1);
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

test('--include-uncommitted snapshots the dirty repo and starts workers from it', async () => {
  const f = fakes({ dirty: true });
  const { warnings, snapshot } = await call(f, { specs: ['w1=claude'], includeUncommitted: true });
  assert.ok(f.log.some(([k]) => k === 'snapshot'));
  assert.equal(snapshot, 'snap111');
  assert.ok(!warnings.some((w) => /uncommitted changes/.test(w)));
  assert.equal(f.log.find(([k]) => k === 'worktree')[1].base, 'snap111');
  const saved = JSON.parse(f.files[path.join(paths.runs, 'fix-login.json')]);
  assert.equal(saved.base, 'snap111');
  assert.equal(saved.snapshot, 'snap111');
});

test('a clean repo with --include-uncommitted takes no snapshot', async () => {
  const f = fakes();
  const { snapshot } = await call(f, { specs: ['w1=claude'], includeUncommitted: true });
  assert.equal(snapshot, null);
  assert.ok(!f.log.some(([k]) => k === 'snapshot'));
  assert.equal(f.log.find(([k]) => k === 'worktree')[1].base, 'abc123');
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

test('the run record keeps history fields and stamps worker start times', async () => {
  const existingRun = { task: 'fix-login', repo, base: 'old999', branch: 'feat/fix-login', createdAt: 'x', phase: 'investigate', merged: ['w1'], workers: [{ name: 'w1', kind: 'claude', startedAt: 'old' }] };
  const f = fakes({ existingRun });
  await call(f, { specs: ['w2=agy'], branch: null });
  const saved = JSON.parse(f.files[path.join(paths.runs, 'fix-login.json')]);
  assert.equal(saved.phase, 'investigate');
  assert.deepEqual(saved.merged, ['w1']);
  assert.equal(saved.workers[0].startedAt, 'old');
  assert.match(saved.workers[1].startedAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(saved.updatedAt);
  const fresh = fakes();
  await call(fresh, { specs: ['w1=claude'] });
  assert.equal(JSON.parse(fresh.files[path.join(paths.runs, 'fix-login.json')]).phase, 'spawned');
});

test('an existing run keeps its snapshot base even when dirty again', async () => {
  const existingRun = { task: 'fix-login', repo, base: 'snap111', snapshot: 'snap111', createdAt: 'x', workers: [{ name: 'w1', kind: 'claude' }] };
  const f = fakes({ existingRun, dirty: true });
  const { warnings, snapshot } = await call(f, { specs: ['w2=claude'], includeUncommitted: true });
  assert.ok(!f.log.some(([k]) => k === 'snapshot'), 'only the first spawn snapshots');
  assert.equal(snapshot, 'snap111');
  assert.ok(warnings.some((w) => /uncommitted changes/.test(w)));
  assert.equal(f.log.find(([k]) => k === 'worktree')[1].base, 'snap111');
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
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--disable-slash-commands'));
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

test('every worktree gets a push guard, with or without --auto', async () => {
  const f = fakes();
  await call(f, { specs: ['w1=claude', 'w2=pi'] });
  assert.equal(f.log.filter(([k]) => k === 'guard').length, 2);
});

test('a failing push guard rolls back the worktree', async () => {
  const f = fakes();
  f.git.armPushGuard = async () => { throw new Error('config failed'); };
  await assert.rejects(call(f, { specs: ['w1=claude'] }), /config failed/);
  assert.ok(f.log.some(([k]) => k === 'rmworktree'));
  assert.ok(!f.log.some(([k]) => k === 'start'));
});

test('--auto passes each kind its auto-approve args and records auto', async () => {
  const f = fakes();
  const { warnings } = await call(f, { specs: ['c=claude', 'a=agy', 'o=opencode', 'p=pi', 'x=codex'], auto: true });
  const args = Object.fromEntries(f.log.filter(([k]) => k === 'start').map(([, o]) => [o.name, o.args]));
  assert.deepEqual(args.c.slice(0, 4), ['--permission-mode', 'auto', '--disallowedTools', 'Bash(git push:*),Bash(gh:*)']);
  assert.deepEqual(args.a, ['--dangerously-skip-permissions']);
  assert.deepEqual(args.o, ['--auto']);
  assert.deepEqual(args.p, []);
  assert.deepEqual(args.x, []);
  assert.ok(warnings.some((w) => /codex/.test(w) && /auto/.test(w)));
  assert.ok(!warnings.some((w) => /\bpi\b/.test(w)));
  assert.deepEqual(JSON.parse(f.files[path.join(paths.runs, 'fix-login.json')]).workers.map((w) => w.auto), [true, true, true, true, false]);
});

test('without --auto no auto args are passed', async () => {
  const f = fakes();
  await call(f, { specs: ['a=agy'] });
  assert.deepEqual(f.log.find(([k]) => k === 'start')[1].args, []);
});

test('agy gets no --effort together with --model, only a warning', async () => {
  const f = fakes();
  const { warnings } = await call(f, { specs: ['a=agy:claude-opus-4-6-thinking', 'b=agy'], effort: 'high' });
  const starts = f.log.filter(([k]) => k === 'start').map(([, o]) => [o.name, o.args]);
  assert.deepEqual(starts, [['a', ['--model', 'claude-opus-4-6-thinking']], ['b', ['--effort', 'high']]]);
  assert.ok(warnings.some((w) => /^a:/.test(w) && /effort/.test(w)));
});

test('--auto warns when the agent help does not mention its flag', async () => {
  const f = fakes();
  const asked = [];
  const run = async (cmd, a) => { asked.push([cmd, a]); return { code: 0, stdout: cmd === 'agy' ? '--dangerously-skip-permissions' : 'nothing', stderr: '' }; };
  const { warnings } = await call(f, { specs: ['a=agy', 'a2=agy', 'c=claude'], auto: true, run });
  assert.deepEqual(asked, [['agy', ['--help']], ['claude', ['--help']]]);
  assert.ok(warnings.some((w) => /claude --help/.test(w)));
  assert.ok(!warnings.some((w) => /agy --help/.test(w)));
});

test('first spawn needs a valid, unused --branch and records it', async () => {
  await assert.rejects(call(fakes(), { specs: ['w1=claude'], branch: null }), (e) => e.code === 'BRANCH_REQUIRED');
  for (const bad of ['fix-login', 'wibble/x', 'feat/Bad', 'feat/' + 'a'.repeat(41), 'feat/a/b', 'feat/x..y']) {
    await assert.rejects(call(fakes(), { specs: ['w1=claude'], branch: bad }), (e) => e.code === 'BAD_BRANCH', bad);
  }
  const f = fakes({ takenBranches: ['feat/fix-login'] });
  await assert.rejects(call(f, { specs: ['w1=claude'] }), (e) => e.code === 'BAD_BRANCH' && /exists/.test(e.message));
  assert.equal(f.log.length, 0);

  const ok = fakes();
  const { workers } = await call(ok, { specs: ['w1=claude'], branch: 'refactor/split-spawn' });
  assert.equal(workers[0].branch, 'wip/split-spawn/w1');
  const rec = JSON.parse(ok.files[path.join(paths.runs, 'fix-login.json')]);
  assert.equal(rec.branch, 'refactor/split-spawn');
});

test('later spawns reuse the recorded branch and reject a different one', async () => {
  const existingRun = { task: 'fix-login', repo, base: 'old999', branch: 'feat/fix-login', createdAt: 'x', workers: [{ name: 'w1', kind: 'claude' }] };
  const f = fakes({ existingRun });
  const { workers } = await call(f, { specs: ['w2=claude'], branch: null });
  assert.equal(workers[0].branch, 'wip/fix-login/w2');
  await call(fakes({ existingRun }), { specs: ['w2=claude'], branch: 'feat/fix-login' });
  await assert.rejects(call(fakes({ existingRun }), { specs: ['w2=claude'], branch: 'fix/other' }), (e) => e.code === 'BAD_BRANCH');
});

test('an old run record without branch keeps the old worker branch names', async () => {
  const existingRun = { task: 'fix-login', repo, base: 'old999', createdAt: 'x', workers: [{ name: 'w1', kind: 'claude' }] };
  const f = fakes({ existingRun });
  const { workers } = await call(f, { specs: ['w2=claude'], branch: null });
  assert.equal(workers[0].branch, 'foreman-work/fix-login/w2');
  assert.equal(JSON.parse(f.files[path.join(paths.runs, 'fix-login.json')]).branch, undefined);
});

// The Herdr app: workers are terminals in the leader's tab, laid out by the app.
function appHerdr(f, { labels = { space: 'spA', tab: 'tbA' } } = {}) {
  let t = 10;
  f.herdr = {
    kind: 'app',
    agentList: async () => [],
    here: async (pane) => { f.log.push(['here', pane]); return labels; },
    tabCreate: async (o) => { f.log.push(['tab', o]); return { workspaceId: o.workspaceId ?? 'spNew', tabId: 'tbNew', paneId: null }; },
    paneSplit: async () => { throw new Error('the app has no splits'); },
    agentStart: async (o) => { f.log.push(['start', o]); return { ok: true, pane: `t${++t}` }; },
  };
  return f;
}

test('in the Herdr app workers start in the leader\'s tab, each in its worktree', async () => {
  const f = appHerdr(fakes());
  const { workers } = await call(f, { specs: ['w1=claude', 'w2=agy'], pane: 't3' });
  assert.deepEqual(f.log.find(([k]) => k === 'here')[1], 't3');
  const starts = f.log.filter(([k]) => k === 'start').map(([, o]) => o);
  assert.deepEqual(starts.map((o) => [o.space, o.tab, o.cwd]), workers.map((w) => ['spA', 'tbA', w.worktree]));
  assert.deepEqual(workers.map((w) => w.paneId), ['t11', 't12']);
  assert.equal(f.log.some(([k]) => k === 'tab'), false);
  const saved = JSON.parse(f.files[path.join(paths.runs, 'fix-login.json')]);
  assert.equal(saved.backend, 'app');
  assert.deepEqual(saved.workers.map((w) => w.paneId), ['t11', 't12']);
  assert.equal('place' in workers[0], false);
});

test('in the Herdr app --new-tab puts workers in a fresh, named tab of the same space', async () => {
  const f = appHerdr(fakes());
  await call(f, { specs: ['w1=claude'], pane: 't3', newTab: true });
  assert.equal(f.log.find(([k]) => k === 'tab')[1].workspaceId, 'spA');
  const start = f.log.find(([k]) => k === 'start')[1];
  assert.deepEqual([start.space, start.tab, start.label], ['spA', 'tbNew', 'foreman:fix-login']);
});

test('a herdr run does not take workers spawned from the Herdr app', async () => {
  const existingRun = { task: 'fix-login', repo, base: 'abc123', branch: 'feat/fix-login', workers: [] };
  const f = appHerdr(fakes({ existingRun }));
  await assert.rejects(call(f, { specs: ['w1=claude'], pane: 't3' }), (e) => e.code === 'USAGE' && /herdr/.test(e.message));
});

test('a failed start carries the pane tail and an exited agent is flagged', async () => {
  const f = fakes();
  f.herdr.agentStart = async () => ({ ok: false, pane: 'w1:p9', code: 'agent_exited', message: 'codex exited (code 2)' });
  f.herdr.agentRead = async (t) => (t === 'w1' ? '' : 'error: unexpected argument --no-daemon');
  const { workers } = await call(f, { specs: ['w1=codex'] });
  assert.equal(workers[0].status, 'not_ready');
  assert.equal(workers[0].exited, true);
  assert.ok(workers[0].error.startsWith('agent_exited: codex exited (code 2)'));
  assert.match(workers[0].error, /unexpected argument --no-daemon/);
  assert.equal(workers[0].paneId, 'w1:p9');
});

test('a start failure of a crashed kind is recorded, and cleared after a good start', async () => {
  const f = fakes();
  const p = { ...paths, home: path.resolve('/s'), startFailures: path.resolve('/s/start-failures.json') };
  f.herdr.agentStart = async (o) => (o.kind === 'codex' ? { ok: false, code: 'agent_exited', message: 'codex exited (code 2)' } : { ok: true });
  await call(f, { paths: p, specs: ['w1=codex', 'w2=agy'] });
  assert.match(JSON.parse(f.files[p.startFailures]).codex.message, /exited/);
  f.herdr.agentStart = async () => ({ ok: true });
  await call(f, { paths: p, specs: ['w3=codex'] });
  assert.deepEqual(JSON.parse(f.files[p.startFailures]), {});
});

test('start flags are checked against the agent help even without --auto', async () => {
  const f = fakes();
  const run = async (cmd) => ({ code: 0, stdout: cmd === 'agy' ? '--model' : 'nothing', stderr: '' });
  const { warnings } = await call(f, { specs: ['a=agy:flash', 'c=claude'], run });
  assert.ok(warnings.some((w) => /claude --help/.test(w) && /--tools/.test(w)));
  assert.ok(!warnings.some((w) => /agy --help/.test(w)));
});

test('a known folder-trust dialog is answered in the worker worktree', async () => {
  const f = fakes();
  const keys = [];
  f.herdr.agentStart = async () => ({ ok: false, pane: 'w1:p9', code: 'agent_not_ready', message: 'claude is waiting for an answer' });
  f.herdr.agentRead = async () => 'Do you trust the files in this folder?\n ❯ No, exit\n   Yes, I trust this folder';
  f.herdr.agentKeys = async (name, k) => { keys.push([name, k]); };
  let listed = 0;
  f.herdr.agentList = async () => (listed++ ? [{ name: 'w1', agent_status: 'idle' }] : []);
  const { workers, warnings } = await call(f, { specs: ['w1=claude'], sleep: async () => {} });
  assert.deepEqual(keys, [['w1', ['down', 'enter']]]);
  assert.equal(workers[0].status, 'ready');
  assert.ok(warnings.some((w) => /trust/.test(w)));
});

test('an unknown kind blocked on a trust dialog is reported with the keys command', async () => {
  const f = fakes();
  f.herdr.agentStart = async () => ({ ok: false, pane: 'w1:p9', code: 'agent_not_ready', message: 'agy is waiting for an answer' });
  f.herdr.agentRead = async () => 'Do you trust this folder?\n > Yes, I trust this folder\n   No, exit';
  const { workers } = await call(f, { specs: ['w1=agy'], sleep: null });
  assert.equal(workers[0].status, 'not_ready');
  assert.match(workers[0].error, /foreman keys --task fix-login w1 enter/);
});

test('a trust dialog is answered while the agent is still starting', async () => {
  const f = fakes();
  const keys = [];
  let answered = false;
  f.herdr.agentRead = async () => 'Is this a project you trust?\n ❯ No, exit\n   Yes, I trust this folder';
  f.herdr.agentKeys = async (name, k) => { keys.push([name, k]); answered = true; };
  f.herdr.agentStart = async () => {
    for (let i = 0; i < 50 && !answered; i++) await new Promise((r) => setImmediate(r));
    return answered ? { ok: true } : { ok: false, code: 'agent_not_ready', message: 'waited the whole timeout' };
  };
  const { workers } = await call(f, { specs: ['w1=claude'], sleep: async () => {} });
  assert.deepEqual(keys, [['w1', ['down', 'enter']]]);
  assert.equal(workers[0].status, 'ready');
});
