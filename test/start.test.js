import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildLeaderPrompt, startForeman, INSTRUCTIONS_PATH } from '../src/start.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const repo = path.resolve('/code/shop');
const home = path.resolve('/home/k');
const paths = { runs: path.resolve('/s/runs') };

function fakes({ inside = true, toplevel = repo, running = [true], live = [], startResult = { ok: true }, headFails = false } = {}) {
  const log = [];
  let checks = 0;
  const herdr = {
    serverRunning: async () => running[Math.min(checks++, running.length - 1)],
    workspaceCreate: async (o) => { log.push(['workspace', o]); return { workspaceId: 'w2', tabId: 'w2:t1', paneId: 'w2:p1' }; },
    tabCreate: async (o) => { log.push(['tab', o]); return { tabId: 'w1:t4', paneId: 'w1:p9' }; },
    agentList: async () => live.map((name) => ({ name })),
    agentStart: async (o) => { log.push(['start', o]); return startResult; },
    agentPrompt: async (name, text) => { log.push(['prompt', { name, text }]); },
  };
  const git = {
    toplevel: async () => toplevel,
    head: async () => { if (headFails) throw new Error('no commits'); return 'abc'; },
  };
  const env = inside ? { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', HERDR_PANE_ID: 'w1:p1' } : {};
  const deps = {
    cwd: repo, env, herdr, git, config: DEFAULT_CONFIG, paths, homedir: home,
    which: (name) => (name === 'claude' ? '/bin/claude' : null),
    exists: () => false,
    spawnDetached: (cmd, args) => log.push(['detached', [cmd, ...args]]),
    attach: () => log.push(['attach']),
    sleep: async () => {},
  };
  return { deps, log };
}

test('prompt is single line and points at the instructions', () => {
  const p = buildLeaderPrompt({ task: 'fix login\nand tests', slug: 'fix-login', instructionsPath: '/x/INSTRUCTIONS.md' });
  assert.ok(!p.includes('\n'));
  assert.match(p, /\/x\/INSTRUCTIONS\.md/);
  assert.match(p, /fix login and tests/);
  assert.match(p, /"fix-login"/);
  assert.ok(INSTRUCTIONS_PATH.endsWith(path.join('leader', 'INSTRUCTIONS.md')));
});

test('prompt names a custom foreman command', () => {
  const p = buildLeaderPrompt({ task: 't', slug: 't', instructionsPath: '/i', foremanCmd: 'node "/f/bin/foreman.js"' });
  assert.match(p, /node "\/f\/bin\/foreman\.js"/);
});

test('refuses empty task', async () => {
  const { deps } = fakes();
  const r = await startForeman({ ...deps, task: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.message, /what you want done/);
});

test('refuses outside git repo', async () => {
  const { deps } = fakes({ toplevel: null });
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, false);
  assert.match(r.message, /uses git/);
});

test('refuses the home directory as repository', async () => {
  const { deps } = fakes({ toplevel: home });
  const r = await startForeman({ ...deps, cwd: path.join(home, 'Downloads'), task: 'fix it' });
  assert.equal(r.ok, false);
  assert.match(r.message, /home folder/);
});

test('refuses a repository without commits', async () => {
  const { deps } = fakes({ headFails: true });
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, false);
  assert.match(r.message, /no saved version/);
});

test('refuses a missing leader program', async () => {
  const { deps } = fakes();
  const r = await startForeman({ ...deps, config: { ...DEFAULT_CONFIG, leader: 'codex' }, task: 'fix it' });
  assert.equal(r.ok, false);
  assert.match(r.message, /codex/);
});

