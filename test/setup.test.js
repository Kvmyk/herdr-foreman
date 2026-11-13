import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseKeys, addBinding, humanKey, versionAtLeast, compareVersions, chooseLeader, describeAgent, configPath, bindKey, runSetup, formatSetup, installedByNpm, ACTION, setupApp, bindAppKey, PACKAGE_ROOT, insideWorktrees,
} from '../src/setup.js';
import { fakeRun } from './helpers.js';
import { paths } from '../src/config.js';

const CFG = path.resolve('/h/herdr/config.toml');

// In-memory files; herdr config check is faked by checkIssues(text).
function world({ files = {}, checkIssues = () => [], herdr = true, server = false, plugins = [] } = {}) {
  const fs = { ...files };
  const run = fakeRun([
    ['herdr --version', herdr ? { stdout: 'herdr 0.9.5\n' } : () => { throw Object.assign(new Error('program not found: herdr'), { code: 'ENOENT' }); }],
    ['herdr config check', (cmd, args, opts) => {
      if (!herdr) throw Object.assign(new Error('program not found: herdr'), { code: 'ENOENT' });
      const issues = checkIssues(fs[opts.env.HERDR_CONFIG_PATH] ?? '');
      return issues.length ? { code: 1, stdout: `config: issues found\n${issues.join('\n')}\n` } : { stdout: 'config: ok\n' };
    }],
    ['herdr status server', { stdout: server ? 'status: running\n' : 'status: not running\n' }],
    ['herdr server reload-config', {}],
    ['herdr plugin list --json', { stdout: JSON.stringify({ id: 'cli:plugin', result: { plugins, type: 'plugin_list' } }) }],
    [/^herdr plugin link /, {}],
    ['git --version', { stdout: 'git version 2.45.0\n' }],
    ['git config user.name', { stdout: 'Ada\n' }],
    ['git config user.email', { stdout: 'ada@example.com\n' }],
  ]);
  const d = {
    run,
    env: { HERDR_CONFIG_PATH: CFG },
    homedir: path.resolve('/h'),
    cwd: path.resolve('/code'),
    tmpdir: path.resolve('/tmp'),
    platform: 'linux',
    nodeVersion: '22.1.0',
    paths: { config: path.resolve('/h/.herdr-foreman/config.json'), setupState: path.resolve('/h/.herdr-foreman/setup.json') },
    readFile: (f) => {
      if (f in fs) return fs[f];
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    writeFile: (f, data) => { fs[f] = data; },
    removeFile: (f) => { delete fs[f]; },
    exists: (f) => f in fs || f.endsWith('herdr-plugin.toml'),
    which: (k) => (k === 'codex' ? `/bin/${k}` : null),
    inventory: async () => [{ kind: 'claude', status: 'ready', models: [], reason: null }],
    root: path.resolve('/lib/node_modules/herdr-foreman'),
  };
  return { d, fs, run };
}

test('parseKeys finds the prefix, taken keys and an existing foreman binding', () => {
  const text = [
    '[keys]', 'prefix = "ctrl+a"', 'zoom = "prefix+f"', '# help = "prefix+?"', '',
    '[[keys.command]]', 'key = "prefix+alt+g"', 'command = "lazygit"', '',
    '[[keys.command]]', "key = 'prefix+y'", 'type = "plugin_action"', `command = "${ACTION}"`,
    '[ui]', 'zoom = "prefix+q"',
  ].join('\n');
  assert.deepEqual(parseKeys(text), { prefix: 'ctrl+a', used: ['prefix+f', 'prefix+alt+g', 'prefix+y'], ours: 'prefix+y' });
  assert.deepEqual(parseKeys(''), { prefix: 'ctrl+b', used: [], ours: null });
});

test('addBinding appends one block after a blank line', () => {
  const out = addBinding('onboarding = false\n\n\n', 'prefix+f');
  assert.match(out, /^onboarding = false\n\n# Added by foreman.*\n\[\[keys\.command\]\]\nkey = "prefix\+f"\ntype = "plugin_action"\ncommand = "herdr-foreman\.start"\n/);
  assert.match(addBinding('', 'prefix+f'), /^# Added by foreman/);
});

test('humanKey and versionAtLeast', () => {
  assert.equal(humanKey('prefix+f'), 'Ctrl+B, then F');
  assert.equal(humanKey('prefix+shift+f', 'ctrl+a'), 'Ctrl+A, then Shift+F');
  assert.equal(humanKey('ctrl+alt+f'), 'Ctrl+Alt+F');
  assert.ok(versionAtLeast('herdr 0.9.5', '0.9.5'));
  assert.ok(versionAtLeast('0.10.0', '0.9.5'));
  assert.ok(!versionAtLeast('0.9.4', '0.9.5'));
});

test('chooseLeader keeps the user choice, else prefers a ready agent', () => {
  const agents = [{ kind: 'claude', status: 'unavailable' }, { kind: 'opencode', status: 'ready' }, { kind: 'codex', status: 'ready' }];
  assert.deepEqual(chooseLeader({ configured: 'pi', agents }), { leader: 'pi', changed: false });
  assert.deepEqual(chooseLeader({ configured: null, agents }), { leader: 'codex', changed: true });
  assert.deepEqual(chooseLeader({ configured: null, agents: [{ kind: 'claude', status: 'ready' }] }), { leader: 'claude', changed: false });
  assert.deepEqual(chooseLeader({ configured: null, agents: [] }), { leader: null, changed: false });
});

test('describeAgent says how to sign in', () => {
  assert.match(describeAgent({ kind: 'codex', status: 'unavailable', reason: 'not signed in; run "codex login" (x)' }), /not signed in.*type: codex login$/);
  assert.equal(describeAgent({ kind: 'claude', status: 'ready' }), 'claude is ready');
});

test('configPath: env override, then herdr --help, then the default', async () => {
  const run = fakeRun({ 'herdr --help': { stdout: 'herdr\nConfig: /x/herdr/config.toml\nLogs: /x\n' } });
  assert.equal(await configPath({ run, env: { HERDR_CONFIG_PATH: '/e.toml' }, homedir: '/h' }), '/e.toml');
  assert.equal(await configPath({ run, env: {}, homedir: '/h' }), '/x/herdr/config.toml');
  assert.equal(await configPath({ run: fakeRun(), env: {}, homedir: '/h', platform: 'linux' }), '/h/.config/herdr/config.toml');
  assert.equal(await configPath({ run: fakeRun(), env: { APPDATA: 'C:\\A' }, homedir: 'C:\\h', platform: 'win32' }), 'C:\\A\\herdr\\config.toml');
});

test('bindKey leaves an existing foreman key alone', async () => {
  const { d, run } = world({ files: { [CFG]: `[[keys.command]]\nkey = "prefix+y"\ntype = "plugin_action"\ncommand = "${ACTION}"\n` } });
  const r = await bindKey(d);
  assert.deepEqual([r.status, r.key], ['already', 'prefix+y']);
  assert.equal(run.calls.length, 0);
});

test('bindKey adds prefix+f, keeps a backup and validates a copy first', async () => {
  const { d, fs, run } = world({ files: { [CFG]: 'onboarding = false\n' } });
  const r = await bindKey(d);
  assert.deepEqual([r.status, r.key, r.backup], ['added', 'prefix+f', `${CFG}.foreman-backup`]);
  assert.equal(fs[`${CFG}.foreman-backup`], 'onboarding = false\n');
  assert.equal(parseKeys(fs[CFG]).ours, 'prefix+f');
  const checked = run.calls.filter((c) => c.line === 'herdr config check').map((c) => c.opts.env.HERDR_CONFIG_PATH);
  assert.equal(checked[0], CFG);
  assert.equal(path.dirname(checked[1]), path.resolve('/tmp'));
  assert.equal(Object.keys(fs).some((f) => f.startsWith(path.resolve('/tmp'))), false, 'temporary copy removed');
});

test('bindKey skips keys the user or herdr already uses', async () => {
  const conflict = (text) => (/key = "prefix\+shift\+f"/.test(text) ? ['prefix+shift+f: kept keys.something, disabled keys.command[0].key'] : []);
  const { d, fs } = world({ files: { [CFG]: '[keys]\nzoom = "prefix+f"\n' }, checkIssues: conflict });
  const r = await bindKey(d);
  assert.equal(r.key, 'prefix+alt+f');
  assert.equal(parseKeys(fs[CFG]).ours, 'prefix+alt+f');
});

test('bindKey creates a missing config without a backup', async () => {
  const { d, fs } = world();
  const r = await bindKey(d);
  assert.deepEqual([r.status, r.backup], ['added', null]);
  assert.match(fs[CFG], /^# Added by foreman/);
});

test('bindKey never writes a config herdr cannot read', async () => {
  const { d, fs } = world({ files: { [CFG]: 'broken = \n' }, checkIssues: (t) => (t.includes('broken') ? ['config parse error: TOML parse error at line 1'] : []) });
  const r = await bindKey(d);
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /herdr config check/);
  assert.equal(fs[CFG], 'broken = \n');
});

test('bindKey refuses a change herdr reports new problems for', async () => {
  const { d, fs } = world({ files: { [CFG]: 'x = 1\n' }, checkIssues: (t) => (t.includes('keys.command') ? ['keys.command[0]: unknown type'] : []) });
  const r = await bindKey(d);
  assert.equal(r.status, 'failed');
  assert.equal(fs[CFG], 'x = 1\n');
});

test('bindKey without herdr fails in plain words', async () => {
  const { d } = world({ files: { [CFG]: 'x = 1\n' }, herdr: false });
  assert.deepEqual(await bindKey(d), { status: 'failed', file: CFG, reason: 'herdr is not installed' });
});

test('runSetup: full run links the plugin, binds, reloads a running server and says what to do next', async () => {
  const { d, fs, run } = world({ server: true });
  const r = await runSetup(d);
  assert.equal(r.ok, true);
  assert.ok(run.calls.some((c) => c.line.startsWith('herdr plugin link ')));
  assert.ok(run.calls.some((c) => c.line === 'herdr server reload-config'));
  assert.ok(fs[d.paths.setupState]);
  const text = formatSetup(r);
  assert.match(text, /Shortcut: Ctrl\+B, then F/);
  assert.match(text, /Press Ctrl\+B, let go, then press F\./);
});

test('runSetup: quiet run never links or probes agents and picks an installed leader', async () => {
  const { d, fs, run } = world({ plugins: [{ id: 'herdr-foreman', enabled: true }] });
  d.inventory = async () => { throw new Error('should not probe'); };
  const r = await runSetup(d, { quiet: true });
  assert.ok(!run.calls.some((c) => c.line.startsWith('herdr plugin link')));
  assert.equal(JSON.parse(fs[d.paths.config]).leader, 'codex');
  assert.equal(formatSetup(r), 'foreman added the shortcut Ctrl+B, then F to herdr.\nforeman chose codex as the lead agent.');
});

test('runSetup: postinstall in a developer clone changes nothing', async () => {
  const { d, run } = world();
  d.root = path.resolve('/code/herdr-foreman');
  const r = await runSetup(d, { postinstall: true });
  assert.equal(r.skipped, true);
  assert.equal(run.calls.length, 0);
  assert.equal(formatSetup(r), '');
  assert.ok(installedByNpm({ env: {}, root: path.resolve('/usr/lib/node_modules/herdr-foreman') }));
  assert.ok(installedByNpm({ env: { npm_config_global: 'true' }, root: '/x' }));
});

test('runSetup: missing pieces are listed with the fix', async () => {
  const { d } = world({ herdr: false });
  d.inventory = async () => [];
  const r = await runSetup(d);
  assert.equal(r.ok, false);
  const text = formatSetup(r);
  assert.match(text, /herdr is not installed. Install it from https:\/\/herdr.dev/);
  assert.match(text, /No coding agent found/);
  assert.match(text, /Fix the lines marked \[!!\]/);
});

// ---- Herdr desktop app ----

const APP = path.join(path.resolve('/h'), '.config', 'herdr-app');
const MOD_MAIN = path.join(APP, 'mods', 'foreman', 'main.js');
const KEYS = path.join(APP, 'keys.json');
const TEMPLATE = 'const NODE = "__NODE__";\nconst BIN = "__BIN__";\n';
const DEFAULT_KEYS = JSON.stringify({ global: { 'ctrl-shift-t': 'tab.new' }, terminal: { 'ctrl-shift-f': 'terminal.search' } });

function appWorld({ keys = DEFAULT_KEYS, check = { code: 0 }, files = {}, keyError = false, herdr = false } = {}) {
  const w = world({ herdr, files: { [APP]: '', ...(keys === null ? {} : { [KEYS]: keys }), ...files } });
  const root = w.d.root;
  w.fs[path.join(root, 'app', 'foreman', 'main.js')] = TEMPLATE;
  w.fs[path.join(root, 'app', 'foreman', 'mod.json')] = '{"place":"none"}\n';
  w.fs[path.join(root, 'app', 'foreman', 'logo.svg')] = '<svg/>\n';
  w.fs[path.join(root, 'package.json')] = '{"version":"1.2.3"}';
  w.d.env = {};
  w.d.nodePath = 'C:\\n\\node.exe';
  w.d.sleep = async () => { if (keyError) w.fs[path.join(APP, 'keys.error')] = 'bad'; };
  const base = w.d.run;
  w.checks = [];
  w.d.run = async (cmd, args, opts) => {
    if (cmd !== 'herdr-app') return base(cmd, args, opts);
    w.checks.push({ args, main: w.fs[path.join(args[1], 'main.js')] });
    if (check instanceof Error) throw check;
    return { code: 0, stdout: '', stderr: '', ...check };
  };
  return w;
}

test('setupApp: no app folder writes nothing', async () => {
  const w = appWorld();
  delete w.fs[APP];
  assert.equal((await setupApp(w.d, '1')).status, 'absent');
  assert.equal(w.checks.length, 0);
  assert.equal(MOD_MAIN in w.fs, false);
});

test('setupApp: first install checks the mod, writes it with a marker and binds a key with a backup', async () => {
  const w = appWorld();
  const r = await setupApp(w.d, '1.2.3');
  assert.equal(r.mod.status, 'added');
  assert.deepEqual([r.key.status, r.key.key], ['added', 'ctrl-shift-y']);
  assert.equal(w.checks.length, 1);
  assert.match(w.checks[0].main, /^\/\/ foreman-managed 1\.2\.3 [0-9a-f]{64}\n/);
  const main = w.fs[MOD_MAIN];
  assert.match(main, /const NODE = "C:\/n\/node\.exe";/);
  assert.match(main, /const BIN = ".*\/bin\/foreman\.js";/);
  assert.equal(w.fs[path.join(APP, 'mods', 'foreman', 'mod.json')], '{"place":"none"}\n');
  assert.equal(w.fs[path.join(APP, 'mods', 'foreman', 'logo.svg')], '<svg/>\n');
  assert.equal(w.fs[`${KEYS}.foreman-backup`], DEFAULT_KEYS);
  assert.deepEqual(JSON.parse(w.fs[KEYS]), { global: { 'ctrl-shift-t': 'tab.new', 'ctrl-shift-y': 'mod.open:foreman' }, terminal: { 'ctrl-shift-f': 'terminal.search' } });
});

test('setupApp: a second run changes and checks nothing', async () => {
  const w = appWorld();
  await setupApp(w.d, '1.2.3');
  const before = { ...w.fs };
  w.checks.length = 0;
  const r = await setupApp(w.d, '1.2.3');
  assert.deepEqual([r.mod.status, r.key.status, r.key.key], ['already', 'already', 'ctrl-shift-y']);
  assert.equal(w.checks.length, 0);
  assert.deepEqual(w.fs, before);
});

test('setupApp: a missing logo is written when main.js is current; an edited main.js keeps it away', async () => {
  const w = appWorld();
  await setupApp(w.d, '1.2.3');
  const logo = path.join(APP, 'mods', 'foreman', 'logo.svg');
  delete w.fs[logo];
  assert.equal((await setupApp(w.d, '1.2.3')).mod.status, 'updated');
  assert.equal(w.fs[logo], '<svg/>\n');
  delete w.fs[logo];
  w.fs[MOD_MAIN] += '// mine\n';
  assert.equal((await setupApp(w.d, '1.2.3')).mod.status, 'skipped');
  assert.equal(logo in w.fs, false);
});

test('setupApp: an unedited mod of an older version is updated, an edited one is left alone', async () => {
  const w = appWorld();
  await setupApp(w.d, '1.0.0');
  assert.equal((await setupApp(w.d, '1.2.3')).mod.status, 'updated');
  assert.match(w.fs[MOD_MAIN], /foreman-managed 1\.2\.3 /);
  w.fs[MOD_MAIN] += '// mine\n';
  const edited = w.fs[MOD_MAIN];
  w.fs[path.join(w.d.root, 'app', 'foreman', 'main.js')] = `${TEMPLATE}// new\n`;
  const r = await setupApp(w.d, '1.3.0');
  assert.equal(r.mod.status, 'skipped');
  assert.equal(r.key.status, 'skipped');
  assert.equal(w.fs[MOD_MAIN], edited);
});

test('setupApp: an older foreman leaves a newer one\'s mod alone while that foreman is still there', async () => {
  const w = appWorld();
  const bin = path.join(w.d.root, 'bin', 'foreman.js');
  w.fs[bin] = '';
  await setupApp(w.d, '0.7.0-dev');
  const newer = w.fs[MOD_MAIN];
  w.fs[path.join(w.d.root, 'app', 'foreman', 'main.js')] = `${TEMPLATE}// old\n`;
  w.checks.length = 0;
  const r = await setupApp(w.d, '0.6.0');
  assert.deepEqual([r.mod.status, r.mod.version, r.key.status], ['newer', '0.7.0-dev', 'already']);
  assert.equal(w.checks.length, 0);
  assert.equal(w.fs[MOD_MAIN], newer);
  delete w.fs[bin];
  assert.equal((await setupApp(w.d, '0.6.0')).mod.status, 'updated');
  assert.match(w.fs[MOD_MAIN], /foreman-managed 0\.6\.0 [\s\S]*\/\/ old\n$/);
});

test('setupApp: a copy of the same version with other paths keeps the installed mod', async () => {
  const w = appWorld();
  w.fs[path.join(w.d.root, 'bin', 'foreman.js')] = '';
  await setupApp(w.d, '1.2.3');
  const installed = w.fs[MOD_MAIN];
  w.d.nodePath = 'D:\\other\\node.exe';
  assert.equal((await setupApp(w.d, '1.2.3')).mod.status, 'already');
  assert.equal(w.fs[MOD_MAIN], installed);
  w.fs[path.join(w.d.root, 'app', 'foreman', 'main.js')] = `${TEMPLATE}// changed\n`;
  assert.equal((await setupApp(w.d, '1.2.3')).mod.status, 'updated');
  assert.match(w.fs[MOD_MAIN], /D:\/other\/node\.exe[\s\S]*\/\/ changed\n$/);
});

test('setupApp: a foreman inside one of its task worktrees never writes its path into the prompt', async () => {
  const w = appWorld();
  w.fs[path.join(w.d.root, 'bin', 'foreman.js')] = '';
  await setupApp(w.d, '1.2.3');
  const installed = w.fs[MOD_MAIN];
  w.checks.length = 0;
  const tree = path.resolve('/h/.herdr-foreman/worktrees/repo-1/task/w1');
  for (const f of ['main.js', 'mod.json', 'logo.svg']) w.fs[path.join(tree, 'app', 'foreman', f)] = w.fs[path.join(w.d.root, 'app', 'foreman', f)];
  w.d.root = tree;
  const r = await setupApp(w.d, '9.9.9');
  assert.equal(r.mod.status, 'skipped');
  assert.match(r.mod.reason, /task worktree/);
  assert.equal(w.checks.length, 0);
  assert.equal(w.fs[MOD_MAIN], installed);
  assert.ok(!w.fs[MOD_MAIN].includes('worktrees'));
  // FOREMAN_HOME moves the worktrees with it; a lasting copy next to them still installs.
  assert.equal(insideWorktrees({ env: { FOREMAN_HOME: path.resolve('/f') }, homedir: path.resolve('/h') }, path.resolve('/f/worktrees/a')), true);
  assert.equal(insideWorktrees({ env: {}, homedir: path.resolve('/h') }, path.resolve('/h/.herdr-foreman/worktrees-old/a')), false);
  assert.equal(insideWorktrees({ env: {}, homedir: path.resolve('/h') }, path.resolve('/lib/node_modules/herdr-foreman')), false);
});

test('compareVersions: numbers, then a release after its pre-release', () => {
  assert.equal(compareVersions('0.7.0', '0.6.9'), 1);
  assert.equal(compareVersions('0.6.0', '0.6.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.7.0-dev', '0.6.0'), 1);
  assert.equal(compareVersions('0.7.0-dev', '0.7.0'), -1);
  assert.equal(compareVersions('1', '1.0.0'), 0);
});

test('setupApp: a mod folder that is not from foreman is never overwritten', async () => {
  const w = appWorld({ files: { [path.join(APP, 'mods', 'foreman')]: '', [MOD_MAIN]: 'export default class {}' } });
  assert.equal((await setupApp(w.d, '1')).mod.status, 'skipped');
  assert.equal(w.fs[MOD_MAIN], 'export default class {}');
  const w2 = appWorld({ files: { [path.join(APP, 'mods', 'foreman')]: '' } });
  assert.equal((await setupApp(w2.d, '1')).mod.status, 'skipped');
});

test('setupApp: a failing herdr-app check writes nothing', async () => {
  const w = appWorld({ check: { code: 1, stderr: 'bad mod\nmain.js:3 oops\n' } });
  const r = await setupApp(w.d, '1');
  assert.equal(r.mod.status, 'failed');
  assert.match(r.mod.reason, /oops/);
  assert.equal(MOD_MAIN in w.fs, false);
  assert.equal(`${KEYS}.foreman-backup` in w.fs, false);
  const missing = appWorld({ check: Object.assign(new Error('nope'), { code: 'ENOENT' }) });
  assert.match((await setupApp(missing.d, '1')).mod.reason, /not on PATH/);
});

test('bindAppKey: skips a taken key, never creates or replaces a missing or invalid keys.json', async () => {
  const taken = appWorld({ keys: JSON.stringify({ global: { 'ctrl-shift-y': 'x' }, terminal: { 'CTRL-ALT-SHIFT-F': 'y' } }) });
  assert.equal((await bindAppKey(taken.d)).key, 'ctrl-shift-f10');
  const all = appWorld({ keys: JSON.stringify({ global: { 'ctrl-shift-y': 'x', 'ctrl-alt-shift-f': 'x', 'ctrl-shift-f10': 'x' } }) });
  assert.equal((await bindAppKey(all.d)).status, 'failed');
  const none = appWorld({ keys: null });
  assert.equal((await bindAppKey(none.d)).status, 'skipped');
  assert.equal(KEYS in none.fs, false);
  const bad = appWorld({ keys: '{ nope' });
  assert.equal((await bindAppKey(bad.d)).status, 'skipped');
  assert.equal(bad.fs[KEYS], '{ nope');
  const object = appWorld({ keys: JSON.stringify({ global: { 'ctrl-shift-p': { command: 'mod.open', args: { name: 'foreman' } } } }) });
  const again = await bindAppKey(object.d);
  assert.deepEqual([again.status, again.key], ['already', 'ctrl-shift-p']);
});

test('bindAppKey: puts the old keys back when the app reports keys.error', async () => {
  const w = appWorld({ keyError: true });
  const r = await bindAppKey(w.d);
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /keys\.error/);
  assert.equal(w.fs[KEYS], DEFAULT_KEYS);
});

test('runSetup: herdr is not needed when the app is set up; messages and state say so', async () => {
  const w = appWorld();
  const r = await runSetup(w.d);
  assert.equal(r.herdr.version, null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes, ['added its task prompt in the Herdr app', 'added the shortcut Ctrl+Shift+Y to the Herdr app']);
  const text = formatSetup(r);
  assert.match(text, /\[ok\] Herdr app shortcut: Ctrl\+Shift\+Y \(just added to .*keys\.json; your old keys are saved as .*keys\.json\.foreman-backup/);
  assert.match(text, /1\. In the Herdr app, open a terminal in your project folder\.\n {2}2\. Press Ctrl\+Shift\+Y\./);
  assert.equal(JSON.parse(w.fs[w.d.paths.setupState]).app.key, 'ctrl-shift-y');
  const quiet = await runSetup(appWorld().d, { quiet: true });
  assert.equal(formatSetup(quiet), 'foreman added its task prompt in the Herdr app.\nforeman added the shortcut Ctrl+Shift+Y to the Herdr app.\nforeman chose codex as the lead agent.');
});

test('runSetup: a failed app step is reported and is not ok', async () => {
  const r = await runSetup(appWorld({ check: { code: 1, stderr: 'oops' } }).d, { quiet: true });
  assert.equal(r.ok, false);
  assert.match(formatSetup(r), /could not set up the Herdr app: herdr-app check failed: oops/);
});

test('app/foreman template: placeholders for node and foreman, the backend flag, no Node APIs', () => {
  const main = readFileSync(new URL('../app/foreman/main.js', import.meta.url), 'utf8');
  assert.match(main, /const NODE = "__NODE__";/);
  assert.match(main, /const BIN = "__BIN__";/);
  assert.match(main, /\[NODE, BIN, "--backend", "app", [^\n]*"--", task\]/);
  assert.match(main, /"--leader", this\.leader/);
  assert.match(main, /"--base", this\.base/);
  // The prompt shows the agents foreman kept last time, then asks quickly.
  assert.match(main, /\$\{this\.dir\}\/agents\.json/);
  assert.equal(path.basename(paths({ env: {}, homedir: '/h' }).agentsCache), 'agents.json');
  assert.match(main, /\[BIN, "agents", "--json", "--quick"\]/);
  // Space and Enter on a focused switch row already arrive as a click; a key handler
  // on the row as well flipped it twice. Only the prompt's own (Escape) handler stays.
  assert.equal(main.match(/\.on_key_down\(/g).length, 1);
  assert.match(main, /track_focus\(this\.rowFocus\[name\]\)[^\n]*\n[^\n]*\n\s*\.on_click\(\(_e, hcx\) => flip\(name, hcx\)\)/);
  assert.doesNotMatch(main, /node:|require\(|process\./);
  assert.equal(JSON.parse(readFileSync(new URL('../app/foreman/mod.json', import.meta.url), 'utf8')).place, 'none');
});

test('app/foreman template: a Phone launcher switch shows config.json\'s "launcher" and saves through foreman launcher on|off', () => {
  const main = readFileSync(new URL('../app/foreman/main.js', import.meta.url), 'utf8');
  assert.match(main, /toggle\("fm-launcher", "Phone launcher"/);
  assert.match(main, /this\.launcher = JSON\.parse\(config \?\? "\{\}"\)\.launcher === true/);
  assert.match(main, /exec\(NODE, \[BIN, "launcher", on \? "on" : "off", "--json"\]\)/);
  // The task's own switches stay out of it: the launcher is saved at once, not with the task.
  assert.match(main, /rowFocus = \{ answer: [^}]*, launcher: cx\.focus_handle\(\) \}/);
  assert.doesNotMatch(main, /writeTextFile\([^)]*config\.json/);
});

test('formatSetup counts the checks that passed', () => {
  const r = {
    quiet: false, changes: [], ok: false, node: { ok: true, version: '22.1.0' }, herdr: { ok: true, version: '0.9.5' },
    git: { version: null }, plugin: 'enabled', key: { status: 'already', key: 'prefix+f', prefix: 'ctrl+b' },
    agents: [{ kind: 'claude', status: 'ready' }], leader: 'claude',
  };
  assert.match(formatSetup(r), /\n\d+ of \d+ checks passed\n/);
  assert.match(formatSetup(r), /^  \[ok\]|\n  \[!!\] git is not installed/);
});

test('the real app mod keeps its placeholders and the keys the prompt documents', () => {
  const main = readFileSync(path.join(PACKAGE_ROOT, 'app', 'foreman', 'main.js'), 'utf8');
  assert.equal(main.split('"__NODE__"').length, 2);
  assert.equal(main.split('"__BIN__"').length, 2);
  // ⌘ on a Mac, Ctrl elsewhere: the submit handler takes either as the secondary key.
  assert.ok(main.includes('hint([window()?.platform === "macos" ? "⌘" : "Ctrl", "Enter"], "start")'));
  assert.match(main, /hint\(\["Esc"\], "cancel"\)/);
  for (const flag of ['--auto-answer', '--include-uncommitted']) assert.ok(main.includes(`"${flag}"`), flag);
  const mod = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'app', 'foreman', 'mod.json'), 'utf8'));
  // A real height: a scroll area has no height of its own, so in a dialog sized by
  // its content the middle (pills, task box, switches) collapsed to nothing. Both
  // are in pixels (a value up to 1 would be a share).
  assert.ok(mod.overlay.height >= 480);
  assert.ok(mod.overlay.width >= 420);
  // What is between the header and the buttons scrolls, and under 520 px the prompt
  // is one column of 44 px targets without key caps.
  assert.match(main, /const COMPACT_WIDTH = 520;/);
  assert.match(main, /const TAP = 44;/);
  assert.ok(main.includes('.on_size_change((size, cx) => this.resized(size, cx))'));
  // The body fills the dialog and the middle takes what the header and buttons leave.
  assert.ok(main.includes('.size_full().min_h(0).p(compact ? 16 : 24)'));
  assert.ok(main.split('\n').some((l) => l.includes('id("fm-scroll")') && l.includes('.flex_1().min_h(0).overflow_y_scrollbar()')));
  // The task box is as tall as its rows, and its border follows the state's focus.
  assert.ok(main.includes('this.input.on("blur"'));
  assert.ok(main.includes('.border_color(this.inputFocused ? t.accent : t.border)'));
  assert.ok(!main.split('\n').some((l) => l.includes('Textarea.new(') && l.includes('.h(')));
  // The key caps are only drawn when the prompt is not narrow.
  const footer = main.slice(main.indexOf('if (!compact) {'));
  const caps = footer.indexOf('"Enter"], "start")');
  assert.ok(caps > 0 && caps < footer.indexOf('}\n'));
});

// ---- herdr-core alone: a server, or a computer reached from the Herdr phone app ----

function withCore(w, { running = true, launcher = null } = {}) {
  const base = w.d.run;
  const which = w.d.which;
  w.hc = [];
  w.d.which = (k) => (k === 'hc' ? '/bin/hc' : which(k));
  w.d.run = async (cmd, args, opts) => {
    if (cmd !== '/bin/hc') return base(cmd, args, opts);
    w.hc.push(args.join(' '));
    if (args[0] === '--version') return { code: 0, stdout: 'hc 0.1.20\n', stderr: '' };
    return { code: running ? 0 : 1, stdout: '{}', stderr: '' };
  };
  if (launcher) w.d.ensureLauncher = async () => launcher;
  return w;
}

test('runSetup: herdr-core alone is a valid setup: its version, no mod or key errors, and the steps for a terminal or the phone', async () => {
  const w = withCore(world({ herdr: false }));
  const r = await runSetup(w.d);
  assert.equal(r.ok, true);
  assert.equal(r.coreOnly, true);
  assert.deepEqual(r.core, { version: '0.1.20', running: true });
  assert.deepEqual(w.hc, ['--version', 'server status --json']);
  assert.equal(JSON.parse(w.fs[w.d.paths.setupState]).core, '0.1.20');
  const text = formatSetup(r);
  assert.match(text, /\[ok\] herdr-core 0\.1\.20 is running\. herdr and the Herdr desktop app are not installed, which is fine/);
  assert.doesNotMatch(text, /\[!!\]/);
  assert.doesNotMatch(text, /herdr is not installed|shortcut|task prompt/);
  assert.match(text, /5 of 5 checks passed/);
  assert.match(text, /What to do next, in the Herdr phone app or in any terminal on this computer:\n {2}1\. Open a terminal in your project folder\.\n {2}2\. Type: foreman new\n {2}3\. Paste or type what you want done and press Enter\./);
  assert.match(text, /To keep a foreman terminal in the phone's Inbox, type: foreman launcher on$/);
});

test('runSetup: a quiet run on herdr-core alone reports no failure and remembers that setup ran', async () => {
  const w = withCore(world({ herdr: false }));
  const r = await runSetup(w.d, { quiet: true });
  assert.equal(r.coreOnly, true);
  assert.equal(formatSetup(r), 'foreman chose codex as the lead agent.');
  assert.ok(w.fs[w.d.paths.setupState]);
});

test('runSetup: herdr-core that does not answer is not a setup, and the fix is named', async () => {
  const r = await runSetup(withCore(world({ herdr: false }), { running: false }).d);
  assert.equal(r.ok, false);
  assert.equal(r.coreOnly, false);
  const text = formatSetup(r);
  assert.match(text, /\[!!\] herdr-core 0\.1\.20 is installed but does not answer\. Type: hc server start/);
  assert.match(text, /Fix the lines marked \[!!\]/);
  assert.doesNotMatch(text, /foreman new/);
});

test('runSetup: quiet runs ask herdr-core only when neither herdr nor the app is there', async () => {
  const w = withCore(world({ plugins: [{ id: 'herdr-foreman', enabled: true }] }));
  const r = await runSetup(w.d, { quiet: true });
  assert.deepEqual(w.hc, []);
  assert.equal(r.core, undefined);
  assert.equal(r.coreOnly, false);
});

test('runSetup: with the desktop app the phone still gets its own line, and an open launcher is a passed check', async () => {
  const plain = withCore(appWorld());
  const text = formatSetup(await runSetup(plain.d));
  assert.match(text, /2\. Press Ctrl\+Shift\+Y\./);
  assert.match(text, /From the Herdr phone app: open a terminal in your project folder and type: foreman new/);
  assert.match(text, /To keep a foreman terminal in the phone's Inbox/);

  const open = withCore(appWorld(), { launcher: { status: 'started', terminal: 't9' } });
  const r = await runSetup(open.d);
  assert.ok(r.changes.includes('opened its launcher terminal for the Herdr phone app'));
  const withLauncher = formatSetup(r);
  assert.match(withLauncher, /\[ok\] Launcher: a terminal named foreman is open \(just now\)/);
  assert.match(withLauncher, /Or open the terminal named foreman in the phone's Inbox and send the task there\./);
  assert.doesNotMatch(withLauncher, /To keep a foreman terminal/);

  const broken = withCore(appWorld(), { launcher: { status: 'failed', reason: 'name foreman is in use' } });
  assert.match(formatSetup(await runSetup(broken.d)), /\[!!\] The launcher \("launcher": true in .*config\.json\) could not start: name foreman is in use/);
  const off = withCore(appWorld(), { launcher: { status: 'off' } });
  assert.doesNotMatch(formatSetup(await runSetup(off.d)), /Launcher:|could not start/);
});
