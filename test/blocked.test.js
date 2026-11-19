import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScreen, describeBlocked, keysCommand, trustKeys } from '../src/blocked.js';

test('classifies the four kinds of blocking screens', () => {
  assert.equal(classifyScreen('claude', 'Do you trust the files in this folder?').type, 'trust');
  assert.equal(classifyScreen('agy', 'Please sign in to continue').type, 'login');
  assert.equal(classifyScreen('codex', 'Update available! 0.1 -> 0.2\n › 1. Update now\n   2. Skip').type, 'update');
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

// The same dialogs in a pane about 40 columns wide: sentences wrap.
const NARROW_CLAUDE = [
  'Quick safety check: is this a project',
  'you created or one you trust? (Like',
  'your own code, a well-known open',
  'source project, or work from your team).',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
].join('\n');
const NARROW_AGY = 'Do you trust the files in\nthis folder?\n\n > Yes, I trust this folder\n   No, exit\n';
const NARROW_CODEX = 'Do you trust the contents of\nthis directory? Working with\nuntrusted contents comes with\nhigher risk of prompt injection.\n\n › 1. Yes, continue\n   2. No, quit\n';

test('trust dialogs wrapped at 40 columns are still found and answered', () => {
  assert.equal(classifyScreen('claude', NARROW_CLAUDE).type, 'trust');
  assert.deepEqual(classifyScreen('claude', NARROW_CLAUDE).keys, ['down', 'enter']);
  assert.deepEqual(classifyScreen('agy', NARROW_AGY).keys, ['enter']);
  assert.deepEqual(classifyScreen('codex', NARROW_CODEX).keys, ['1']);
  assert.equal(classifyScreen('codex', NARROW_CODEX).safeToAnswer, true);
});

test('permission, update and login prompts wrapped at 40 columns are found', () => {
  assert.equal(classifyScreen('pi', 'Do you want to\nrun rm -rf build?\n  1. Yes\n  2. No').type, 'permission');
  assert.equal(classifyScreen('pi', 'Allow this tool to\n   edit   files?\n ❯ Yes\n   No').type, 'permission');
  assert.equal(classifyScreen('codex', 'Update\navailable! 0.1 -> 0.2\n › 1. Update now\n   2. Skip').type, 'update');
  assert.equal(classifyScreen('agy', 'Please sign\nin to continue').type, 'login');
});

test('describeBlocked names the exact keys command; login has none', () => {
  assert.equal(keysCommand({ task: 't', name: 'w1', keys: ['enter'] }), 'foreman keys --task t w1 enter');
  assert.match(describeBlocked({ kind: 'claude', screen: CLAUDE, task: 't', name: 'w1' }), /^claude asks to trust this folder; answer it with: foreman keys --task t w1 down enter$/);
  assert.match(describeBlocked({ kind: 'agy', screen: AGY, task: 't', name: 'w1' }), /answer it with: foreman keys --task t w1 enter$/);
  assert.doesNotMatch(describeBlocked({ kind: 'agy', screen: 'Trust this folder?', task: 't', name: 'w1' }), /keys/);
  assert.doesNotMatch(describeBlocked({ kind: 'agy', screen: 'Please log in', task: 't', name: 'w1' }), /keys/);
  assert.equal(describeBlocked({ kind: 'agy', screen: 'busy', task: 't', name: 'w1' }), null);
});

// Captured in the Herdr app (2026-11-19): claude working in auto mode, pane ~55 columns.
const CLAUDE_AUTO_FOOTER = [
  '✽ Noodling… (3m 23s · ↓ 13.8k tokens)',
  '   Update available! Run: winget upgrade Anthropic.C…',
  '❯ ',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to inte…',
].join('\n');

test('banners, footers and tips are not questions', () => {
  assert.equal(classifyScreen('claude', CLAUDE_AUTO_FOOTER), null);
  assert.equal(classifyScreen('claude', '❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)'), null);
  assert.equal(classifyScreen('codex', '  /permissions - choose what Codex is allowed to do\n  /model - choose the model\n› Ask Codex to do anything'), null);
  assert.equal(classifyScreen('agy', 'Running with permissions skipped\n> \n  approve: auto'), null);
  assert.equal(classifyScreen('pi', 'type /login to switch accounts\n> '), null);
  // A real question under the same banner is still found, and not taken for the update.
  const asks = `${CLAUDE_AUTO_FOOTER}\nDo you want to run npm test?\n ❯ 1. Yes\n   2. No`;
  assert.equal(classifyScreen('claude', asks).type, 'permission');
});

test('a sign-in said outright is found without options', () => {
  assert.equal(classifyScreen('codex', 'Not logged in. Run codex login').type, 'login');
  assert.equal(classifyScreen('codex', '› 1. Sign in with ChatGPT\n  2. Provide your own API key').type, 'login');
});

test('the kind hc reports with a blocked status decides what is asked', () => {
  assert.equal(classifyScreen('codex', 'working on it', { blockedKind: 'permission' }).type, 'permission');
  assert.equal(classifyScreen('codex', '', { blockedKind: 'auth' }).type, 'login');
  assert.equal(classifyScreen('claude', CLAUDE, { blockedKind: 'question' }).type, 'trust');
  assert.equal(classifyScreen('codex', 'working on it', { blockedKind: null }), null);
  assert.match(describeBlocked({ kind: 'codex', screen: '', task: 't', name: 'w1', blockedKind: 'permission' }), /codex asks for permission/);
});

test('a notice that says esc dismisses it is no question: esc closes it, even when hc calls it a permission', async () => {
  const { AGY_AUTO_NOTICE } = await import('./fixtures/screens.js');
  const c = classifyScreen('agy', AGY_AUTO_NOTICE, { blockedKind: 'permission' });
  assert.deepEqual(c, { type: 'notice', label: 'agy shows a notice', keys: ['esc'], safeToAnswer: true });
  assert.match(describeBlocked({ kind: 'agy', screen: AGY_AUTO_NOTICE, task: 't', name: 'w1' }), /agy shows a notice; answer it with: foreman keys --task t w1 esc$/);
  // With options under it, it asks something after all.
  assert.equal(classifyScreen('agy', 'Allow this command?\n ❯ 1. Yes\n   2. No\n esc to dismiss').type, 'permission');
});

test('opencode that updated itself must be restarted: no keys, closing its modal ends it', async () => {
  const { OPENCODE_UPDATE_MODAL, OPENCODE_READY } = await import('./fixtures/screens.js');
  const c = classifyScreen('opencode', OPENCODE_UPDATE_MODAL);
  assert.deepEqual(c, { type: 'restart', label: 'opencode updated itself and must be restarted', keys: null, safeToAnswer: false });
  assert.match(describeBlocked({ kind: 'opencode', screen: OPENCODE_UPDATE_MODAL, task: 't', name: 'w1' }), /must be restarted; close it and run foreman spawn again$/);
  assert.equal(classifyScreen('opencode', OPENCODE_READY), null);
});
