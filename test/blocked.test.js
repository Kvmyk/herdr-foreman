import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScreen, describeBlocked, keysCommand } from '../src/blocked.js';

test('classifies the four kinds of blocking screens', () => {
  assert.equal(classifyScreen('claude', 'Do you trust the files in this folder?').type, 'trust');
  assert.equal(classifyScreen('agy', 'Please sign in to continue').type, 'login');
  assert.equal(classifyScreen('codex', 'Update available! 0.1 -> 0.2').type, 'update');
  assert.equal(classifyScreen('pi', 'Run rm -rf build? [y/n]').type, 'permission');
  assert.equal(classifyScreen('pi', 'compiling...'), null);
});

test('only claude and codex trust dialogs are safe to answer for the user', () => {
  assert.equal(classifyScreen('claude', 'Do you trust this folder?').safeToAnswer, true);
  assert.equal(classifyScreen('agy', 'Do you trust this folder?').safeToAnswer, false);
});

test('describeBlocked names the exact keys command; login has none', () => {
  assert.equal(keysCommand({ task: 't', name: 'w1', keys: ['enter'] }), 'foreman keys --task t w1 enter');
  assert.match(describeBlocked({ kind: 'agy', screen: 'Trust this folder?', task: 't', name: 'w1' }), /^agy asks to trust this folder; answer it with: foreman keys --task t w1 enter$/);
  assert.doesNotMatch(describeBlocked({ kind: 'agy', screen: 'Please log in', task: 't', name: 'w1' }), /keys/);
  assert.equal(describeBlocked({ kind: 'agy', screen: 'busy', task: 't', name: 'w1' }), null);
});
