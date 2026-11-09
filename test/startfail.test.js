import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFailureHint, recordStartResults } from '../src/startfail.js';

test('an expired codex sign-in gets the "codex login" hint', () => {
  assert.match(startFailureHint('codex', 'Your access token could not be refreshed. Please log out and sign in again.'), /run "codex login"$/);
  assert.equal(startFailureHint('claude', 'Your access token could not be refreshed'), 'Your access token could not be refreshed');
  const files = {};
  recordStartResults({
    paths: { home: '/h', startFailures: '/h/f.json' }, readFile: (p) => files[p] ?? '{}', writeFile: (p, d) => { files[p] = d; }, now: () => 0,
    failed: [{ kind: 'codex', message: 'Your access token could not be refreshed' }],
  });
  assert.match(JSON.parse(files['/h/f.json']).codex.message, /codex login/);
});
