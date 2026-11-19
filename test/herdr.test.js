import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHerdr, HerdrError, promptStuck, submitIfStuck, checkSubmit, clearForPrompt, STABLE_MS } from '../src/herdr.js';
import { OPENCODE_UPDATE_MODAL, OPENCODE_READY, AGY_AUTO_NOTICE } from './fixtures/screens.js';
import { submitStrategy } from '../src/inventory/kinds.js';
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

test('agentPrompt for claude presses enter once when the prompt is still in the input', async () => {
  const mk = (screen) => fakeRun([[/^herdr agent prompt/, json({ type: 'ok' })], [/^herdr agent send-keys/, json({ type: 'ok' })], [/^herdr agent read/, { code: 0, stdout: screen }]]);
  const stuck = mk('some output\n> fix the login bug please\n  ? for shortcuts');
  await createHerdr({ run: stuck, sleep: async () => {} }).agentPrompt('w1', 'fix the login bug please', { kind: 'claude' });
  assert.deepEqual(stuck.calls.filter((c) => c.args[1] === 'send-keys').map((c) => c.args), [['agent', 'send-keys', 'w1', 'enter']]);
  const sent = mk('working...\n> \n');
  await createHerdr({ run: sent, sleep: async () => {} }).agentPrompt('w1', 'fix the login bug please', { kind: 'claude' });
  assert.equal(sent.calls.filter((c) => c.args[1] === 'send-keys').length, 0);
});

const LONG = 'You are the foreman leader for task "fix-login". Read /home/u/.foreman/instructions.md and follow it exactly. The user\'s task: fix the login bug on the settings page and add a test.';

test('promptStuck finds a long prompt wrapped in an input box above footer lines', () => {
  const codex = [
    '› You are the foreman leader for task "fix-login". Read /home/u/.foreman/instruc',
    '  tions.md and follow it exactly. The user\'s task: fix the login bug on the setti',
    '  ngs page and add a test.',
    '',
    '  ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit',
    '  100% context left',
  ].join('\n');
  assert.equal(promptStuck(codex, LONG), true);
  const box = '╭──────────╮\n│ > You are the foreman leader for task "fix-l │\n│ ogin". Read /home/u/.foreman/instructions.md │\n╰──────────╯\n  ctrl+p commands';
  assert.equal(promptStuck(box, LONG), true);
  // hc wraps a message in an <hc> envelope.
  assert.equal(promptStuck('› <hc from="t70 lead">You are the foreman leader for task "fix-login". Read</hc>\n  footer', LONG), true);
  assert.equal(promptStuck('• Working (3s • esc to interrupt)\n\n› \n  100% context left', LONG), false);
});

test('promptStuck sees the paste placeholders agents show instead of the text', () => {
  for (const shown of ['[Pasted Content 1520 chars]', '[Pasted ~12 lines]', '[paste #1 +12 lines]', '[Pasted Text: 12 lines]', '[Pasted text #1 +20 lines]']) {
    assert.equal(promptStuck(`output\n> ${shown}\n  footer`, 'line one\nline two'), true, shown);
  }
});

test('submitStrategy: claude keeps one checked press, other kinds press enter and retry', () => {
  const claude = submitStrategy('claude');
  assert.deepEqual({ ...claude, delays: [...claude.delays] }, { mode: 'check', delays: [500], lines: 3, verify: false, wait: false });
  for (const kind of ['codex', 'opencode', 'pi', 'agy', 'gemini']) {
    assert.equal(submitStrategy(kind).mode, 'enter', kind);
    assert.equal(submitStrategy(kind).delays.length, 3);
    assert.equal(submitStrategy(kind).verify, true);
  }
  assert.equal(submitStrategy(null).mode, 'check');
});

// A screen that changes with each read; the last one stays.
function screens(...list) {
  let i = 0;
  return async () => list[Math.min(i++, list.length - 1)];
}

test('submitIfStuck presses enter while the prompt sits in the input, with growing pauses', async () => {
  const pauses = [];
  let presses = 0;
  const ok = await submitIfStuck({ read: screens('> [Pasted ~3 lines]\n  footer'), press: async () => { presses++; }, sleep: async (ms) => { pauses.push(ms); }, text: 'a\nb\nc', kind: 'codex', platform: 'linux' });
  assert.equal(ok, false);
  assert.equal(presses, 3);
  assert.deepEqual(pauses, [500, 1000, 2000, 2000]);
});

