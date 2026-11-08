import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paneOpenArgs, repoFromContext } from '../src/plugin.js';

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

test('install and server start run the quiet setup, which never fails the install', () => {
  const manifest = readFileSync(new URL('../herdr-plugin.toml', import.meta.url), 'utf8');
  assert.match(manifest, /\[\[build\]\]\ncommand = \["node", "plugin\/setup\.js", "--quiet"\]/);
  assert.match(manifest, /\[\[startup\]\]\ncommand = \["node", "plugin\/setup\.js", "--quiet"\]/);
  assert.match(manifest, /id = "setup"[\s\S]*command = \["node", "plugin\/setup\.js"\]/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const f of ['plugin', 'herdr-plugin.toml']) assert.ok(pkg.files.includes(f), `${f} ships with npm`);
  assert.equal(pkg.scripts.postinstall, 'node bin/foreman.js setup --postinstall');
});
