import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHerdrApp } from '../src/herdr-app.js';
import { HerdrError } from '../src/herdr.js';
import { fakeRun } from './helpers.js';
import { OPENCODE_UPDATE_MODAL, OPENCODE_READY, AGY_AUTO_NOTICE } from './fixtures/screens.js';

const out = (body) => ({ stdout: JSON.stringify(body) });
const hcError = (kind, message, code = 3) => ({ code, stderr: JSON.stringify({ error: { kind, message, hint: '' } }) });
const ids = () => {
  let n = 0;
  return (prefix) => `${prefix}${++n}`;
};
const ls = (terminals) => [/^hc ls/, out({ hidden_finished: 0, terminals })];

test('agentStart runs an agent without a parent (a leader) with labels, and waits until it is ready', async () => {
  const run = fakeRun([
    [/^hc run/, out({ address: 't7', name: 'w1', state: 'live' })],
    [/^hc wait/, out({ ended: true, reason: 'status', status: 'idle', terminal: 't7' })],
    [/^herdr-app do/, { code: 0 }],
  ]);
  const herdr = createHerdrApp({ run });
  const res = await herdr.agentStart({ name: 'w1', kind: 'claude', cwd: '/wt/w1', space: 'sp1', tab: 'tb1', label: 'foreman:x', timeoutMs: 60000, args: ['--model', 'opus'] });
  assert.deepEqual(res, { ok: true, pane: 't7' });
  assert.deepEqual(run.calls[0].args, [
    'run', '--json', '--bg', '--no-parent', '--no-notify', '--name', 'w1', '--cwd', '/wt/w1',
    '--label', 'herdr.space=sp1', '--label', 'herdr.tab=tb1', '--label', 'foreman.name=w1',
    '--', 'claude', '--model', 'opus',
  ]);
  // hc waits in check-ins (see waitReady); this agent was ready at the first.
  assert.deepEqual(run.calls[1].args, ['wait', '--json', '--timeout', '5', 't7']);
  assert.deepEqual(run.calls[2].args, ['do', 'tab.rename', JSON.stringify({ id: 'tb1', name: 'foreman:x' })]);
});

test('agentStart adds the flags a kind needs under hc', async () => {
  const run = fakeRun([[/^hc run/, out({ address: 't2' })], [/^hc wait/, out({ ended: true, status: 'idle' })]]);
  await createHerdrApp({ run }).agentStart({ name: 'c1', kind: 'codex', cwd: '/wt' });
  const argv = run.calls[0].args;
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['codex']);
});

test('agentStart reports a blocked agent as not ready, with its terminal', async () => {
  const run = fakeRun([[/^hc run/, out({ address: 't3' })], [/^hc wait/, out({ ended: true, reason: 'status', status: 'blocked' })]]);
  const res = await createHerdrApp({ run }).agentStart({ name: 'w1', kind: 'claude', cwd: '/wt' });
  assert.deepEqual(res, { ok: false, pane: 't3', code: 'agent_not_ready', message: 'claude is waiting for an answer' });
});

test('agentStart never throws: a failed run and a timeout come back as results', async () => {
  const taken = createHerdrApp({ run: fakeRun([[/^hc run/, hcError('usage', 'name "w1" is taken', 2)]]) });
  assert.deepEqual(await taken.agentStart({ name: 'w1', kind: 'claude' }), { ok: false, pane: null, code: 'usage', message: 'name "w1" is taken' });
  const slow = createHerdrApp({ run: fakeRun([[/^hc run/, out({ address: 't4' })], [/^hc wait/, out({ ended: false, reason: 'timeout', status: null })]]) });
  const res = await slow.agentStart({ name: 'w2', kind: 'kimi', timeoutMs: 5000 });
  assert.equal(res.ok, false);
  assert.match(res.message, /did not report ready within 5s/);
});

test('agentList maps named live terminals to agents', async () => {
  const run = fakeRun([ls([
    { address: 't3', agent: 'powershell.exe', cwd: '/home', state: 'live' },
    { address: 't7', name: 'w1', agent: 'claude-code', cwd: '/wt/w1', state: 'live', status: 'working' },
    { address: 't8', name: 'w2', cwd: '/wt/w2', state: 'live' },
  ])]);
  const herdr = createHerdrApp({ run });
  assert.deepEqual(await herdr.agentList(), [
    { name: 'w1', pane_id: 't7', agent_status: 'working', cwd: '/wt/w1' },
    { name: 'w2', pane_id: 't8', agent_status: 'unknown', cwd: '/wt/w2' },
  ]);
  assert.deepEqual((await herdr.paneList()).map((p) => p.pane_id), ['t3', 't7', 't8']);
});

test('paneClose kills and removes the terminal; a missing one is pane_not_found', async () => {
  const run = fakeRun([[/^hc kill/, out({ address: 't7', state: 'finished' })], [/^hc rm/, out({ removed: 't7' })]]);
  await createHerdrApp({ run }).paneClose('t7');
  assert.deepEqual(run.calls.map((c) => c.args.slice(0, 1)[0]), ['kill', 'rm']);
  const gone = createHerdrApp({ run: fakeRun([[/^hc kill/, hcError('not_found', 'no terminal "t9"')]]) });
  await assert.rejects(gone.paneClose('t9'), (err) => err instanceof HerdrError && err.code === 'pane_not_found');
});