test('inside herdr creates tab in current workspace and prompts the leader', async () => {
  const { deps, log } = fakes();
  const r = await startForeman({ ...deps, task: 'Sprawdź błąd w logowaniu' });
  assert.equal(r.ok, true);
  assert.equal(r.slug, 'sprawdz-blad-w-logowaniu');
  const tab = log.find(([k]) => k === 'tab')[1];
  assert.deepEqual([tab.workspaceId, tab.cwd, tab.focus], ['w1', repo, true]);
  const start = log.find(([k]) => k === 'start')[1];
  assert.deepEqual([start.name, start.kind, start.pane, start.timeoutMs], ['lead', 'claude', 'w1:p9', DEFAULT_CONFIG.startTimeoutMs]);
  assert.equal(log.find(([k]) => k === 'prompt')[1].name, 'lead');
  assert.equal(log.some(([k]) => k === 'attach'), false);
});

test('outside herdr starts server when not running', async () => {
  const { deps, log } = fakes({ inside: false, running: [false, false, true] });
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, true);
  assert.deepEqual(log.filter(([k]) => k === 'detached').map(([, c]) => c), [['herdr', 'server']]);
  assert.ok(log.findIndex(([k]) => k === 'workspace') < log.findIndex(([k]) => k === 'attach'));
  assert.equal(log.at(-1)[0], 'attach');
});

test('outside herdr gives up when the server never starts', async () => {
  const { deps } = fakes({ inside: false, running: [false] });
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, false);
  assert.match(r.message, /did not start/);
});

test('leader name avoids live agents', async () => {
  const { deps, log } = fakes({ live: ['lead', 'lead2'] });
  await startForeman({ ...deps, task: 'fix it' });
  assert.equal(log.find(([k]) => k === 'start')[1].name, 'lead3');
});

test('trust prompt leaves instructions instead of prompting', async () => {
  const { deps, log } = fakes({ startResult: { ok: false, code: 'agent_not_ready', message: 'trust prompt' } });
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, true);
  assert.equal(log.some(([k]) => k === 'prompt'), false);
  assert.match(r.message, /w1:p9/);
  assert.match(r.message, /foreman prompt --task fix-it lead "/);
});

test('claude leader starts lean with AskUserQuestion; extra leader args are appended', async () => {
  const { deps, log } = fakes();
  await startForeman({ ...deps, config: { ...DEFAULT_CONFIG, leaderArgs: ['--effort', 'high'] }, task: 'fix it' });
  const args = log.find(([k]) => k === 'start')[1].args;
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.join(' ').includes('AskUserQuestion'));
  assert.deepEqual(args.slice(-2), ['--effort', 'high']);
});

test('lean can be switched off', async () => {
  const { deps, log } = fakes();
  await startForeman({ ...deps, config: { ...DEFAULT_CONFIG, lean: false }, task: 'fix it' });
  assert.deepEqual(log.find(([k]) => k === 'start')[1].args, []);
});

test('a task with several lines goes to a task file the prompt points at', async () => {
  const { deps, log } = fakes();
  const written = [];
  const r = await startForeman({ ...deps, paths: { runs: path.resolve('/s/runs'), home: path.resolve('/s') }, mkdir: () => {}, writeFile: (f, t) => written.push([f, t]), task: 'fix login\n\nand the tests' });
  assert.equal(r.ok, true);
  assert.equal(written.length, 1);
  assert.ok(written[0][0].includes('tasks'));
  assert.equal(written[0][1], 'fix login\n\nand the tests\n');
  const text = log.find(([k]) => k === 'prompt')[1].text;
  assert.ok(!text.includes('\n'));
  assert.ok(text.includes(written[0][0]));
});

test('@file mentions are listed for the leader; uncommitted ones are flagged', async () => {
  const { deps, log } = fakes();
  deps.exists = (p) => p.endsWith('login.js') || p.endsWith('README.md');
  deps.git.changedFiles = async () => ['src/login.js'];
  const said = [];
  const r = await startForeman({ ...deps, report: (m) => said.push(m), task: 'fix @src/login.js, see @README.md.' });
  assert.equal(r.ok, true);
  const text = log.find(([k]) => k === 'prompt')[1].text;
  assert.match(text, /Files the user pointed to \(read them first\): src\/login\.js \(has uncommitted changes\), README\.md\./);
  assert.ok(said.some((m) => /src\/login\.js has changes you have not committed/.test(m)));
});

