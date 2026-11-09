import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStartFlags, flagsOf } from '../src/startflags.js';
import { appArgv } from '../src/inventory/kinds.js';
import { recordStartResults, recentStartFailures } from '../src/startfail.js';

test('flagsOf keeps flags, not their values', () => {
  assert.deepEqual(flagsOf(['--model', 'opus', '--tools', 'Bash,Read', '-m', 'x', '--model']), ['--model', '--tools', '-m']);
});

test('a flag missing from the agent help is named once per flag', async () => {
  const run = async () => ({ stdout: 'usage: codex [--model m]', stderr: '' });
  const warnings = await checkStartFlags({ run, byKind: new Map([['codex', ['--model', '--no-daemon']]]) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"codex --help" does not mention --no-daemon/);
});

test('an agent whose help cannot be read is skipped', async () => {
  const run = async () => { throw new Error('ENOENT'); };
  assert.deepEqual(await checkStartFlags({ run, byKind: new Map([['codex', ['--x']]]) }), []);
});

test('codex starts without --no-daemon in the Herdr app', () => {
  assert.deepEqual(appArgv('codex'), ['codex']);
  assert.deepEqual(appArgv('codex', ['-m', 'gpt']), ['codex', '-m', 'gpt']);
});

test('start failures expire after a day', () => {
  const files = {};
  const io = { paths: { home: '/h', startFailures: '/h/f.json' }, readFile: (f) => { if (!(f in files)) throw new Error('x'); return files[f]; }, writeFile: (f, d) => { files[f] = d; }, mkdir: () => {} };
  recordStartResults({ ...io, now: () => 0, failed: [{ kind: 'codex', message: 'boom' }] });
  assert.equal(recentStartFailures({ ...io, now: () => 1000 }).codex.message, 'boom');
  assert.deepEqual(recentStartFailures({ ...io, now: () => 25 * 3600 * 1000 }), {});
});