test('read, prompt and keys use hc read, send and keys', async () => {
  const run = fakeRun([[/^hc read/, { stdout: 'screen\n' }], [/^hc send/, out({ turn: 2 })], [/^hc keys/, out({ status: 'idle' })], [/^hc get/, out({ address: 't7', labels: {} })]]);
  const pauses = [];
  const herdr = createHerdrApp({ run, sleep: async (ms) => { pauses.push(ms); }, platform: 'linux' });
  assert.equal(await herdr.agentRead('w1'), 'screen\n');
  await herdr.agentRead('w1', { lines: 50 });
  await herdr.agentPrompt('w1', '-starts with a dash', { kind: 'claude' });
  await herdr.agentKeys('w1', ['down', 'enter']);
  assert.deepEqual(run.calls.map((c) => c.args), [
    ['read', '--lines', '0', 'w1'],
    ['read', '--lines', '50', 'w1'],
    // Before the message: does a notice or a modal hold the agent? (clearForPrompt)
    ['read', '--lines', '0', 'w1'],
    ['send', '--json', 'w1', '--', '-starts with a dash'],
    // After a message or keys: did foreman pin this terminal? (see answered)
    ['get', '--json', 'w1'],
    // The send did not say the agent started: hc's status, then the screen.
    ['get', '--json', 'w1'],
    ['read', '--lines', '0', 'w1'],
    ['keys', '--json', 'w1', 'down'],
    ['keys', '--json', 'w1', 'enter'],
    ['get', '--json', 'w1'],
  ]);
  assert.deepEqual(pauses, [500, 150]);
});

test('a refused send becomes an error with hc kind', async () => {
  const herdr = createHerdrApp({ run: fakeRun([[/^hc send/, hcError('blocked', 'w1 is waiting for a person', 9)]]) });
  await assert.rejects(herdr.agentPrompt('w1', 'go'), (err) => err.code === 'blocked');
});

test('here reads the space and tab labels of a terminal', async () => {
  const run = fakeRun([
    [/^hc get --json t3/, out({ address: 't3', labels: { 'herdr.space': 'spA', 'herdr.tab': 'tbB' } })],
    [/^hc get --json t4/, out({ address: 't4', labels: {} })],
  ]);
  const herdr = createHerdrApp({ run });
  assert.deepEqual(await herdr.here('t3'), { space: 'spA', tab: 'tbB' });
  assert.equal(await herdr.here('t4'), null);
});

test('workspaceCreate and tabCreate only make fresh ids', async () => {
  const run = fakeRun([]);
  const herdr = createHerdrApp({ run, newId: ids() });
  assert.deepEqual(await herdr.workspaceCreate({ cwd: '/r' }), { workspaceId: 'sp1', tabId: 'tb2', paneId: null });
  assert.deepEqual(await herdr.tabCreate({ workspaceId: 'spX' }), { workspaceId: 'spX', tabId: 'tb3', paneId: null });
  assert.equal(run.calls.length, 0);
});

test('appRunning is false when the window is closed or herdr-app is missing', async () => {
  assert.equal(await createHerdrApp({ run: fakeRun({ 'herdr-app status': { code: 2 } }) }).appRunning(), false);
  assert.equal(await createHerdrApp({ run: fakeRun([]) }).appRunning(), false);
  assert.equal(await createHerdrApp({ run: fakeRun({ 'herdr-app status': { code: 0 } }) }).appRunning(), true);
});

test('agentStart names a worker that needs the person in its tab and brings the tab forward', async () => {
  const run = fakeRun([
    [/^hc run/, out({ address: 't3' })],
    [/^hc wait/, out({ ended: true, reason: 'status', status: 'blocked' })],
    [/^herdr-app do/, { code: 0 }],
  ]);
  await createHerdrApp({ run }).agentStart({ name: 'w2', kind: 'agy', cwd: '/wt', tab: 'tb1', label: 'foreman:x' });
  const dos = run.calls.filter((c) => c.cmd === 'herdr-app').map((c) => c.args.slice(1));
  assert.deepEqual(dos, [
    ['tab.rename', JSON.stringify({ id: 'tb1', name: '⚠ w2 needs you · foreman:x' })],
    ['tab.select', JSON.stringify({ id: 'tb1' })],
  ]);
});

test('agentStart keeps the warning in the tab when a later worker of that tab is ready', async () => {
  const run = fakeRun([
    [/^hc run/, out({ address: 't3' })],
    [/^hc wait/, () => out({ ended: true, reason: 'status', status: run.calls.filter((c) => c.args[0] === 'wait').length === 1 ? 'blocked' : 'idle' })],
    [/^herdr-app do/, { code: 0 }],
  ]);
  const herdr = createHerdrApp({ run });
  await herdr.agentStart({ name: 'w1', kind: 'agy', tab: 'tb1', label: 'foreman:x' });
  const before = run.calls.length;
  const ok = await herdr.agentStart({ name: 'w2', kind: 'claude', tab: 'tb1', label: 'foreman:x', focus: true });
  assert.equal(ok.ok, true);
  assert.equal(run.calls.slice(before).filter((c) => c.cmd === 'herdr-app').length, 0);
});

