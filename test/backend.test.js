import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { detectBackend, callerPane, findTool, createBackend } from '../src/backend.js';

const has = (...names) => (name) => names.includes(name);

test('a herdr pane and an hc terminal pick their own backend', () => {
  assert.equal(detectBackend({ env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' } }), 'herdr');
  assert.equal(detectBackend({ env: { HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' } }), 'app');
});

test('nested terminals: the inner one set TERM_PROGRAM last', () => {
  const both = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HC_TERMINAL_ID: 't7' };
  assert.equal(detectBackend({ env: { ...both, TERM_PROGRAM: 'herdr' } }), 'herdr');
  assert.equal(detectBackend({ env: { ...both, TERM_PROGRAM: 'ghostty' } }), 'app');
});

test('the --backend flag wins over FOREMAN_BACKEND, which wins over the terminal', () => {
  const env = { FOREMAN_BACKEND: 'app', HERDR_ENV: '1' };
  assert.equal(detectBackend({ env }), 'app');
  assert.equal(detectBackend({ env, flag: 'herdr' }), 'herdr');
  assert.throws(() => detectBackend({ env: { FOREMAN_BACKEND: 'tmux' } }), (e) => e.code === 'USAGE');
});

test('outside both, herdr wins when installed; the app is used when only it is', () => {
  assert.equal(detectBackend({ env: {}, installed: has('herdr', 'hc') }), 'herdr');
  assert.equal(detectBackend({ env: {}, installed: has('hc') }), 'app');
  assert.equal(detectBackend({ env: {}, installed: has() }), 'herdr');
});

test('callerPane is the pane or terminal of the backend', () => {
  const env = { HERDR_PANE_ID: 'w1:p2', HC_TERMINAL_ID: 't7' };
  assert.equal(callerPane('herdr', env), 'w1:p2');
  assert.equal(callerPane('app', env), 't7');
  assert.equal(callerPane('app', {}), null);
});

test('findTool falls back to where the installers put hc and herdr-app', () => {
  const local = 'C:\\Users\\k\\AppData\\Local';
  const hc = path.win32.join(local, 'Programs', 'herdr-core', 'hc.exe');
  const deps = { which: () => null, env: { LOCALAPPDATA: local }, platform: 'win32', exists: (p) => p === hc };
  assert.equal(findTool('hc', deps), hc);
  assert.equal(findTool('herdr-app', deps), null);
  assert.equal(findTool('hc', { ...deps, which: () => '/bin/hc' }), '/bin/hc');
  assert.equal(findTool('hc', { which: () => null, platform: 'linux', homedir: '/home/k', exists: (p) => p === '/home/k/.local/bin/hc' }), '/home/k/.local/bin/hc');
});

test('createBackend returns the client for each backend', () => {
  const deps = { run: async () => ({}), which: () => null, exists: () => false };
  assert.equal(createBackend('herdr', deps).kind, 'herdr');
  assert.equal(createBackend('app', deps).kind, 'app');
});
