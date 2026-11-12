import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resumeNotes, buildResumePrompt, respawnWorker, resumeFile, RESPAWN_SPEC } from '../src/resume.js';
import { taskFile } from '../src/history.js';
import { startForeman } from '../src/start.js';
import { runOps } from '../src/run-commands.js';
import { main } from '../src/cli.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const paths = { home: path.resolve('/s'), runs: path.resolve('/s/runs') };
const repo = path.resolve('/code/shop');
const wt = (name) => path.resolve('/s/worktrees/shop-abc/fix-login', name);
const report = (name, file) => path.join(wt(name), '.foreman', file);

function run(over = {}) {
  return {
    task: 'fix-login',
    repo,
    base: 'abc1234',
    branch: 'fix/login',
    createdAt: '2026-11-09T09:00:00.000Z',
    phase: 'investigate',
    workers: [
      { name: 'w1', kind: 'claude', model: 'opus', auto: true, paneId: 'p2', worktree: wt('w1'), branch: 'wip/login/w1', reportDir: path.join(wt('w1'), '.foreman'), startedAt: '2026-11-09T09:00:00.000Z', endedAt: 'x', endedPhase: 'investigate' },
      { name: 'w2', kind: 'codex', model: null, paneId: 'p3', worktree: wt('w2'), branch: 'wip/login/w2', reportDir: path.join(wt('w2'), '.foreman') },
    ],
    ...over,
  };
}

