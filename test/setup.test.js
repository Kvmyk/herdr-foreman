import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseKeys, addBinding, humanKey, versionAtLeast, chooseLeader, describeAgent, configPath, bindKey, runSetup, formatSetup, installedByNpm, ACTION,
} from '../src/setup.js';
import { fakeRun } from './helpers.js';

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