test('submitIfStuck never presses blindly: no text and no sign either way is unknown', async () => {
  let presses = 0;
  const press = async () => { presses++; };
  // An empty input is a sign the prompt went in only after the text was seen there.
  assert.equal(await submitIfStuck({ read: screens(`> ${LONG}\n  footer`, '> \n  footer'), press, sleep: async () => {}, text: LONG, kind: 'pi', platform: 'linux' }), true);
  assert.equal(await submitIfStuck({ read: screens(`│ ❯ ${LONG} │`, '│ ❯  │\n  footer'), press, sleep: async () => {}, text: LONG, kind: null, platform: 'linux' }), true);
  presses = 0;
  // Never seen, and the input stays empty: the paste was lost.
  assert.deepEqual(await checkSubmit({ read: screens('> \n  footer'), press, sleep: async () => {}, text: LONG, kind: 'pi', platform: 'linux' }), { submitted: false, reason: 'lost' });
  assert.equal(await submitIfStuck({ read: screens('│ ❯  │\n  footer'), press, sleep: async () => {}, text: LONG, kind: null, platform: 'linux' }), false);
  // Neither the text nor an empty input: the screen cannot tell.
  assert.equal(await submitIfStuck({ read: screens('some output\n  footer'), press, sleep: async () => {}, text: LONG, kind: 'pi', platform: 'linux' }), null);
  assert.equal(await submitIfStuck({ read: async () => { throw new Error('gone'); }, press, sleep: async () => {}, text: LONG, kind: 'codex', platform: 'linux' }), null);
  assert.equal(presses, 0);
});

test('submitIfStuck stops once the text is gone after a press', async () => {
  let presses = 0;
  const ok = await submitIfStuck({ read: screens(`> ${LONG}`, `> ${LONG}`, '> \n  footer'), press: async () => { presses++; }, sleep: async () => {}, text: LONG, kind: 'opencode', platform: 'linux' });
  assert.equal(ok, true);
  assert.equal(presses, 2);
});

test('submitIfStuck does not press while the agent works, or into a dialog', async () => {
  let presses = 0;
  const press = async () => { presses++; };
  const go = (opts) => submitIfStuck({ press, sleep: async () => {}, text: LONG, kind: 'codex', platform: 'linux', ...opts });
  assert.equal(await go({ read: screens(`> ${LONG}\n• Working (1s • esc to interrupt)`) }), true);
  assert.equal(await go({ read: screens(`> ${LONG}`), status: async () => 'working' }), true);
  assert.equal(await go({ read: screens(`> ${LONG}`), status: async () => ({ state: 'blocked', turn: 3 }) }), true);
  // A turn that ended after the send: the prompt was worked on.
  assert.equal(await go({ read: screens(`> ${LONG}`), status: async () => ({ state: 'idle', turn: 4 }), turn: 3 }), true);
  assert.equal(await go({ read: screens(`> ${LONG}\nAllow command git status? (y/n)`) }), false);
  assert.equal(presses, 0);
  // Dialog words in the prompt itself are not a dialog.
  const text = 'Do not ask for permission; approve nothing. Then log in.';
  assert.equal(await go({ read: screens(`> ${text}\n  footer`, '> \n  footer'), text }), true);
  assert.equal(presses, 1);
});

test('a failed press is unknown, not success', async () => {
  const ok = await submitIfStuck({ read: screens(`> ${LONG}`), press: async () => { throw new Error('timeout'); }, sleep: async () => {}, text: LONG, kind: 'codex', platform: 'linux' });
  assert.equal(ok, null);
});

// Captured in the Herdr app (2026-11-19): claude working in auto mode; the
// prompt went in, but the update banner read as a dialog and the cut-short
// "esc to inte…" was not seen as work, so the prompt was reported unsent.
const CLAUDE_AUTO_SCREEN = [
  '● Reading src/herdr.js',
  '✽ Noodling… (3m 23s · ↓ 13.8k tokens)',
  '   Update available! Run: winget upgrade Anthropic.C…',
  '───────────────────────────────────────────────────────',
  '❯ ',
  '───────────────────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to inte…',
].join('\n');

