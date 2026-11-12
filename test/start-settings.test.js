import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { applySetting, choiceLines, initialSettings, isSettingCommand, leaderKinds, menuKey, menuLines, pickChoice, settingsArgs, MENU } from '../src/start-settings.js';
import { loadRemembered, saveRemembered } from '../src/start-prefs.js';
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

// ---- the numbered menu of the launcher, and what it remembers ----

test('menuLines: five numbered settings that fit 40 columns, long values cut', () => {
  const lines = menuLines({ leader: 'claude', base: null, auto: true, uncommitted: false }, { project: 'shop', branch: 'main', columns: 40 });
  assert.deepEqual(lines, [
    '1 project      shop',
    '2 leader       claude',
    '3 auto-answer  on',
    '4 uncommitted  off',
    '5 branch       main',
  ]);
  const long = menuLines({ leader: 'opencode', base: 'feature/a-very-long-branch-name-that-goes-on', auto: false, uncommitted: true }, { project: 'a-project-with-a-very-long-folder-name', branch: 'main', columns: 40 });
  assert.ok(long.every((l) => l.length <= 40), long.find((l) => l.length > 40));
  assert.match(long[0], /^1 project {6}a-project-with-a-very-…$/);
  assert.match(long[4], /^5 branch {7}feature\/a-very-long-br…$/);
  assert.equal(long[3], '4 uncommitted  on');
  // No project yet, the branch that is checked out, and colors only when asked for.
  const empty = menuLines(initialSettings(config), { columns: 40 });
  assert.equal(empty[0], '1 project      not chosen yet');
  assert.equal(empty[4], '5 branch       current');
  const colored = menuLines({ ...initialSettings(config), auto: true }, { project: 'shop', columns: 40, ui: createUi({ env: { FORCE_COLOR: '1' } }) });
  assert.match(colored[2], /\x1b\[32mon/);
  assert.deepEqual(colored.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')), menuLines({ ...initialSettings(config), auto: true }, { project: 'shop', columns: 40 }));
});

test('menuKey: a line that is only a menu number names a setting; anything else is not one', () => {
  assert.deepEqual(['1', '2', ' 3 ', '4', '5'].map(menuKey), MENU);
  for (const line of ['6', '9', '0', '12', '1.', 'fix 3 bugs', '3 bugs', '', '/auto', '1\n2']) assert.equal(menuKey(line), null, JSON.stringify(line));
});

test('choiceLines and pickChoice: numbered from 1, the current one marked, at most nine, cut to the width', () => {
  assert.deepEqual(choiceLines(['shop', 'blog'], { current: 'blog' }), ['1 shop', '2 blog (now)']);
  assert.deepEqual(choiceLines([]), []);
  const many = Array.from({ length: 12 }, (_, i) => `branch-${i + 1}`);
  const lines = choiceLines(many, { columns: 40 });
  assert.equal(lines.length, 10);
  assert.equal(lines[8], '9 branch-9');
  assert.equal(lines[9], '3 more not shown');
  assert.ok(choiceLines(['feature/a-very-long-branch-name-that-goes-on-and-on'], { columns: 40 }).every((l) => l.length <= 38));
  assert.deepEqual(choiceLines(['a'], { describe: (x) => `(${x}!)` }), ['1 a  (a!)']);

  assert.equal(pickChoice('2', ['shop', 'blog']), 'blog');
  assert.equal(pickChoice(' 1 ', ['shop', 'blog']), 'shop');
  for (const line of ['0', '3', 'blog', '2 please', '', '1\n']) assert.equal(pickChoice(line, ['shop', 'blog']), line === '1\n' ? 'shop' : null, JSON.stringify(line));
  // What is not shown cannot be picked.
  assert.equal(pickChoice('9', many), 'branch-9');
  assert.equal(pickChoice('10', many), null);
});

test('the launcher remembers project, leader and the two switches; a missing or broken file starts fresh', () => {
  const files = {};
  const io = { file: '/s/launcher.json', readFile: (f) => { if (f in files) return files[f]; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, writeFile: (f, data) => { files[f] = data; } };
  const fresh = { repo: null, leader: null, auto: false, uncommitted: false };
  assert.deepEqual(loadRemembered(io), fresh);
  assert.equal(saveRemembered(io, { repo: '/code/shop', leader: 'codex', auto: true, uncommitted: false, base: 'develop' }), true);
  assert.deepEqual(JSON.parse(files['/s/launcher.json']), { repo: '/code/shop', leader: 'codex', auto: true, uncommitted: false });
  assert.deepEqual(loadRemembered(io), { repo: '/code/shop', leader: 'codex', auto: true, uncommitted: false });
  // The base branch belongs to one task and is not kept.
  assert.ok(!('base' in loadRemembered(io)));
  for (const bad of ['not json', 'null', '[]', '{"repo":5,"leader":"","auto":"yes","uncommitted":1}']) {
    files['/s/launcher.json'] = bad;
    assert.deepEqual(loadRemembered(io), fresh, bad);
  }
  assert.equal(saveRemembered({ file: '/s/x.json', writeFile: () => { throw new Error('read-only'); } }, {}), false);
});
