import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildLeaderPrompt, shellQuote, startForeman, leaderName, spaceOfRepo, waitForTrust, INSTRUCTIONS_PATH } from '../src/start.js';
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
    platform: 'linux',
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

test('a one-line task is saved for history but stays in the prompt', async () => {
  const { deps, log } = fakes();
  const written = [];
  const r = await startForeman({ ...deps, paths: { runs: path.resolve('/s/runs'), home: path.resolve('/s') }, mkdir: () => {}, writeFile: (f, t) => written.push([f, t]), task: 'fix login' });
  assert.equal(r.ok, true);
  assert.deepEqual(written, [[path.resolve('/s/tasks/fix-login.md'), 'fix login\n']]);
  const text = log.find(([k]) => k === 'prompt')[1].text;
  assert.match(text, /: fix login$/);
});

test('a saved task file also makes the slug unique', async () => {
  const { deps } = fakes();
  const taken = path.resolve('/s/tasks/fix-login.md');
  const r = await startForeman({ ...deps, paths: { runs: path.resolve('/s/runs'), home: path.resolve('/s') }, exists: (p) => p === taken, task: 'fix login' });
  assert.equal(r.slug, 'fix-login-2');
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
  // The name and the tab title carry the task; labels say which run and role.
  assert.deepEqual([start.name, start.cwd, start.space, start.tab, start.label, start.focus], ['fix-it-lead', repo, 'spA', 'tbNew', 'foreman · fix-it', true]);
  assert.deepEqual(start.labels, { 'foreman.task': 'fix-it', 'foreman.role': 'leader' });
  assert.equal(start.where, 'shop / fix-it');
  assert.equal(start.parent, undefined);
  assert.equal(log.find(([k]) => k === 'prompt')[1].name, 'fix-it-lead');
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
  assert.match(r.message, /foreman prompt --task fix-it --backend app fix-it-lead "/);
});

test('on Windows the foreman prompt hint is quoted for PowerShell', async () => {
  const { deps } = fakes({ startResult: { ok: false, code: 'agent_not_ready', message: 'claude is waiting for an answer' } });
  const r = await startForeman({ ...deps, platform: 'win32', task: "fix Bob's $price `rounding` \"now\"" });
  assert.match(r.message, /foreman prompt --task [\w-]+ lead 'You are the foreman leader for task ''[\w-]+''\. /);
  assert.ok(r.message.includes("fix Bob''s $price `rounding` ''now'''"));
});

test('shell quoting: double quotes on POSIX, PowerShell single quotes on Windows', () => {
  assert.equal(shellQuote('say "hi" $x', 'linux'), '"say \\"hi\\" $x"');
  assert.equal(shellQuote("it's \"$x\"", 'win32'), "'it''s ''$x'''");
});

test('a leader that never got a terminal fails with hc\'s reason', async () => {
  const { deps } = appFakes({ startResult: { ok: false, pane: null, code: 'spawn_failed', message: 'claude not found' } });
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.equal(r.ok, false);
  assert.match(r.message, /claude not found/);
});

test('a leader stuck on a trust dialog is told which keys answer it', async () => {
  const { deps } = fakes({ startResult: { ok: false, code: 'agent_not_ready', message: 'claude is waiting for an answer' } });
  deps.herdr.agentRead = async () => ['Do you trust the files in this folder?', ' > Yes, I trust this folder', '   No, exit'].join('\n');
  const r = await startForeman({ ...deps, task: 'fix it' });
  assert.match(r.message, /asks to trust this folder; answer it with: foreman keys --task fix-it lead enter/);
  assert.match(r.message, /foreman prompt --task fix-it lead/);
});

test('progress lines tell what foreman is doing, and the result names the leader tab', async () => {
  const { deps } = fakes();
  const lines = [];
  const r = await startForeman({ ...deps, task: 'fix it', progress: (m) => lines.push(m) });
  assert.equal(r.tab, 'foreman');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /Checking the project/);
  assert.match(lines[2], /Starting claude/);
});

test('prompt tells the leader what the user already answered', async () => {
  const { takePrefs, prefsText } = await import('../src/start-prefs.js');
  assert.deepEqual(takePrefs(['--auto-answer', '--include-uncommitted', '--', 'x']), { prefs: { autoAnswer: true, includeUncommitted: true }, rest: ['--', 'x'] });
  assert.deepEqual(takePrefs(['fix it']), { prefs: {}, rest: ['fix it'] });
  assert.equal(prefsText({}), '');
  const p = buildLeaderPrompt({ task: 't', slug: 't', instructionsPath: '/i', prefs: { autoAnswer: true, includeUncommitted: true } });
  assert.ok(!p.includes('\n'));
  assert.match(p, /answer the workers' permission questions on their behalf/);
  assert.match(p, /add --include-uncommitted to the first spawn/);
  assert.doesNotMatch(buildLeaderPrompt({ task: 't', slug: 't', instructionsPath: '/i' }), /already chose/);
});

test('--leader starts that agent for this task only; an unknown kind or a missing program is refused', async () => {
  const { deps, log } = fakes();
  const which = (name) => (['claude', 'codex'].includes(name) ? `/bin/${name}` : null);
  const r = await startForeman({ ...deps, which, task: 'fix it', prefs: { leader: 'codex' } });
  assert.equal(r.ok, true);
  assert.equal(log.find(([k]) => k === 'start')[1].kind, 'codex');
  assert.match(r.message, /\(codex\)/);
  const unknown = await startForeman({ ...deps, which, task: 'fix it', prefs: { leader: 'nope' } });
  assert.match(unknown.message, /"nope" is not an agent foreman can start/);
  const missing = await startForeman({ ...deps, task: 'fix it', prefs: { leader: 'codex' } });
  assert.match(missing.message, /codex is not installed/);
});

test('--base must be a local branch and is passed on to the leader', async () => {
  const { deps, log } = fakes();
  deps.git.branchExists = async (r, b) => b === 'develop';
  const bad = await startForeman({ ...deps, task: 'fix it', prefs: { base: 'nope' } });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /branch "nope" does not exist/);
  const ok = await startForeman({ ...deps, task: 'fix it', prefs: { base: 'develop' } });
  assert.equal(ok.ok, true);
  assert.match(log.find(([k]) => k === 'prompt')[1].text, /base branch develop: add --base develop to the first spawn/);
});

test('takePrefs reads --leader and --base with their values', async () => {
  const { takePrefs } = await import('../src/start-prefs.js');
  assert.deepEqual(takePrefs(['--leader', 'codex', '--base', 'develop', '--auto-answer', '--', 'x']),
    { prefs: { leader: 'codex', base: 'develop', autoAnswer: true }, rest: ['--', 'x'] });
  assert.equal(takePrefs(['--leader']).error, '--leader needs a value');
  assert.equal(takePrefs(['--base', '--', 'x']).error, '--base needs a value');
});

test('leaderName carries the slug and fits hc\'s 32 characters', () => {
  assert.equal(leaderName('fix-login'), 'fix-login-lead');
  assert.equal(leaderName('fix-login', 2), 'fix-login-lead2');
  const long = 'check-the-payment-module-for-security';
  assert.equal(leaderName(long), 'check-the-payment-module-fo-lead');
  assert.equal(leaderName(long).length, 32);
  assert.equal(leaderName(long, 2), 'check-the-payment-module-f-lead2');
  assert.equal(leaderName(long, 12), 'check-the-payment-module-lead12');
  // A cut that ends on a dash does not leave two dashes.
  assert.equal(leaderName('aaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbb'), 'aaaaaaaaaaaaaaaaaaaaaaaaaa-lead');
  for (const name of [leaderName(long), leaderName('2fa', 3)]) assert.match(name, /^[a-z0-9_-]{1,32}$/);
});

test('in the Herdr app a second leader of the same task gets a number', async () => {
  const { deps, log } = appFakes();
  deps.herdr.agentList = async () => [{ name: 'fix-it-lead' }, { name: 'fix-it-lead2' }];
  await startForeman({ ...deps, task: 'fix it' });
  assert.equal(log.find(([k]) => k === 'start')[1].name, 'fix-it-lead3');
});

test('in herdr the leader keeps its short name and tab title', async () => {
  const { deps, log } = fakes();
  await startForeman({ ...deps, task: 'fix it' });
  const start = log.find(([k]) => k === 'start')[1];
  assert.deepEqual([start.name, start.label], ['lead', 'foreman']);
});

test('in the Herdr app a task typed in a narrow terminal leaves a layout hint on the leader', async () => {
  const typedIn = async (cols) => {
    const { deps, log } = appFakes();
    deps.herdr.terminalInfo = async (t) => { log.push(['info', t]); return cols === null ? null : { cols, rows: 20, labels: {} }; };
    await startForeman({ ...deps, task: 'fix it' });
    return log;
  };
  const narrow = await typedIn(45);
  assert.deepEqual(narrow.find(([k]) => k === 'info')[1], 't3');
  assert.deepEqual(narrow.find(([k]) => k === 'start')[1].labels, { 'foreman.task': 'fix-it', 'foreman.role': 'leader', 'foreman.layout': 'tabs' });
  for (const cols of [80, 200, null]) {
    const log = await typedIn(cols);
    assert.deepEqual(log.find(([k]) => k === 'start')[1].labels, { 'foreman.task': 'fix-it', 'foreman.role': 'leader' });
  }
});

test('in the Herdr app outside any terminal no terminal is asked for its width', async () => {
  const { deps, log } = appFakes({ inside: false });
  deps.herdr.terminalInfo = async (t) => { log.push(['info', t]); return { cols: 45, rows: 20, labels: {} }; };
  await startForeman({ ...deps, task: 'fix it' });
  assert.equal(log.some(([k]) => k === 'info'), false);
  assert.equal('foreman.layout' in log.find(([k]) => k === 'start')[1].labels, false);
});

// ---- the space of the repository, and waiting for a trust question ----

test('in the Herdr app a caller without a space joins the space whose terminals work in the repository', async () => {
  const panes = [{ pane_id: 't1', cwd: home }, { pane_id: 't2', cwd: path.join(repo, 'src') }, { pane_id: 't5', cwd: repo }];
  const here = (log) => async (t) => { log.push(['here', t]); return t === 't5' ? { space: 'spShop', tab: 'tb1' } : null; };

  // Outside any terminal of the app.
  const out = appFakes({ inside: false });
  out.deps.herdr.paneList = async () => panes;
  out.deps.herdr.here = here(out.log);
  assert.equal((await startForeman({ ...out.deps, task: 'fix it' })).ok, true);
  assert.equal(out.log.find(([k]) => k === 'start')[1].space, 'spShop');
  assert.equal(out.log.find(([k]) => k === 'tab')[1].workspaceId, 'spShop');
  assert.equal(out.log.some(([k]) => k === 'workspace'), false);
  // Only terminals inside the repository are asked for their space.
  assert.deepEqual(out.log.filter(([k]) => k === 'here').map(([, t]) => t), ['t2', 't5']);

  // In a terminal that has no space of its own, such as the launcher.
  const launcher = appFakes();
  launcher.deps.herdr.paneList = async () => panes;
  launcher.deps.herdr.here = here(launcher.log);
  await startForeman({ ...launcher.deps, task: 'fix it' });
  assert.equal(launcher.log.find(([k]) => k === 'start')[1].space, 'spShop');
  assert.deepEqual(launcher.log.filter(([k]) => k === 'here').map(([, t]) => t), ['t3', 't2', 't5']);
});

test('spaceOfRepo: no terminal in the repository, or a backend without spaces, gives none', async () => {
  const herdr = { paneList: async () => [{ pane_id: 't1', cwd: home }], here: async () => ({ space: 'spX' }) };
  assert.equal(await spaceOfRepo({ herdr, repo }), null);
  assert.equal(await spaceOfRepo({ herdr: { paneList: async () => { throw new Error('no core'); }, here: async () => null }, repo }), null);
  assert.equal(await spaceOfRepo({ herdr: {}, repo }), null);
  assert.equal(await spaceOfRepo({ herdr: { ...herdr, paneList: async () => [{ pane_id: 't2', cwd: repo }] }, repo }), 'spX');
});

const TRUST = ['Do you trust the files in this folder?', ' > Yes, I trust this folder', '   No, exit'].join('\n');
const notReady = { ok: false, pane: 't9', code: 'agent_not_ready', message: 'claude did not report ready within 90s' };

// A leader that shows the trust question for the first `asks` looks at its screen.
function trusting(f, { asks = 3, after = 'idle', gone = false } = {}) {
  let reads = 0;
  const started = () => f.log.find(([k]) => k === 'start')?.[1].name;
  f.deps.herdr.agentRead = async () => (++reads <= asks ? TRUST : 'Welcome back!\n> ');
  f.deps.herdr.agentList = async () => (started() && !gone ? [{ name: started(), agent_status: reads <= asks + 1 ? 'working' : after }] : []);
  const slept = [];
  f.deps.sleep = async (ms) => { slept.push(ms); };
  return slept;
}

test('a leader that asks to trust the folder gets the task once the question is answered', async () => {
  const f = appFakes({ startResult: notReady });
  const slept = trusting(f);
  const lines = [];
  const r = await startForeman({ ...f.deps, task: 'fix it', progress: (m) => lines.push(m) });
  assert.equal(r.ok, true);
  assert.deepEqual(f.log.filter(([k]) => k === 'prompt').map(([, p]) => p.name), ['fix-it-lead']);
  assert.match(r.message, /Leader "fix-it-lead" \(claude\) started in pane t9/);
  assert.doesNotMatch(r.message, /foreman prompt --task/);
  assert.match(lines.at(-1), /claude asks whether to trust this folder\. Answer it in the leader's tab; foreman waits up to 3 min/);
  // Two looks at the question, one while the agent still loads, one when it is ready.
  assert.deepEqual(slept, [2000, 2000, 2000, 2000]);
});

test('an agent that reports no status gets the task once its screen has been free of the question twice', async () => {
  const f = fakes({ startResult: { ok: false, code: 'agent_not_ready', message: 'trust prompt' } });
  const slept = trusting(f, { asks: 2, after: 'unknown' });
  f.deps.herdr.agentList = async () => (f.log.some(([k]) => k === 'start') ? [{ name: 'lead', agent_status: 'unknown' }] : []);
  const r = await startForeman({ ...f.deps, task: 'fix it' });
  assert.equal(f.log.filter(([k]) => k === 'prompt').length, 1);
  assert.match(r.message, /Leader "lead" \(claude\) started/);
  assert.equal(slept.length, 3);
});

test('a leader closed at the trust question is reported, and nothing is sent', async () => {
  const f = appFakes({ startResult: notReady });
  trusting(f, { asks: 1, gone: true });
  const r = await startForeman({ ...f.deps, task: 'fix it' });
  assert.equal(r.ok, false);
  assert.match(r.message, /The leader was closed before it got the task/);
  assert.equal(f.log.some(([k]) => k === 'prompt'), false);
});

test('when the trust question outlasts the wait, the command to hand over the task by hand is shown', async () => {
  const f = appFakes({ startResult: notReady });
  const slept = trusting(f, { asks: Infinity });
  const r = await startForeman({ ...f.deps, task: 'fix it', trustWaitMs: 10000 });
  assert.equal(r.ok, true);
  assert.equal(slept.length, 5);
  assert.equal(f.log.some(([k]) => k === 'prompt'), false);
  assert.match(r.message, /asks to trust this folder/);
  assert.match(r.message, /foreman prompt --task fix-it fix-it-lead "/);
  // trustWaitMs 0 switches the wait off; a question that is not about trust is never waited for.
  const off = appFakes({ startResult: notReady });
  const none = trusting(off, { asks: Infinity });
  await startForeman({ ...off.deps, task: 'fix it', trustWaitMs: 0 });
  assert.deepEqual(none, []);
  const login = appFakes({ startResult: notReady });
  const waited = trusting(login);
  login.deps.herdr.agentRead = async () => 'Please sign in to continue';
  const res = await startForeman({ ...login.deps, task: 'fix it' });
  assert.deepEqual(waited, []);
  assert.match(res.message, /foreman prompt --task fix-it/);
});

test('waitForTrust: ready, gone and timeout', async () => {
  const sleep = async () => {};
  const herdr = (screen, agents) => ({ agentRead: async () => screen, agentList: async () => agents });
  assert.equal(await waitForTrust({ herdr: herdr('> ', [{ name: 'l', agent_status: 'done' }]), name: 'l', kind: 'claude', sleep, waitMs: 4000 }), 'ready');
  assert.equal(await waitForTrust({ herdr: herdr('> ', []), name: 'l', kind: 'claude', sleep, waitMs: 4000 }), 'gone');
  assert.equal(await waitForTrust({ herdr: herdr(TRUST, [{ name: 'l', agent_status: 'idle' }]), name: 'l', kind: 'claude', sleep, waitMs: 4000 }), 'timeout');
  assert.equal(await waitForTrust({ herdr: herdr('> ', [{ name: 'l', agent_status: 'blocked' }]), name: 'l', kind: 'claude', sleep, waitMs: 4000 }), 'timeout');
  // A screen or a list that cannot be read is not an answer.
  const broken = { agentRead: async () => { throw new Error('x'); }, agentList: async () => [] };
  assert.equal(await waitForTrust({ herdr: broken, name: 'l', kind: 'claude', sleep, waitMs: 4000 }), 'timeout');
});