test('submitIfStuck: claude in auto mode under an update banner is working, not in a dialog', async () => {
  let presses = 0;
  for (const platform of ['win32', 'linux']) {
    const ok = await submitIfStuck({ read: screens(CLAUDE_AUTO_SCREEN), press: async () => { presses++; }, sleep: async () => {}, text: 'You are worker sub1 for foreman. Your part: find why prompts are not submitted.', kind: 'claude', platform });
    assert.equal(ok, true, platform);
  }
  assert.equal(presses, 0);
});

// Captured in the Herdr app (2026-11-19): a brief to codex 0.170 in a pane 27
// columns wide. On Windows codex gets no bracketed paste, so it shows the raw
// text and hc's closing </hc>; the start of the brief has scrolled away.
const BRIEF = "You are worker cx1 for foreman. Your part: look at how codex starts. Context: the user reports that prompts stay in the input. Tests: npm test (node --test). Investigate only: do not modify, create or delete repository files and do not commit. Do not touch anything outside your worktree, do not push, do not create pull requests. Write at most 10 proposals to .foreman/proposals.md in your worktree, one line each: '- [high|medium|low] <file>: <problem> -> <proposed change>'. Find the real root cause, not another retry. Reply only DONE when finished.";
const CODEX_NARROW_STUCK = [
  '  anything outside your',
  '  worktree, do not push,',
  '  do not create pull',
  '  requests. Write at most',
  '  10 proposals',
  '  to .foreman/proposals.md',
  '  in your worktree, one',
  "  line each: '- [high|",
  '  medium|low] <file>:',
  '  <problem> -> <proposed',
  "  change>'. Find the real",
  '  root cause, not another',
  '  retry. Reply only DONE',
  '  when finished.</hc>',
  '',
  '  gpt-5.5 medium ·',
  '  ~\\.herdr-',
  '  foreman\\worktrees\\herdr-…',
  '  ← for agents    ⚠ 1 · f2',
].join('\n');
// The same pane while codex is still taking in the keys of the paste: the
// end is not drawn yet.
const CODEX_NARROW_TYPING = CODEX_NARROW_STUCK.split('\n').filter((l) => !/Reply only|finished/.test(l)).join('\n');
const CODEX_EMPTY = '› Ask Codex to do anything\n\n  gpt-5.5 medium ·\n  ← for agents';

test('promptStuck finds a wrapped prompt in a narrow pane by any part of it, with the raw </hc>', () => {
  assert.equal(promptStuck(CODEX_NARROW_STUCK, BRIEF), true);
  // Neither the first nor the last 30 characters are on the last lines here.
  assert.equal(promptStuck(CODEX_NARROW_TYPING, BRIEF), true);
  assert.equal(promptStuck(CODEX_EMPTY, BRIEF), false);
});

test('submitIfStuck on Windows presses only once the input has settled with the prompt\'s end in it', async () => {
  let presses = 0;
  const pauses = [];
  const ok = await submitIfStuck({
    read: screens(CODEX_NARROW_TYPING, CODEX_NARROW_STUCK, CODEX_NARROW_STUCK, CODEX_NARROW_STUCK, CODEX_EMPTY),
    press: async () => { presses++; }, sleep: async (ms) => { pauses.push(ms); }, text: BRIEF, kind: 'codex', platform: 'win32',
  });
  assert.equal(ok, true);
  assert.equal(presses, 1);
  // Typing (no press), then stuck and still the same 300 ms later: one press, then the input is empty.
  assert.deepEqual(pauses, [500, STABLE_MS, 1000, STABLE_MS, 2000]);
});

test('submitIfStuck reports a prompt still being typed in as not submitted, never as sent', async () => {
  let presses = 0;
  const ok = await submitIfStuck({ read: screens(CODEX_NARROW_TYPING, CODEX_NARROW_STUCK), press: async () => { presses++; }, sleep: async () => {}, text: BRIEF, kind: 'codex', platform: 'win32' });
  assert.equal(ok, false);
  assert.ok(presses >= 1);
});

test('agentPrompt for codex lets herdr wait until the agent works', async () => {
  const run = fakeRun([[/^herdr agent prompt/, json({ type: 'ok', agent_status: 'working' })]]);
  const res = await createHerdr({ run, sleep: async () => {} }).agentPrompt('w1', 'go', { kind: 'codex' });
  assert.deepEqual(res, { submitted: true });
  // Before it, a look whether a notice or a modal holds the agent (no screen here: it goes ahead).
  assert.deepEqual(run.calls.map((c) => c.args), [['agent', 'read', 'w1', '--source', 'visible'], ['agent', 'prompt', 'w1', 'go', '--wait', '--until', 'working', '--until', 'blocked', '--timeout', '6000']]);
});

