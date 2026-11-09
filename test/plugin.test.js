import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { paneOpenArgs, repoFromContext } from '../src/plugin.js';
import { editTask, parseMentions, readTaskLines } from '../src/task.js';

const ctx = (o) => ({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(o) });

test('repository comes from the focused pane, then the workspace', () => {
  assert.equal(repoFromContext(ctx({ focused_pane_cwd: '/code/shop', workspace_cwd: '/code' })), '/code/shop');
  assert.equal(repoFromContext(ctx({ workspace_cwd: '/code' })), '/code');
  assert.equal(repoFromContext(ctx({})), null);
});

test('missing or broken context gives no repository', () => {
  assert.equal(repoFromContext({}), null);
  assert.equal(repoFromContext({ HERDR_PLUGIN_CONTEXT_JSON: '{not json' }), null);
});

test('prompt opens as an overlay without a target pane', () => {
  // herdr: "overlay and popup plugin panes target the active pane"
  const args = paneOpenArgs({ HERDR_PLUGIN_ID: 'herdr-foreman', HERDR_WORKSPACE_ID: 'w1', HERDR_PANE_ID: 'w1:p2' });
  assert.deepEqual(args, ['plugin', 'pane', 'open', '--plugin', 'herdr-foreman', '--entrypoint', 'ask', '--focus']);
  assert.deepEqual(paneOpenArgs({}), args);
});

test('plugin manifest and package agree on the version', () => {
  const manifest = readFileSync(new URL('../herdr-plugin.toml', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.match(/^version = "([^"]+)"/m)?.[1], pkg.version);
  assert.match(manifest, /^id = "herdr-foreman"/m);
  assert.match(manifest, /^min_herdr_version = "0\.9\.5"/m);
});

test('pasted lines are kept; an empty line or the end of input finishes', async () => {
  assert.equal(await readTaskLines(Readable.from(['fix the bug\nsee @a.js\n\nignored\n'])), 'fix the bug\nsee @a.js');
  assert.equal(await readTaskLines(Readable.from(['one\ntwo'])), 'one\ntwo');
  assert.equal(await readTaskLines(Readable.from(['\n'])), '');
  assert.equal(await readTaskLines(Readable.from(['E\nmore\n']), null, { editKey: 'e' }), 'e');
});

test('the editor text comes back without comment lines and the temp file is removed', () => {
  const files = new Map();
  const removed = [];
  const text = editTask({
    env: { EDITOR: 'myedit' }, platform: 'linux', tmpdir: '/tmp',
    writeFile: (f, t) => files.set(f, t), readFile: (f) => `${files.get(f)}fix the bug\nsecond line\n`, removeFile: (f) => removed.push(f),
    spawnSync: (cmd) => { assert.match(cmd, /^myedit /); return { status: 0 }; },
  });
  assert.equal(text, 'fix the bug\nsecond line');
  assert.equal(removed.length, 1);
});

test('no usable editor gives null so the overlay falls back to typing', () => {
  const r = editTask({ env: {}, platform: 'win32', tmpdir: '/t', writeFile() {}, readFile: () => '', removeFile() {}, spawnSync: (cmd) => { assert.match(cmd, /^notepad /); return { error: new Error('x') }; } });
  assert.equal(r, null);
});

test('an editor that returns at once with the file untouched gets an EDITOR hint', () => {
  const files = new Map();
  const said = [];
  let t = 0;
  const r = editTask({
    env: { EDITOR: 'code' }, platform: 'win32', tmpdir: '/t', now: () => (t += 200),
    writeFile: (f, x) => files.set(f, x.replace(/\n/g, '\r\n')), readFile: (f) => files.get(f), removeFile() {},
    spawnSync: () => ({ status: 0 }), report: (m) => said.push(m),
  });
  assert.equal(r, null);
  assert.match(said[0], /code --wait/);
});

test('a slow editor with the file untouched gives an empty task, not a hint', () => {
  const files = new Map();
  const said = [];
  let t = 0;
  const r = editTask({
    env: { EDITOR: 'vim' }, platform: 'linux', tmpdir: '/t', now: () => (t += 5000),
    writeFile: (f, x) => files.set(f, x), readFile: (f) => files.get(f), removeFile() {},
    spawnSync: () => ({ status: 0 }), report: (m) => said.push(m),
  });
  assert.equal(r, '');
  assert.deepEqual(said, []);
});

test('@mentions: paths and quoted paths, not emails', () => {
  assert.deepEqual(parseMentions('see @src/a.js, @"my notes.md" and mail me@site.com. Also @docs/.'), ['src/a.js', 'my notes.md', 'docs/']);
});

test('install and server start run the quiet setup, which never fails the install', () => {
  const manifest = readFileSync(new URL('../herdr-plugin.toml', import.meta.url), 'utf8');
  assert.match(manifest, /\[\[build\]\]\ncommand = \["node", "plugin\/setup\.js", "--quiet"\]/);
  assert.match(manifest, /\[\[startup\]\]\ncommand = \["node", "plugin\/setup\.js", "--quiet"\]/);
  assert.match(manifest, /id = "setup"[\s\S]*command = \["node", "plugin\/setup\.js"\]/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const f of ['plugin', 'herdr-plugin.toml']) assert.ok(pkg.files.includes(f), `${f} ships with npm`);
  // An install script makes npm prepare a git install in a temp clone and link the global package to it (Windows: a junction to a deleted folder).
  assert.equal(pkg.scripts.postinstall, undefined);
});
