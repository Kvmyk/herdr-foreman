import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHerdr, HerdrError } from '../src/herdr.js';
import { fakeRun, json, herdrError } from './helpers.js';

test('serverRunning reads status output', async () => {
  const herdr = createHerdr({ run: fakeRun({ 'herdr status server': { stdout: 'status: running\nversion: 0.9.5\n' } }) });
  assert.equal(await herdr.serverRunning(), true);
  const down = createHerdr({ run: fakeRun({ 'herdr status server': { code: 1, stdout: 'status: not running\n' } }) });
  assert.equal(await down.serverRunning(), false);
});

test('workspaceCreate parses ids', async () => {
  const run = fakeRun([[/^herdr workspace create/, json({
    type: 'workspace_created',
    workspace: { workspace_id: 'w2' },
    tab: { tab_id: 'w2:t1' },
    root_pane: { pane_id: 'w2:p1' },
  })]]);
  const herdr = createHerdr({ run });
  assert.deepEqual(await herdr.workspaceCreate({ cwd: '/repo', label: 'foreman', focus: true }), {
    workspaceId: 'w2', tabId: 'w2:t1', paneId: 'w2:p1',
  });
  assert.deepEqual(run.calls[0].args, ['workspace', 'create', '--cwd', '/repo', '--label', 'foreman', '--focus']);
});

test('tabCreate parses ids', async () => {
  const run = fakeRun([[/^herdr tab create/, json({ type: 'tab_created', tab: { tab_id: 'w1:t3' }, root_pane: { pane_id: 'w1:p9' } })]]);
  const herdr = createHerdr({ run });
  assert.deepEqual(await herdr.tabCreate({ workspaceId: 'w1', cwd: '/r', label: 'foreman', focus: false }), { tabId: 'w1:t3', paneId: 'w1:p9' });
  assert.ok(run.calls[0].args.includes('--no-focus'));
  assert.ok(run.calls[0].args.includes('w1'));
});

test('herdr error becomes HerdrError', async () => {
  const herdr = createHerdr({ run: fakeRun([[/^herdr pane close/, herdrError('pane_not_found', 'no pane')]]) });
  await assert.rejects(herdr.paneClose('w1:p7'), (err) => err instanceof HerdrError && err.code === 'pane_not_found' && err.message === 'no pane');
});

test('non-JSON failure gets herdr_failed code', async () => {
  const herdr = createHerdr({ run: fakeRun([[/^herdr agent list/, { code: 2, stderr: 'boom' }]]) });
  await assert.rejects(herdr.agentList(), (err) => err.code === 'herdr_failed' && /boom/.test(err.message));
});

test('agentStart returns not ready instead of throwing', async () => {
  const herdr = createHerdr({ run: fakeRun([[/^herdr agent start/, herdrError('agent_not_ready', 'trust prompt')]]) });
  assert.deepEqual(await herdr.agentStart({ name: 'w1', kind: 'claude', pane: 'w1:p2' }), {
    ok: false, code: 'agent_not_ready', message: 'trust prompt',
  });
});

test('agentStart passes agent args after --', async () => {
  const run = fakeRun([[/^herdr agent start/, json({ type: 'agent_started', agent: {}, argv: [] })]]);
  const herdr = createHerdr({ run });
  assert.deepEqual(await herdr.agentStart({ name: 'w1', kind: 'opencode', pane: 'w1:p2', timeoutMs: 90000, args: ['--model', 'x/y'] }), { ok: true });
  assert.deepEqual(run.calls[0].args, ['agent', 'start', 'w1', '--kind', 'opencode', '--pane', 'w1:p2', '--timeout', '90000', '--', '--model', 'x/y']);
});

test('paneSplit formats ratio with dot and returns pane id', async () => {
  const run = fakeRun([[/^herdr pane split/, json({ type: 'pane_split', pane: { pane_id: 'w1:p4' } })]]);
  const herdr = createHerdr({ run });
  assert.equal(await herdr.paneSplit({ pane: 'w1:p1', direction: 'down', ratio: 1 / 3, cwd: '/wt' }), 'w1:p4');
  assert.ok(run.calls[0].line.includes('--ratio 0.3333'));
  assert.ok(run.calls[0].args.includes('--no-focus'));
});

test('agentList returns agents', async () => {
  const herdr = createHerdr({ run: fakeRun([[/^herdr agent list/, json({ type: 'agent_list', agents: [{ name: 'lead' }] })]]) });
  assert.deepEqual(await herdr.agentList(), [{ name: 'lead' }]);
});

test('agentRead returns the plain screen text', async () => {
  const run = fakeRun([[/^herdr agent read w1 --source visible/, { stdout: 'line 1\nline 2\n' }]]);
  const herdr = createHerdr({ run });
  assert.equal(await herdr.agentRead('w1'), 'line 1\nline 2\n');
});

test('paneList returns panes', async () => {
  const herdr = createHerdr({ run: fakeRun([[/^herdr pane list/, json({ type: 'pane_list', panes: [{ pane_id: 'w1:p1' }] })]]) });
  assert.deepEqual(await herdr.paneList(), [{ pane_id: 'w1:p1' }]);
});

test('agentRead with lines reads recent output', async () => {
  const run = fakeRun([[/^herdr agent read/, { stdout: 'x\n' }]]);
  await createHerdr({ run }).agentRead('w1', { lines: 40 });
  assert.deepEqual(run.calls[0].args, ['agent', 'read', 'w1', '--source', 'recent', '--lines', '40']);
});

test('agentKeys sends keys one at a time with a pause', async () => {
  const run = fakeRun([[/^herdr agent send-keys/, json({ type: 'ok' })]]);
  const events = [];
  const inner = run;
  const logged = async (...a) => { events.push(a[1].join(' ')); return inner(...a); };
  logged.calls = inner.calls;
  await createHerdr({ run: logged, sleep: async (ms) => { events.push(`sleep ${ms}`); } }).agentKeys('w1', ['down', 'enter']);
  assert.deepEqual(events, ['agent send-keys w1 down', 'sleep 150', 'agent send-keys w1 enter']);
});

test('agentPrompt presses enter once when the prompt is still in the input', async () => {
  const mk = (screen) => fakeRun([[/^herdr agent prompt/, json({ type: 'ok' })], [/^herdr agent send-keys/, json({ type: 'ok' })], [/^herdr agent read/, { code: 0, stdout: screen }]]);
  const stuck = mk('some output\n> fix the login bug please\n  ? for shortcuts');
  await createHerdr({ run: stuck, sleep: async () => {} }).agentPrompt('w1', 'fix the login bug please');
  assert.deepEqual(stuck.calls.filter((c) => c.args[1] === 'send-keys').map((c) => c.args), [['agent', 'send-keys', 'w1', 'enter']]);
  const sent = mk('working...\n> \n');
  await createHerdr({ run: sent, sleep: async () => {} }).agentPrompt('w1', 'fix the login bug please');
  assert.equal(sent.calls.filter((c) => c.args[1] === 'send-keys').length, 0);
});