function files(extra = {}) {
  const all = { [taskFile(paths, 'fix-login')]: 'fix the login\n', [report('w1', 'proposals.md')]: '- [high] a.js: x -> y\n', ...extra };
  return {
    all,
    readFile: (f) => {
      if (!(f in all)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return all[f];
    },
    exists: (p) => p in all || p === wt('w1') || p === wt('w2'),
  };
}

test('respawn spec: name alone, or with a kind and model', () => {
  assert.deepEqual(RESPAWN_SPEC.exec('w1').slice(1), ['w1', undefined, undefined]);
  assert.deepEqual(RESPAWN_SPEC.exec('w1=codex:gpt-5.1').slice(1), ['w1', 'codex', 'gpt-5.1']);
  assert.equal(RESPAWN_SPEC.test('W1'), false);
});

test('resume notes hold the task, the run state, reports and the next step', () => {
  const f = files();
  const text = resumeNotes(run(), { paths, ...f, agents: [{ name: 'w2', pane_id: 'p3' }] });
  assert.match(text, /# Resuming foreman run "fix-login"/);
  assert.match(text, /fix the login/);
  assert.match(text, /phase: investigate/);
  assert.match(text, /w1: claude:opus, stopped, auto mode/);
  assert.match(text, /w2: codex, live/);
  assert.match(text, /### w1: proposals\.md\n\n- \[high\] a\.js: x -> y/);
  assert.match(text, /foreman respawn --task fix-login <name>/);
  assert.match(text, /wait for them \(step 4/);

  const both = files({ [report('w2', 'proposals.md')]: '- [low] b.js: z -> w\n' });
  assert.match(resumeNotes(run(), { paths, ...both }), /one list \(step 5\)/);
  assert.match(resumeNotes(run({ phase: 'merged' }), { paths, ...f }), /step 7/);
  const long = files({ [report('w1', 'proposals.md')]: 'x'.repeat(7000) });
  assert.match(resumeNotes(run(), { paths, ...long }), /\(cut; the full file is /);
  const none = { readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, exists: () => false };
  assert.match(resumeNotes(run(), { paths, ...none }), /task text was not saved[\s\S]*No worker has written a report yet/);
});

test('the resume prompt is one line and points at instructions and notes', () => {
  const p = buildResumePrompt({ slug: 'fix-login', instructionsPath: '/x/INSTRUCTIONS.md', notesPath: '/s/tasks/fix-login.resume.md', foremanCmd: 'node "/f/bin/foreman.js"' });
  assert.ok(!p.includes('\n'));
  assert.match(p, /"fix-login"/);
  assert.match(p, /\/x\/INSTRUCTIONS\.md/);
  assert.match(p, /fix-login\.resume\.md/);
  assert.match(p, /Run foreman commands as: node/);
  assert.equal(resumeFile(paths, 'fix-login'), path.resolve('/s/tasks/fix-login.resume.md'));
});

test('startForeman with a fixed slug and prompt neither renames nor rewrites the task', async () => {
  const log = [];
  const written = [];
  const r = await startForeman({
    task: 'fix the login @missing.js', slug: 'fix-login', prompt: 'RESUME PROMPT', cwd: repo, env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' },
    herdr: {
      tabCreate: async () => ({ tabId: 't', paneId: 'p9' }),
      agentList: async () => [{ name: 'lead' }],
      agentStart: async (o) => { log.push(['start', o.name]); return { ok: true }; },
      agentPrompt: async (name, text) => { log.push(['prompt', name, text]); },
    },
    git: { toplevel: async () => repo, head: async () => 'abc' },
    which: () => '/bin/claude', config: DEFAULT_CONFIG, paths, homedir: path.resolve('/home/k'), exists: () => true,
    writeFile: (f, t) => written.push(f), mkdir: () => {}, sleep: async () => {}, attach: () => {}, spawnDetached: () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.slug, 'fix-login');
  assert.deepEqual(log, [['start', 'lead2'], ['prompt', 'lead2', 'RESUME PROMPT']]);
  assert.deepEqual(written, []);
});

function fakeHerdr({ kind = 'herdr', live = [], panes = [], ready = true } = {}) {
  const log = [];
  return {
    log,
    kind,
    agentList: async () => live.map((name) => ({ name })),
    paneList: async () => panes,
    paneSplit: async (o) => { log.push(['split', o]); return 'p7'; },
    tabCreate: async (o) => { log.push(['tab', o]); return { tabId: 't2', paneId: 'p8', workspaceId: 'sp2' }; },
    here: async () => ({ space: 'sp1', tab: 'tb1' }),
    agentStart: async (o) => { log.push(['start', o]); return ready ? { ok: true, pane: o.pane ?? 'term5' } : { ok: false, code: 'agent_not_ready', message: 'trust?' }; },
  };
}

const respawn = (h, over = {}) => respawnWorker({ run: run(), herdr: h, spec: 'w1', pane: 'p1', config: DEFAULT_CONFIG, exists: (p) => p === wt('w1'), now: () => Date.parse('2026-11-09T12:00:00Z'), ...over });

test('respawn reuses the old pane when it still sits in the worktree', async () => {
  const h = fakeHerdr({ panes: [{ pane_id: 'p2', foreground_cwd: path.join(wt('w1'), 'src') }] });
  const res = await respawn(h, { auto: true });
  const start = h.log.find(([k]) => k === 'start')[1];
  assert.equal(start.pane, 'p2');
  assert.equal(start.cwd, wt('w1'));
  assert.equal(start.kind, 'claude');
  assert.ok(start.args.includes('--model') && start.args.includes('opus'));
  assert.ok(start.args.includes('--permission-mode'));
  assert.equal(res.status, 'ready');
  assert.equal(res.worker.auto, true);
  assert.equal(res.worker.endedAt, undefined);
  assert.equal(res.worker.startedAt, '2026-11-09T09:00:00.000Z');
  assert.deepEqual(res.worker.respawns, [{ at: '2026-11-09T12:00:00.000Z', kind: 'claude', model: 'opus' }]);
});

test('respawn splits next to the caller, or opens a tab, and can switch agents', async () => {
  const h = fakeHerdr();
  const res = await respawn(h, { spec: 'w1=codex:gpt-5.1-codex' });
  assert.deepEqual(h.log[0], ['split', { pane: 'p1', direction: 'right', ratio: 0.5, cwd: wt('w1') }]);
  assert.equal(res.worker.kind, 'codex');
  assert.equal(res.worker.model, 'gpt-5.1-codex');
  assert.equal(res.worker.paneId, 'p7');
  const tab = fakeHerdr();
  await respawn(tab, { pane: null });
  assert.equal(tab.log[0][0], 'tab');
  const notReady = await respawn(fakeHerdr({ ready: false }));
  assert.equal(notReady.status, 'not_ready');
  assert.match(notReady.error, /trust/);
});

test('respawn in the Herdr app starts in the caller\'s tab', async () => {
  const h = fakeHerdr({ kind: 'app' });
  const res = await respawn(h, { run: run({ backend: 'app' }) });
  const start = h.log.find(([k]) => k === 'start')[1];
  assert.equal(start.space, 'sp1');
  assert.equal(start.tab, 'tb1');
  assert.equal(res.worker.paneId, 'term5');
  // The calling leader becomes its parent, and the labels name the run.
  assert.equal(start.parent, 'p1');
  assert.deepEqual(start.labels, { 'foreman.task': 'fix-login', 'foreman.role': 'worker' });
  assert.equal(start.where, 'shop / fix-login');
  assert.equal(start.ownTab, false);
});

test('respawn in a run with layout tabs gives the worker a tab of its own again', async () => {
  const h = fakeHerdr({ kind: 'app' });
  await respawn(h, { run: run({ backend: 'app', layout: 'tabs' }) });
  assert.deepEqual(h.log.find(([k]) => k === 'tab')[1], { workspaceId: 'sp1', cwd: wt('w1'), label: 'w1 · fix-login', focus: false });
  const start = h.log.find(([k]) => k === 'start')[1];
  assert.deepEqual([start.space, start.tab, start.label, start.ownTab], ['sp2', 't2', 'w1 · fix-login', true]);
  // In herdr: a new tab instead of a split beside the caller.
  const tui = fakeHerdr();
  await respawn(tui, { run: run({ layout: 'tabs' }) });
  assert.equal(tui.log.some(([k]) => k === 'split'), false);
  assert.equal(tui.log.find(([k]) => k === 'tab')[1].label, 'w1 · fix-login');
  assert.equal(tui.log.find(([k]) => k === 'start')[1].pane, 'p8');
});

test('respawn refuses: unknown worker, live agent, gone worktree, other backend, unknown kind', async () => {
  await assert.rejects(respawn(fakeHerdr(), { spec: 'w9' }), /no worker "w9"/);
  await assert.rejects(respawn(fakeHerdr({ live: ['w1'] })), (e) => e.code === 'NAME_TAKEN');
  await assert.rejects(respawn(fakeHerdr(), { exists: () => false }), /worktree .* is gone/);
  await assert.rejects(respawn(fakeHerdr({ kind: 'app' })), /runs its workers in herdr/);
  await assert.rejects(respawn(fakeHerdr(), { spec: 'w1=nope' }), (e) => e.code === 'UNKNOWN_KIND');
});

test('prepareResume writes the notes; a cleaned-up run cannot be resumed', async () => {
  const f = files();
  f.all[path.join(paths.runs, 'fix-login.json')] = JSON.stringify(run());
  f.all[path.join(paths.runs, 'done.json')] = JSON.stringify(run({ task: 'done', phase: 'cleaned', outcome: 'landed' }));
  const ops = runOps({
    paths, readFile: f.readFile, exists: f.exists, env: {}, run: async () => ({ code: 1, stdout: '', stderr: '' }), which: () => null,
    writeFile: (file, text) => { f.all[file] = text; }, mkdir: () => {}, foremanCmd: 'foreman',
  });
  const prep = await ops.prepareResume({ task: 'fix-login' });
  assert.equal(prep.slug, 'fix-login');
  assert.equal(prep.task, 'fix the login');
  assert.equal(prep.repo, repo);
  assert.equal(prep.backend, 'herdr');
  assert.match(f.all[prep.notes], /Resuming foreman run/);
  assert.ok(prep.prompt.includes(prep.notes));
  await assert.rejects(ops.prepareResume({ task: 'done' }), /is finished \(landed\)/);
  await assert.rejects(ops.prepareResume({ task: 'nope' }), (e) => e.code === 'NO_RUN');
});

test('foreman resume starts a leader in the run\'s repo; respawn passes its flags', async () => {
  let out = '';
  const calls = [];
  const deps = {
    env: {},
    paths,
    readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    stdout: { write: (x) => { out += x; } },
    stderr: { write: () => {} },
    ops: {
      prepareResume: async ({ task }) => ({ slug: task, task: 'fix the login', repo, backend: 'app', notes: '/s/tasks/n.md', prompt: 'P' }),
      start: async (o) => { calls.push(o); return { ok: true, leader: 'lead', paneId: 'p9' }; },
      respawn: async (o) => { calls.push(o); return { name: 'w1', kind: 'claude', paneId: 'p2', status: 'ready', error: null, warnings: [] }; },
    },
  };
  assert.equal(await main(['resume', '--task', 'fix-login'], deps), 0);
  assert.deepEqual(calls[0], { task: 'fix the login', backend: 'app', cwd: repo, slug: 'fix-login', prompt: 'P' });
  assert.match(out, /starts from \/s\/tasks\/n\.md/);
  assert.equal(await main(['respawn', '--task', 'fix-login', 'w1=claude:opus', '--effort', 'high', '--auto'], deps), 0);
  assert.deepEqual(calls[1], { task: 'fix-login', spec: 'w1=claude:opus', newTab: false, effort: 'high', auto: true, full: false });
  assert.match(out, /send it again with foreman prompt/);
  // Without --task these words are a task.
  assert.equal(await main(['resume', 'the', 'upload'], deps), 0);
  assert.equal(calls[2].task, 'resume the upload');
});
