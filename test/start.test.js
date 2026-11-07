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
  assert.match(r.message, /Describe the task/);
});

test('refuses outside git repo', async () => {
  const { deps } = fakes({ toplevel: null });
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, false);
  assert.match(r.message, /git repository/);
});

test('refuses the home directory as repository', async () => {
  const { deps } = fakes({ toplevel: home });
  const r = await startForeman({ ...deps, cwd: path.join(home, 'Downloads'), task: 'fix it' });
  assert.equal(r.ok, false);
  assert.match(r.message, /home directory/);
});

test('refuses a repository without commits', async () => {
  const { deps } = fakes({ headFails: true });
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, false);
  assert.match(r.message, /no commits/);
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
  assert.deepEqual(log.find(([k]) => k === 'start')[1], { name: 'lead', kind: 'claude', pane: 'w1:p9', timeoutMs: DEFAULT_CONFIG.startTimeoutMs });
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
  assert.match(r.message, /herdr agent prompt lead/);
});
