import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { applySetting, initialSettings, isSettingCommand, leaderKinds, settingsArgs } from '../src/start-settings.js';
import { settingsLine, hints } from '../src/ask-view.js';
import { readTaskLines } from '../src/task.js';
import { createUi } from '../src/ui.js';

const plain = createUi({ env: { NO_COLOR: '1' } });
const config = { leader: 'claude' };
const ctx = { leaders: ['claude', 'codex'], branches: ['main', 'develop'], branch: 'main' };

test('only the four commands are commands; a path in a task is not', () => {
  for (const l of ['/leader codex', '/branch develop', '/auto', ' /uncommitted ', '/AUTO']) assert.equal(isSettingCommand(l), true, l);
  for (const l of ['/etc/hosts is wrong', '/autoplay', '/leaders', 'fix /auto']) assert.equal(isSettingCommand(l), false, l);
});

test('/leader and /branch check the value against what is available', () => {
  const s = initialSettings(config);
  assert.deepEqual(applySetting('/leader codex', s, ctx).settings, { ...s, leader: 'codex' });
  assert.match(applySetting('/leader gemini', s, ctx).error, /gemini cannot lead here\. Ready agents: claude, codex/);
  assert.match(applySetting('/leader', s, ctx).error, /needs a name: claude, codex/);
  assert.equal(applySetting('/branch develop', s, ctx).settings.base, 'develop');
  assert.equal(applySetting('/branch main', { ...s, base: 'develop' }, ctx).settings.base, null, 'the current branch is the default');
  assert.match(applySetting('/branch nope', s, ctx).error, /no local branch nope\. Branches: main, develop/);
  // the lists could not be read: pass the value on, foreman checks it at the start
  assert.equal(applySetting('/leader x', s, { leaders: null }).settings.leader, 'x');
  assert.equal(applySetting('/branch y', s, { branches: null }).settings.base, 'y');
});

test('/auto and /uncommitted switch, and take no value', () => {
  let s = initialSettings(config);
  s = applySetting('/auto', s, ctx).settings;
  s = applySetting('/uncommitted', s, ctx).settings;
  assert.deepEqual([s.auto, s.uncommitted], [true, true]);
  s = applySetting('/auto', s, ctx).settings;
  assert.equal(s.auto, false);
  assert.match(applySetting('/auto on', s, ctx).error, /takes no value/);
});

test('settingsArgs passes only what differs from the defaults', () => {
  const s = initialSettings(config);
  assert.deepEqual(settingsArgs(s, { config, branch: 'main' }), []);
  assert.deepEqual(settingsArgs({ leader: 'codex', base: 'develop', auto: true, uncommitted: true }, { config, branch: 'main' }),
    ['--leader', 'codex', '--base', 'develop', '--auto-answer', '--include-uncommitted']);
  assert.deepEqual(settingsArgs({ ...s, base: 'main' }, { config, branch: 'main' }), []);
});

test('leaderKinds lists ready agents and keeps the configured leader first when it is not ready', () => {
  const agents = [{ kind: 'codex', status: 'ready' }, { kind: 'pi', status: 'unavailable' }, { kind: 'claude', status: 'ready' }];
  assert.deepEqual(leaderKinds(agents, 'claude'), ['codex', 'claude']);
  assert.deepEqual(leaderKinds(agents, 'pi'), ['pi', 'codex', 'claude']);
});

test('the settings line shows the four settings, and the hints list the commands', () => {
  const line = settingsLine(plain, { leader: 'codex', base: 'develop', auto: true, uncommitted: false }, { branch: 'main', columns: 100 });
  assert.equal(line, '  leader codex · branch ⎇ develop · auto-answer on · uncommitted off');
  assert.equal(settingsLine(plain, initialSettings(config), { branch: 'main', columns: 100 }), '  leader claude · branch ⎇ main · auto-answer off · uncommitted off');
  assert.equal(settingsLine(plain, initialSettings(config), { branch: null, columns: 100 }).includes('branch current'), true);
  assert.ok(settingsLine(plain, initialSettings(config), { branch: 'main', columns: 40 }).split('\n').length === 4, 'narrow: one per line');
  const h = hints(plain, 80);
  for (const c of ['/leader <kind>', '/branch <name>', '/auto', '/uncommitted']) assert.ok(h.includes(c), c);
});

test('readTaskLines hands setting commands to the callback in order and keeps the task intact', async () => {
  const seen = [];
  const command = async (line) => {
    if (!isSettingCommand(line)) return false;
    await new Promise((r) => setTimeout(r, 5));
    seen.push(line);
    return true;
  };
  const task = await readTaskLines(Readable.from(['/leader codex\n/auto\nfix /etc/hosts\n/auto\nmore\n\n']), null, { command });
  assert.deepEqual(seen, ['/leader codex', '/auto']);
  assert.equal(task, 'fix /etc/hosts\n/auto\nmore', 'commands after the first task line are text');
});