test('agentPrompt for claude presses enter once when the prompt is still in the input', async () => {
  const run = fakeRun([[/^hc send/, out({ turn: 1 })], [/^hc read/, { stdout: 'x\n> hello there\n' }], [/^hc keys/, out({})]]);
  await createHerdrApp({ run, sleep: async () => {}, platform: 'linux' }).agentPrompt('w1', 'hello there', { kind: 'claude' });
  assert.deepEqual(run.calls.map((c) => c.args[0]), ['read', 'send', 'get', 'get', 'read', 'keys']);
  // On Windows the input is read twice, 300 ms apart, before enter is pressed.
  const win = fakeRun([[/^hc send/, out({ turn: 1 })], [/^hc read/, { stdout: 'x\n> hello there\n' }], [/^hc keys/, out({})]]);
  await createHerdrApp({ run: win, sleep: async () => {}, platform: 'win32' }).agentPrompt('w1', 'hello there', { kind: 'claude' });
  assert.deepEqual(win.calls.map((c) => c.args[0]), ['read', 'send', 'get', 'get', 'read', 'read', 'keys']);
});

test('agentPrompt trusts hc when the send says the agent started, and reads hc get\'s status record', async () => {
  const started = fakeRun([[/^hc send/, out({ turn: 1, started: true, status: 'idle' })], [/^hc get/, out({ address: 't1', labels: {} })]]);
  assert.deepEqual(await createHerdrApp({ run: started, sleep: async () => {} }).agentPrompt('w1', 'go', { kind: 'codex' }), { submitted: true });
  assert.deepEqual(started.calls.map((c) => c.args[0]), ['read', 'send', 'get']);
  // started false: the screen is checked; `hc get` gives the status as a record.
  const working = fakeRun([
    [/^hc send/, out({ turn: 1, started: false })],
    [/^hc get/, out({ address: 't1', labels: {}, turn: 1, status: { app: 'codex', state: 'working' } })],
    [/^hc read/, { stdout: '› go' }], [/^hc keys/, out({})],
  ]);
  assert.deepEqual(await createHerdrApp({ run: working, sleep: async () => {}, platform: 'linux' }).agentPrompt('w1', 'go', { kind: 'codex' }), { submitted: true });
  assert.equal(working.calls.filter((c) => c.args[0] === 'keys').length, 0);
  // A turn past the send's: it was worked on, even though it is idle again.
  const ended = fakeRun([
    [/^hc send/, out({ turn: 4, started: null })],
    [/^hc get/, out({ address: 't1', labels: {}, turn: 5, status: { app: 'codex', state: 'error', msg: 'model not supported' } })],
    [/^hc read/, { stdout: '› go' }], [/^hc keys/, out({})],
  ]);
  assert.deepEqual(await createHerdrApp({ run: ended, sleep: async () => {}, platform: 'linux' }).agentPrompt('w1', 'go', { kind: 'codex' }), { submitted: true });
  assert.equal(ended.calls.filter((c) => c.args[0] === 'keys').length, 0);
});