test('agentPrompt for codex presses enter when herdr says the prompt stalled', async () => {
  const run = fakeRun([
    [/^herdr agent prompt/, herdrError('agent_prompt_stalled', 'no working state')],
    [/^herdr agent read/, { stdout: `> ${LONG}\n  footer` }],
    [/^herdr agent send-keys/, json({ type: 'ok' })],
  ]);
  const res = await createHerdr({ run, sleep: async () => {} }).agentPrompt('w1', LONG, { kind: 'codex' });
  assert.deepEqual(res, { submitted: false });
  assert.equal(run.calls.filter((c) => c.args[1] === 'send-keys').length, 3);
  const refused = fakeRun([[/^herdr agent prompt/, herdrError('agent_blocked', 'blocked')]]);
  await assert.rejects(createHerdr({ run: refused, sleep: async () => {} }).agentPrompt('w1', 'go', { kind: 'codex' }), (err) => err.code === 'agent_blocked');
});

test('agentPrompt asks herdr for the agent status before pressing enter', async () => {
  const run = fakeRun([
    [/^herdr agent prompt/, herdrError('timeout', 'no answer')],
    [/^herdr agent list/, json({ type: 'agent_list', agents: [{ name: 'w1', pane_id: 'p1', agent_status: 'working' }] })],
    [/^herdr agent read/, { stdout: `> ${LONG}\n  footer` }],
    [/^herdr agent send-keys/, json({ type: 'ok' })],
  ]);
  const res = await createHerdr({ run, sleep: async () => {}, platform: 'linux' }).agentPrompt('w1', LONG, { kind: 'codex' });
  assert.deepEqual(res, { submitted: true });
  assert.equal(run.calls.filter((c) => c.args[1] === 'send-keys').length, 0);
});

// Live (2026-11-19): `foreman prompt` to opencode said "sent" because its
// empty input placeholder showed, though the text never reached the input.
test('checkSubmit: an empty opencode input with the text never seen is a lost prompt, not a sent one', async () => {
  let presses = 0;
  const res = await checkSubmit({ read: screens(OPENCODE_READY), press: async () => { presses++; }, sleep: async () => {}, text: BRIEF, kind: 'opencode', platform: 'win32' });
  assert.deepEqual(res, { submitted: false, reason: 'lost' });
  assert.equal(presses, 0);
  // Seen in the input first, then gone: it went in.
  const typed = OPENCODE_READY.replace('Ask anything... "Fix a TODO in the codebase"', 'Reply only DONE when finished.');
  const ok = await checkSubmit({ read: screens(typed, typed, OPENCODE_READY), press: async () => { presses++; }, sleep: async () => {}, text: 'Reply only DONE when finished.', kind: 'opencode', platform: 'win32' });
  assert.deepEqual(ok, { submitted: true });
  assert.equal(presses, 1);
});

test('checkSubmit: opencode\'s restart modal in the middle of the screen is a dialog', async () => {
  const res = await checkSubmit({ read: screens(OPENCODE_UPDATE_MODAL), press: async () => {}, sleep: async () => {}, text: BRIEF, kind: 'opencode', platform: 'linux' });
  assert.deepEqual(res, { submitted: false, reason: 'dialog', label: 'opencode updated itself and must be restarted' });
});

test('clearForPrompt closes a notice first, and holds a prompt back from a modal that would lose it', async () => {
  const pressed = [];
  const keys = async (k) => { pressed.push(...k); };
  assert.equal(await clearForPrompt({ read: async () => AGY_AUTO_NOTICE, keys, sleep: async () => {}, kind: 'agy' }), null);
  assert.deepEqual(pressed, ['esc']);
  assert.deepEqual(await clearForPrompt({ read: async () => OPENCODE_UPDATE_MODAL, keys, sleep: async () => {}, kind: 'opencode' }), { submitted: false, reason: 'dialog', label: 'opencode updated itself and must be restarted' });
  assert.equal(await clearForPrompt({ read: async () => OPENCODE_READY, keys, sleep: async () => {}, kind: 'opencode' }), null);
  assert.equal(await clearForPrompt({ read: async () => { throw new Error('gone'); }, keys, sleep: async () => {} }), null);
  assert.deepEqual(pressed, ['esc']);
});
