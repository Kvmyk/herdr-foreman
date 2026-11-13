import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { canonicalPath, pathKey } from '../src/pathkey.js';
import { makeTempDir } from './git-repo.js';
import { worktreeRoot } from '../src/runs.js';

test('pathKey of a path that does not exist is resolve, no trailing slash, lowercase only on win32', () => {
  const p = path.resolve('/no/such/Dir');
  assert.equal(pathKey(p + path.sep, { platform: 'linux' }), p);
  assert.equal(pathKey(p, { platform: 'win32', realpath: () => { throw new Error('ENOENT'); } }), p.toLowerCase());
});

test('pathKey uses the real path on win32 only', () => {
  const real = () => 'C:/Users/Long/Proj/';
  assert.equal(pathKey('C:/Users/SHORT~1/Proj', { platform: 'win32', realpath: real }), 'c:/users/long/proj');
  assert.equal(canonicalPath('/a/b', { platform: 'linux', realpath: real }), path.resolve('/a/b'));
});

test('an 8.3 short path and the long one give the same key and worktree root', { skip: process.platform !== 'win32' }, (t) => {
  const dir = makeTempDir('foreman-pathkey-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sub = path.join(dir, 'a-long-folder-name');
  mkdirSync(sub);
  const short = execFileSync('cmd', ['/c', `for %I in (${sub}) do @echo %~sI`], { encoding: 'utf8' }).trim();
  if (short.toLowerCase() === sub.toLowerCase()) return t.skip('8.3 names are disabled on this volume');
  assert.equal(pathKey(short), pathKey(sub));
  const paths = { worktrees: path.resolve('/w') };
  const a = worktreeRoot({ paths, repo: short, task: 't' });
  const b = worktreeRoot({ paths, repo: sub, task: 't' });
  assert.equal(path.dirname(path.dirname(a)), path.dirname(path.dirname(b)));
  assert.equal(path.basename(path.dirname(a)).split('-').pop(), path.basename(path.dirname(b)).split('-').pop());
});