test('a missing @file stops with a plain message', async () => {
  const { deps, log } = fakes();
  const r = await startForeman({ ...deps, task: 'fix @nope.js and mail me@site.com' });
  assert.equal(r.ok, false);
  assert.match(r.message, /could not find this file: nope\.js/);
  assert.equal(log.length, 0);
});

// The Herdr app: hc terminals instead of panes; ids for new spaces and tabs.
function appFakes({ inside = true, labels = { space: 'spA', tab: 'tbA' }, startResult = { ok: true, pane: 't9' }, windowOpen = true } = {}) {
  const f = fakes({ inside: false });
  const { log } = f;
  f.deps.herdr = {
    kind: 'app',
    appBin: 'C:/apps/herdr-app.exe',
    here: async (t) => { log.push(['here', t]); return labels; },
    workspaceCreate: async (o) => { log.push(['workspace', o]); return { workspaceId: 'spNew', tabId: 'tbNew', paneId: null }; },
    tabCreate: async (o) => { log.push(['tab', o]); return { workspaceId: o.workspaceId ?? 'spNew', tabId: 'tbNew', paneId: null }; },
    agentList: async () => [],
    agentStart: async (o) => { log.push(['start', o]); return startResult; },
    agentPrompt: async (name, text) => { log.push(['prompt', { name, text }]); },
    appRunning: async () => windowOpen,
    serverRunning: async () => { throw new Error('the app backend does not wait for a herdr server'); },
  };
  f.deps.env = inside ? { HC_TERMINAL_ID: 't3' } : {};
  return f;
}

test('in the Herdr app the leader goes into a new tab of the caller\'s space', async () => {
  const { deps, log } = appFakes();
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, true);
  assert.equal(r.paneId, 't9');
  assert.deepEqual(log.find(([k]) => k === 'here')[1], 't3');
  const start = log.find(([k]) => k === 'start')[1];
  assert.deepEqual([start.name, start.cwd, start.space, start.tab, start.label, start.focus], ['lead', repo, 'spA', 'tbNew', 'foreman', true]);
  assert.equal(log.find(([k]) => k === 'prompt')[1].name, 'lead');
  assert.equal(log.some(([k]) => k === 'attach' || k === 'detached'), false);
});

test('in the Herdr app outside any terminal the leader gets a new space and nothing attaches', async () => {
  const { deps, log } = appFakes({ inside: false });
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, true);
  const start = log.find(([k]) => k === 'start')[1];
  assert.deepEqual([start.space, start.tab], ['spNew', 'tbNew']);
  assert.equal(log.some(([k]) => k === 'attach' || k === 'detached'), false);
});

test('in the Herdr app with the window closed foreman opens it', async () => {
  const { deps, log } = appFakes({ inside: false, windowOpen: false });
  await startForeman({ ...deps, task: 'fix it' });
  assert.deepEqual(log.filter(([k]) => k === 'detached').map(([, c]) => c), [['C:/apps/herdr-app.exe']]);
  assert.equal(log.some(([k]) => k === 'attach'), false);
});

test('in the Herdr app a leader that is not ready gets a foreman prompt hint with --backend app', async () => {
  const { deps, log } = appFakes({ inside: false, startResult: { ok: false, pane: 't9', code: 'agent_not_ready', message: 'claude is waiting for an answer' } });
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, true);
  assert.equal(log.some(([k]) => k === 'prompt'), false);
  assert.match(r.message, /pane t9/);
  assert.match(r.message, /foreman prompt --task fix-it --backend app lead "/);
});

test('a leader that never got a terminal fails with hc\'s reason', async () => {
  const { deps } = appFakes({ startResult: { ok: false, pane: null, code: 'spawn_failed', message: 'claude not found' } });
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, false);
  assert.match(r.message, /claude not found/);
});