test('agentStart: an error the agent reports is said in its words, and nobody is called for it', async () => {
  const run = fakeRun([
    [/^hc run/, out({ address: 't78' })],
    [/^hc wait/, out({ ended: true, reason: 'status', status: 'error', terminal: 't78' })],
    [/^hc get/, out({ address: 't78', status: { app: 'codex', state: 'error', msg: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." } })],
    [/^herdr-app do/, { code: 0 }],
    [/^hc label/, out({})],
  ]);
  const res = await createHerdrApp({ run }).agentStart({ name: 'cx1', kind: 'codex', cwd: '/wt', tab: 'tb1', label: 'foreman:x' });
  assert.deepEqual(res, { ok: false, pane: 't78', code: 'agent_error', message: "codex reported an error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." });
  assert.equal(run.calls.some((c) => c.line.startsWith('hc label')), false);
  const dos = run.calls.filter((c) => c.cmd === 'herdr-app').map((c) => c.args.slice(1));
  assert.deepEqual(dos, [['tab.rename', JSON.stringify({ id: 'tb1', name: 'foreman:x' })]]);
});

test('agentStart says what a blocked agent asks when hc knows', async () => {
  const run = fakeRun([
    [/^hc run/, out({ address: 't3' })],
    [/^hc wait/, out({ ended: true, reason: 'status', status: 'blocked' })],
    [/^hc get/, out({ address: 't3', status: { app: 'claude', state: 'blocked', kind: 'permission' } })],
  ]);
  const res = await createHerdrApp({ run }).agentStart({ name: 'w1', kind: 'claude', cwd: '/wt' });
  assert.deepEqual(res, { ok: false, pane: 't3', code: 'agent_not_ready', message: 'claude is waiting for an answer (permission)' });
});

// A window showing the leader t1 (pane pL) alone in tab tbA, or more terminals.
function appWindow({ status = 0, keep = true, others = [], shown = [] } = {}) {
  const tabs = [{ id: 'tbA', terminals: [{ terminal: 't1', pane: 'pL' }, ...others] }];
  return fakeRun([
    [/^herdr-app status/, { code: status }],
    [/^herdr-app ls/, () => out({ spaces: [{ id: 'spA', tabs: [...tabs, { id: 'tbN', terminals: shown }] }] })],
    [/^herdr-app do terminal\.keep/, (cmd, args) => (keep ? out({ pane: `p${JSON.parse(args[2]).terminal}` }) : { code: 1, stdout: '{"error":"no window"}' })],
    [/^herdr-app do/, out({ ok: true })],
    [/^hc run/, (cmd, args) => out({ address: `t${args[args.indexOf('--name') + 1]}` })],
    [/^hc label/, out({})],
    [/^hc wait/, out({ ended: true, status: 'idle' })],
  ]);
}
const appDos = (run) => run.calls.filter((c) => c.cmd === 'herdr-app' && c.args[0] === 'do').map((c) => [c.args[1], JSON.parse(c.args[2])]);
const startAll = (herdr, stack, names, place = { space: 'spA', tab: 'tbA' }) => Promise.all(names.map((name, index) => herdr.agentStart({ name, kind: 'claude', ...place, stack, index })));

test('stackLayout stacks workers right of the leader, equal heights, leader at 40%', async () => {
  const run = appWindow();
  const herdr = createHerdrApp({ run, sleep: async () => {} });
  const stack = await herdr.stackLayout({ leader: 't1', space: 'spA', tab: 'tbA', count: 3 });
  const res = await startAll(herdr, stack, ['w0', 'w1', 'w2']);
  assert.deepEqual(res.map((r) => r.ok), [true, true, true]);
  // Hidden at start: no herdr.space / herdr.tab labels.
  for (const c of run.calls.filter((x) => x.line.startsWith('hc run'))) assert.ok(!c.args.some((a) => a.startsWith('herdr.')));
  const dos = appDos(run);
  assert.deepEqual(dos.slice(0, 6), [
    ['pane.focus', { terminal: 't1' }], ['terminal.keep', { terminal: 'tw0', place: 'right' }],
    ['pane.focus', { terminal: 'tw0' }], ['terminal.keep', { terminal: 'tw1', place: 'down' }],
    ['pane.focus', { terminal: 'tw1' }], ['terminal.keep', { terminal: 'tw2', place: 'down' }],
  ]);
  assert.deepEqual(dos.slice(6, 9), ['ptw0', 'ptw1', 'ptw2'].map((id) => ['layout.resize', { id, weight: 1 }]));
  assert.equal(dos[9][0], 'layout.resize');
  assert.equal(dos[9][1].id, 'pL');
  assert.ok(Math.abs(dos[9][1].weight - 1 / 3) < 1e-9);
  assert.deepEqual(dos.at(-1), ['pane.focus', { terminal: 't1' }]);
});

test('stackLayout: a worker the window cannot keep gets the labels instead', async () => {
  const run = appWindow({ keep: false });
  const herdr = createHerdrApp({ run, sleep: async () => {} });
  const stack = await herdr.stackLayout({ leader: 't1', space: 'spA', tab: 'tbA', count: 2 });
  await startAll(herdr, stack, ['w0', 'w1']);
  const labels = run.calls.filter((c) => c.line.startsWith('hc label')).map((c) => c.args);
  assert.deepEqual(labels, [
    ['label', '--json', 'tw0', 'herdr.space=spA', 'herdr.tab=tbA'],
    ['label', '--json', 'tw1', 'herdr.space=spA', 'herdr.tab=tbA'],
  ]);
});

test('stackLayout: a worker that did not start leaves the rest placed', async () => {
  const run = appWindow();
  const taken = (cmd, args) => cmd === 'hc' && args[0] === 'run' && args.includes('w0');
  const herdr = createHerdrApp({ run: async (cmd, args, opts) => (taken(cmd, args) ? { code: 0, ...hcError('usage', 'taken', 2) } : run(cmd, args, opts)), sleep: async () => {} });
  const stack = await herdr.stackLayout({ leader: 't1', space: 'spA', tab: 'tbA', count: 2 });
  const res = await startAll(herdr, stack, ['w0', 'w1']);
  assert.deepEqual(res.map((r) => r.ok), [false, true]);
  // w1 has no worker above it to go under: shown by its labels.
  assert.ok(run.calls.some((c) => c.line.startsWith('hc label --json tw1')));
});

test('stackLayout is null when the window is closed or does not show the leader', async () => {
  assert.equal(await createHerdrApp({ run: appWindow({ status: 1 }) }).stackLayout({ leader: 't1', space: 'spA', tab: 'tbA', count: 2 }), null);
  assert.equal(await createHerdrApp({ run: appWindow() }).stackLayout({ leader: 't9', space: 'spA', tab: 'tbA', count: 2 }), null);
});

test('stackLayout leaves the leader\'s width alone when it shares its tab', async () => {
  const run = appWindow({ others: [{ terminal: 't5', pane: 'p5' }] });
  const herdr = createHerdrApp({ run, sleep: async () => {} });
  await startAll(herdr, await herdr.stackLayout({ leader: 't1', space: 'spA', tab: 'tbA', count: 1 }), ['w0']);
  assert.ok(!appDos(run).some(([cmd, a]) => cmd === 'layout.resize' && a.id === 'pL'));
});

test('stackLayout in a new tab: the first worker is shown by its labels, the rest kept around it', async () => {
  const run = appWindow({ shown: [{ terminal: 'tw0', pane: 'ptw0' }] });
  const herdr = createHerdrApp({ run, sleep: async () => {} });
  const stack = await herdr.stackLayout({ leader: 't1', space: 'spA', tab: 'tbN', newTab: true, count: 2 });
  await startAll(herdr, stack, ['w0', 'w1'], { space: 'spA', tab: 'tbN', label: 'foreman:x' });
  const runs = run.calls.filter((c) => c.line.startsWith('hc run'));
  assert.ok(runs[0].args.includes('herdr.tab=tbN'));
  assert.ok(!runs[1].args.some((a) => a.startsWith('herdr.')));
  const dos = appDos(run).filter(([cmd]) => cmd !== 'tab.rename');
  assert.deepEqual(dos, [
    ['pane.focus', { terminal: 'tw0' }], ['terminal.keep', { terminal: 'tw1', place: 'down' }],
    ['layout.resize', { id: 'ptw0', weight: 1 }], ['layout.resize', { id: 'ptw1', weight: 1 }],
    ['pane.focus', { terminal: 't1' }],
  ]);
});

test('stackLayout waits until the window knows a just-started terminal before keeping it', async () => {
  const run = appWindow();
  let misses = 0;
  const slept = [];
  const racy = async (cmd, args, opts) => {
    if (cmd === 'herdr-app' && args[1] === 'terminal.keep' && misses < 2) {
      misses++;
      run.calls.push({ cmd, args, opts, line: [cmd, ...args].join(' ') });
      return { code: 1, stdout: JSON.stringify({ error: `no running terminal "${JSON.parse(args[2]).terminal}"` }), stderr: '' };
    }
    return run(cmd, args, opts);
  };
  const herdr = createHerdrApp({ run: racy, sleep: async (ms) => { slept.push(ms); } });
  await startAll(herdr, await herdr.stackLayout({ leader: 't1', space: 'spA', tab: 'tbA', count: 1 }), ['w0']);
  const keeps = appDos(run).filter(([cmd]) => cmd === 'terminal.keep');
  assert.equal(keeps.length, 3);
  assert.deepEqual(slept, [200, 200]);
  assert.ok(!run.calls.some((c) => c.line.startsWith('hc label')));
  assert.ok(appDos(run).some(([cmd, a]) => cmd === 'layout.resize' && a.id === 'pL'));
});

test('stackLayout gives up on an unknown terminal after about 5 s and shows it by its labels', async () => {
  const run = appWindow();
  const racy = async (cmd, args, opts) => (cmd === 'herdr-app' && args[1] === 'terminal.keep'
    ? { code: 1, stdout: '{"error":"no running terminal \\"tw0\\""}', stderr: '' } : run(cmd, args, opts));
  let waited = 0;
  const herdr = createHerdrApp({ run: racy, sleep: async (ms) => { waited += ms; } });
  await startAll(herdr, await herdr.stackLayout({ leader: 't1', space: 'spA', tab: 'tbA', count: 1 }), ['w0']);
  assert.equal(waited, 5000);
  assert.ok(run.calls.some((c) => c.line.startsWith('hc label --json tw0')));
});

// Workers: children of the leader, labelled with their run.
const started = (extra = []) => fakeRun([
  [/^hc run/, out({ address: 't7' })],
  [/^hc wait/, out({ ended: true, reason: 'status', status: 'idle' })],
  [/^herdr-app do/, { code: 0 }],
  ...extra,
]);

test('agentStart makes a worker the leader\'s child that outlives it, with the run in its labels', async () => {
  const run = started();
  await createHerdrApp({ run }).agentStart({
    name: 'w1', kind: 'claude', cwd: '/wt/w1', space: 'sp1', tab: 'tb1', parent: 't3',
    labels: { 'foreman.task': 'fix-login', 'foreman.role': 'worker' },
  });
  assert.deepEqual(run.calls[0].args, [
    'run', '--json', '--bg', '--parent', 't3', '--outlive-parent', '--no-notify', '--name', 'w1', '--cwd', '/wt/w1',
    '--label', 'herdr.space=sp1', '--label', 'herdr.tab=tb1', '--label', 'foreman.name=w1',
    '--label', 'foreman.task=fix-login', '--label', 'foreman.role=worker',
    '--', 'claude',
  ]);
  assert.ok(!run.calls[0].args.includes('--no-parent'));
});

test('agentStart writes the where label only while the desktop window is closed', async () => {
  const where = (run) => run.calls.find((c) => c.line.startsWith('hc run')).args.filter((a) => a.startsWith('where='));
  const closed = started([[/^herdr-app status/, { code: 2 }]]);
  await createHerdrApp({ run: closed }).agentStart({ name: 'w1', kind: 'claude', where: 'shop / fix-login' });
  assert.deepEqual(where(closed), ['where=shop / fix-login']);
  const open = started([[/^herdr-app status/, { code: 0 }]]);
  await createHerdrApp({ run: open }).agentStart({ name: 'w1', kind: 'claude', where: 'shop / fix-login' });
  assert.deepEqual(where(open), []);
  // The caller already knows: the window is not asked again.
  const known = started();
  await createHerdrApp({ run: known }).agentStart({ name: 'w1', kind: 'claude', where: 'shop / fix-login', windowOpen: false });
  assert.deepEqual(where(known), ['where=shop / fix-login']);
  assert.ok(!known.calls.some((c) => c.line.startsWith('herdr-app status')));
  // No where asked for: the window is not asked at all.
  const none = started();
  await createHerdrApp({ run: none }).agentStart({ name: 'w1', kind: 'claude' });
  assert.ok(!none.calls.some((c) => c.line.startsWith('herdr-app status')));
});

const blocked = (extra = []) => fakeRun([
  [/^hc run/, out({ address: 't3' })],
  [/^hc wait/, out({ ended: true, reason: 'status', status: 'blocked' })],
  [/^hc label/, out({})],
  [/^herdr-app do/, { code: 0 }],
  ...extra,
]);
const labelCalls = (run) => run.calls.filter((c) => c.line.startsWith('hc label')).map((c) => c.args.slice(2));
const doCalls = (run) => run.calls.filter((c) => c.cmd === 'herdr-app' && c.args[0] === 'do').map((c) => [c.args[1], JSON.parse(c.args[2])]);

test('a worker that needs the person is pinned for every Herdr client', async () => {
  const run = blocked();
  await createHerdrApp({ run }).agentStart({ name: 'w2', kind: 'agy', cwd: '/wt', tab: 'tb1', label: 'foreman:x' });
  assert.deepEqual(labelCalls(run), [['t3', 'herdr.pinned=1', 'foreman.pinned=1']]);
  // In a shared tab the tab is still brought forward.
  assert.deepEqual(doCalls(run).map(([cmd]) => cmd), ['tab.rename', 'tab.select']);
});

test('a worker that stopped is named in its tab but not pinned', async () => {
  const run = fakeRun([
    [/^hc run/, out({ address: 't3' })],
    [/^hc wait/, out({ ended: true, reason: 'exit', exit_code: 2 })],
    [/^herdr-app do/, { code: 0 }],
  ]);
  await createHerdrApp({ run }).agentStart({ name: 'w2', kind: 'codex', tab: 'tb1', label: 'foreman:x' });
  assert.equal(run.calls.some((c) => c.line.startsWith('hc label')), false);
  assert.deepEqual(doCalls(run)[0], ['tab.rename', { id: 'tb1', name: '✖ w2 stopped · foreman:x' }]);
});

test('in a tab of its own a worker that needs the person renames the tab but does not bring it forward', async () => {
  const run = blocked();
  await createHerdrApp({ run }).agentStart({ name: 'w2', kind: 'agy', cwd: '/wt', space: 'sp1', tab: 'tb7', label: 'w2 · fix-login', ownTab: true });
  assert.deepEqual(doCalls(run), [['tab.rename', { id: 'tb7', name: '⚠ w2 needs you · fix-login' }]]);
  // The pin remembers the title to put back.
  assert.deepEqual(labelCalls(run), [['t3', 'herdr.pinned=1', 'foreman.pinned=w2 · fix-login']]);
});

test('in a tab of its own a ready worker titles its tab and is not pinned', async () => {
  const run = started();
  await createHerdrApp({ run }).agentStart({ name: 'w2', kind: 'claude', space: 'sp1', tab: 'tb7', label: 'w2 · fix-login', ownTab: true });
  assert.deepEqual(doCalls(run), [['tab.rename', { id: 'tb7', name: 'w2 · fix-login' }]]);
  assert.equal(run.calls.some((c) => c.line.startsWith('hc label')), false);
});

test('answered takes foreman\'s pin off and gives a tab of its own its title back', async () => {
  const run = fakeRun([
    [/^hc get --json w2/, out({ address: 't3', labels: { 'herdr.tab': 'tb7', 'herdr.pinned': '1', 'foreman.pinned': 'w2 · fix-login' } })],
    [/^hc get --json w3/, out({ address: 't4', labels: { 'herdr.tab': 'tbA', 'herdr.pinned': '1', 'foreman.pinned': '1' } })],
    [/^hc label/, out({})],
    [/^herdr-app do/, { code: 0 }],
  ]);
  const herdr = createHerdrApp({ run });
  assert.equal(await herdr.answered('w2'), true);
  assert.deepEqual(labelCalls(run), [['t3', 'herdr.pinned=', 'foreman.pinned=']]);
  assert.deepEqual(doCalls(run), [['tab.rename', { id: 'tb7', name: 'w2 · fix-login' }]]);
  // In a shared tab only the pin goes: the title may speak of another worker.
  assert.equal(await herdr.answered('w3'), true);
  assert.equal(doCalls(run).length, 1);
});

test('answered leaves a pin the person set, and an unknown terminal, alone', async () => {
  const run = fakeRun([[/^hc get --json w1/, out({ address: 't5', labels: { 'herdr.pinned': '1' } })], [/^hc get/, hcError('not_found', 'no terminal')]]);
  const herdr = createHerdrApp({ run });
  assert.equal(await herdr.answered('w1'), false);
  assert.equal(await herdr.answered('gone'), false);
  assert.equal(run.calls.some((c) => c.line.startsWith('hc label')), false);
});

test('keys and a delivered message take foreman\'s pin off', async () => {
  const run = fakeRun([
    [/^hc keys/, out({})], [/^hc send/, out({ turn: 1 })], [/^hc read/, { stdout: 'working' }],
    [/^hc get/, out({ address: 't3', labels: { 'herdr.pinned': '1', 'foreman.pinned': '1' } })],
    [/^hc label/, out({})],
  ]);
  const herdr = createHerdrApp({ run, sleep: async () => {} });
  await herdr.agentKeys('w2', ['1']);
  await herdr.agentPrompt('w2', 'go on');
  assert.deepEqual(labelCalls(run), [['t3', 'herdr.pinned=', 'foreman.pinned='], ['t3', 'herdr.pinned=', 'foreman.pinned=']]);
});

test('terminalInfo gives a terminal\'s size and labels, or null', async () => {
  const run = fakeRun([
    [/^hc get --json t3/, out({ address: 't3', cols: 45, rows: 20, labels: { 'foreman.layout': 'tabs' } })],
    [/^hc get/, hcError('not_found', 'no terminal')],
  ]);
  const herdr = createHerdrApp({ run });
  assert.deepEqual(await herdr.terminalInfo('t3'), { cols: 45, rows: 20, labels: { 'foreman.layout': 'tabs' } });
  assert.equal(await herdr.terminalInfo('t9'), null);
});

test('needsPerson pins a worker foreman wait found waiting, and leaves a terminal that is pinned already alone', async () => {
  const run = fakeRun([
    [/^hc get --json w1/, out({ address: 't3', labels: { 'herdr.tab': 'tb7' } })],
    [/^hc get --json w2/, out({ address: 't4', labels: { 'herdr.pinned': '1', 'foreman.pinned': 'w2 · fix-login' } })],
    [/^hc get --json w3/, out({ address: 't5', labels: { 'herdr.pinned': '1' } })],
    [/^hc get/, hcError('not_found', 'no terminal')],
    [/^hc label/, out({})],
  ]);
  const herdr = createHerdrApp({ run });
  assert.equal(await herdr.needsPerson('w1'), true);
  // Pinned at spawn (the tab title to put back stays), pinned by the person, and unknown.
  assert.equal(await herdr.needsPerson('w2'), false);
  assert.equal(await herdr.needsPerson('w3'), false);
  assert.equal(await herdr.needsPerson('gone'), false);
  assert.deepEqual(labelCalls(run), [['t3', 'herdr.pinned=1', 'foreman.pinned=1']]);
  // The pin is foreman's, so an answer takes it off again.
  assert.equal(typeof herdr.answered, 'function');
});

test('agentPrompt for codex presses enter after a settle pause until the prompt leaves the input', async () => {
  let reads = 0;
  const run = fakeRun([
    [/^hc send/, out({ turn: 1 })],
    [/^hc get/, out({ address: 't1', status: 'idle', labels: {} })],
    [/^hc read/, () => ({ stdout: ++reads === 2 ? '› [Pasted Content 1520 chars]\n  100% context left' : '› \n  100% context left' })],
    [/^hc keys/, out({})],
  ]);
  const res = await createHerdrApp({ run, sleep: async () => {}, platform: 'linux' }).agentPrompt('w1', 'x'.repeat(1520), { kind: 'codex' });
  assert.deepEqual(res, { submitted: true });
  assert.equal(run.calls.filter((c) => c.args[0] === 'keys').length, 1);
});

test('agentPrompt for codex leaves an agent hc reports working alone', async () => {
  const run = fakeRun([[/^hc send/, out({ turn: 1 })], [/^hc get/, out({ address: 't1', status: 'working', labels: {} })], [/^hc read/, { stdout: '› go' }], [/^hc keys/, out({})]]);
  const res = await createHerdrApp({ run, sleep: async () => {} }).agentPrompt('w1', 'go', { kind: 'codex' });
  assert.deepEqual(res, { submitted: true });
  assert.equal(run.calls.filter((c) => c.args[0] === 'keys').length, 0);
});

// Live (2026-11-19): opencode sends no status in the app, so hc's wait ran
// the whole timeout and spawn said it might be asking to trust the folder.
test('agentStart calls an agent that reports no status ready once its screen shows an empty input twice', async () => {
  const run = fakeRun([
    [/^hc run/, out({ address: 't7d' })],
    [/^hc wait/, out({ ended: false, reason: 'timeout', status: null, terminal: 't7d' })],
    [/^hc get/, out({ address: 't7d', reported: false, status: null })],
    [/^hc read/, { stdout: OPENCODE_READY }],
    [/^herdr-app do/, { code: 0 }],
  ]);
  const res = await createHerdrApp({ run }).agentStart({ name: 'v2', kind: 'opencode', cwd: '/wt', timeoutMs: 90000 });
  assert.deepEqual(res, { ok: true, pane: 't7d' });
  assert.equal(run.calls.filter((c) => c.args[0] === 'wait').length, 2);
});

test('agentStart ends the wait on a dialog of an agent that reports no status', async () => {
  const run = fakeRun([
    [/^hc run/, out({ address: 't7d' })],
    [/^hc wait/, out({ ended: false, reason: 'timeout', status: null })],
    [/^hc get/, out({ address: 't7d', reported: false, status: null })],
    [/^hc read/, { stdout: OPENCODE_UPDATE_MODAL }],
    [/^hc label/, out({})],
  ]);
  const res = await createHerdrApp({ run }).agentStart({ name: 'v2', kind: 'opencode', cwd: '/wt', timeoutMs: 90000 });
  assert.deepEqual(res, { ok: false, pane: 't7d', code: 'agent_not_ready', message: 'opencode updated itself and must be restarted' });
  assert.equal(run.calls.filter((c) => c.args[0] === 'wait').length, 1);
});

test('agentStart keeps waiting for an agent that reports status, reading its screen only at the end', async () => {
  const run = fakeRun([
    [/^hc run/, out({ address: 't3' })],
    [/^hc wait/, out({ ended: false, reason: 'timeout', status: 'working' })],
    [/^hc get/, out({ address: 't3', reported: true, status: { app: 'claude', state: 'working' } })],
    [/^hc label/, out({})],
  ]);
  const res = await createHerdrApp({ run }).agentStart({ name: 'w1', kind: 'claude', cwd: '/wt', timeoutMs: 12000 });
  // Nothing on its screen asks a question: the message does not guess at a trust dialog.
  assert.deepEqual(res, { ok: false, pane: 't3', code: 'agent_not_ready', message: 'claude did not report ready within 12s; no question is on its screen' });
  assert.deepEqual(run.calls.filter((c) => c.args[0] === 'wait').map((c) => c.args[3]), ['5', '5', '2']);
  assert.equal(run.calls.filter((c) => c.args[0] === 'read').length, 1);
});

test('agentStart: agy\'s auto-mode notice reported as a permission is said to be a notice', async () => {
  const run = fakeRun([
    [/^hc run/, out({ address: 't7f' })],
    [/^hc wait/, out({ ended: true, reason: 'status', status: 'blocked' })],
    [/^hc get/, out({ address: 't7f', status: { app: 'antigravity', state: 'blocked', kind: 'permission' } })],
    [/^hc read/, { stdout: AGY_AUTO_NOTICE }],
    [/^hc label/, out({})],
  ]);
  const res = await createHerdrApp({ run }).agentStart({ name: 'v3', kind: 'agy', cwd: '/wt' });
  assert.deepEqual(res, { ok: false, pane: 't7f', code: 'agent_not_ready', message: 'agy shows a notice (esc closes it)' });
});

test('agentPrompt closes a notice before sending, and sends nothing into opencode\'s restart modal', async () => {
  let reads = 0;
  const notice = fakeRun([
    [/^hc read/, () => ({ stdout: ++reads === 1 ? AGY_AUTO_NOTICE : '> \n? for shortcuts' })],
    [/^hc keys/, out({})], [/^hc send/, out({ turn: 1, started: true })], [/^hc get/, out({ address: 't7f', labels: {} })],
  ]);
  assert.deepEqual(await createHerdrApp({ run: notice, sleep: async () => {} }).agentPrompt('v3', 'go', { kind: 'agy' }), { submitted: true });
  assert.deepEqual(notice.calls.map((c) => c.args.filter((a) => a !== '--json').join(' ')), ['read --lines 0 v3', 'keys v3 esc', 'send v3 -- go', 'get v3']);
  const modal = fakeRun([[/^hc read/, { stdout: OPENCODE_UPDATE_MODAL }], [/^hc send/, out({ turn: 0 })]]);
  assert.deepEqual(await createHerdrApp({ run: modal, sleep: async () => {} }).agentPrompt('v2', 'go', { kind: 'opencode' }), { submitted: false, reason: 'dialog', label: 'opencode updated itself and must be restarted' });
  assert.equal(modal.calls.some((c) => c.args[0] === 'send'), false);
});

// Live (2026-11-19, opencode 1.19.6): spawn waited the whole 90 s although the
// input was on screen. hc's plain screen read gave opencode's rows run together
// in one line, so no line looked like an empty input.
test('agentRead reads opencode\'s run-together screen again with a line of history, which gives its rows', async () => {
  const { OPENCODE_READY_RUN_TOGETHER } = await import('./fixtures/screens.js');
  const { inputEmpty } = await import('../src/herdr.js');
  assert.equal(OPENCODE_READY_RUN_TOGETHER.includes('\n'), false);
  assert.equal(inputEmpty(OPENCODE_READY_RUN_TOGETHER, 10), false);
  const run = fakeRun([
    [/^hc read --lines 0/, { stdout: `${OPENCODE_READY_RUN_TOGETHER}\n` }],
    [/^hc read --lines 1/, { stdout: OPENCODE_READY }],
  ]);
  const herdr = createHerdrApp({ run });
  assert.equal(await herdr.agentRead('t7h'), OPENCODE_READY);
  assert.equal(inputEmpty(await herdr.agentRead('t7h'), 10), true);
  // A short one-line screen, and a read with history, are taken as they come.
  const short = fakeRun([[/^hc read/, { stdout: 'screen\n' }]]);
  assert.equal(await createHerdrApp({ run: short }).agentRead('w1'), 'screen\n');
  assert.equal(short.calls.length, 1);
});

test('agentStart sees opencode ready from its run-together screen at the second check-in', async () => {
  const { OPENCODE_READY_RUN_TOGETHER } = await import('./fixtures/screens.js');
  const run = fakeRun([
    [/^hc run/, out({ address: 't7h' })],
    [/^hc wait/, out({ ended: false, reason: 'timeout', status: null, terminal: 't7h' })],
    [/^hc get/, out({ address: 't7h', reported: false, status: null, turn: 0 })],
    [/^hc read --lines 0/, { stdout: OPENCODE_READY_RUN_TOGETHER }],
    [/^hc read --lines 1/, { stdout: OPENCODE_READY }],
    [/^herdr-app do/, { code: 0 }],
  ]);
  const res = await createHerdrApp({ run }).agentStart({ name: 'v2', kind: 'opencode', cwd: '/wt', timeoutMs: 90000 });
  assert.deepEqual(res, { ok: true, pane: 't7h' });
  assert.equal(run.calls.filter((c) => c.args[0] === 'wait').length, 2);
});

test('agentStart that ran out of time names a trust dialog only when one is on screen', async () => {
  const mk = (screen) => fakeRun([
    [/^hc run/, out({ address: 't3' })],
    [/^hc wait/, out({ ended: false, reason: 'timeout', status: 'working' })],
    [/^hc get/, out({ address: 't3', reported: true })],
    [/^hc read/, { stdout: screen }],
    [/^hc label/, out({})],
  ]);
  const trust = await createHerdrApp({ run: mk('Do you trust the files in this folder?\n ❯ 1. Yes\n   2. No') }).agentStart({ name: 'w1', kind: 'claude', cwd: '/wt', timeoutMs: 5000 });
  assert.equal(trust.message, 'claude did not report ready within 5s; it asks to trust this folder');
  const none = await createHerdrApp({ run: mk('loading...') }).agentStart({ name: 'w1', kind: 'claude', cwd: '/wt', timeoutMs: 5000 });
  assert.equal(none.message, 'claude did not report ready within 5s; no question is on its screen');
});
