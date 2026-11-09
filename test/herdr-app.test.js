import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHerdrApp } from '../src/herdr-app.js';
import { HerdrError } from '../src/herdr.js';
import { fakeRun } from './helpers.js';

const out = (body) => ({ stdout: JSON.stringify(body) });
const hcError = (kind, message, code = 3) => ({ code, stderr: JSON.stringify({ error: { kind, message, hint: '' } }) });
const ids = () => {
  let n = 0;
  return (prefix) => `${prefix}${++n}`;
};
const ls = (terminals) => [/^hc ls/, out({ hidden_finished: 0, terminals })];

test('agentStart runs the agent with labels, no parent, and waits until it is ready', async () => {
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
  assert.deepEqual(run.calls[1].args, ['wait', '--json', '--timeout', '60', 't7']);
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
  const run = fakeRun([[/^hc read/, { stdout: 'screen\n' }], [/^hc send/, out({ turn: 2 })], [/^hc keys/, out({ status: 'idle' })]]);
  const pauses = [];
  const herdr = createHerdrApp({ run, sleep: async (ms) => { pauses.push(ms); } });
  assert.equal(await herdr.agentRead('w1'), 'screen\n');
  await herdr.agentRead('w1', { lines: 50 });
  await herdr.agentPrompt('w1', '-starts with a dash');
  await herdr.agentKeys('w1', ['down', 'enter']);
  assert.deepEqual(run.calls.map((c) => c.args), [
    ['read', '--lines', '0', 'w1'],
    ['read', '--lines', '50', 'w1'],
    ['send', '--json', 'w1', '--', '-starts with a dash'],
    ['read', '--lines', '0', 'w1'],
    ['keys', '--json', 'w1', 'down'],
    ['keys', '--json', 'w1', 'enter'],
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

test('agentPrompt presses enter once when the prompt is still in the input', async () => {
  const run = fakeRun([[/^hc send/, out({ turn: 1 })], [/^hc read/, { stdout: 'x\n> hello there\n' }], [/^hc keys/, out({})]]);
  await createHerdrApp({ run, sleep: async () => {} }).agentPrompt('w1', 'hello there');
  assert.deepEqual(run.calls.map((c) => c.args[0]), ['send', 'read', 'keys']);
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
