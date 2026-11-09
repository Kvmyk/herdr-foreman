import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScreen, describeBlocked, keysCommand, trustKeys } from '../src/blocked.js';

test('classifies the four kinds of blocking screens', () => {
  assert.equal(classifyScreen('claude', 'Do you trust the files in this folder?').type, 'trust');
  assert.equal(classifyScreen('agy', 'Please sign in to continue').type, 'login');
  assert.equal(classifyScreen('codex', 'Update available! 0.1 -> 0.2').type, 'update');
  assert.equal(classifyScreen('pi', 'Run rm -rf build? [y/n]').type, 'permission');
  assert.equal(classifyScreen('pi', 'compiling...'), null);
});

const CLAUDE = 'Quick safety check: is this a project you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n';
const AGY = 'Do you trust this folder?\n\n > Yes, I trust this folder\n   No, exit\n';
const CODEX = 'Do you trust the contents of this directory?\n\n › 1. Yes, continue\n   2. No, quit\n';

test('the trust answer depends on which option the screen highlights', () => {
  assert.deepEqual(trustKeys(CLAUDE), ['down', 'enter']);
  assert.deepEqual(trustKeys(AGY), ['enter']);
  assert.deepEqual(trustKeys(CODEX), ['1']);
  assert.deepEqual(trustKeys('Trust this folder?\n   Yes\n ❯ No\n'), ['up', 'enter']);
  assert.equal(trustKeys('Do you trust this folder?'), null);
  assert.equal(trustKeys('❯ No, exit\n  Yes, I trust this folder'.replace('❯ ', '')), null);
});

test('trust dialogs are safe to answer only when the screen shows the highlighted option', () => {
  for (const [kind, screen] of [['claude', CLAUDE], ['agy', AGY], ['codex', CODEX]]) {
    assert.equal(classifyScreen(kind, screen).safeToAnswer, true);
  }
  assert.equal(classifyScreen('claude', 'Do you trust this folder?').safeToAnswer, false);
});

test('describeBlocked names the exact keys command; login has none', () => {
  assert.equal(keysCommand({ task: 't', name: 'w1', keys: ['enter'] }), 'foreman keys --task t w1 enter');
  assert.match(describeBlocked({ kind: 'claude', screen: CLAUDE, task: 't', name: 'w1' }), /^claude asks to trust this folder; answer it with: foreman keys --task t w1 down enter$/);
  assert.match(describeBlocked({ kind: 'agy', screen: AGY, task: 't', name: 'w1' }), /answer it with: foreman keys --task t w1 enter$/);
  assert.doesNotMatch(describeBlocked({ kind: 'agy', screen: 'Trust this folder?', task: 't', name: 'w1' }), /keys/);
  assert.doesNotMatch(describeBlocked({ kind: 'agy', screen: 'Please log in', task: 't', name: 'w1' }), /keys/);
  assert.equal(describeBlocked({ kind: 'agy', screen: 'busy', task: 't', name: 'w1' }), null);
});
