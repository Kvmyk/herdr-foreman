import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { slugify, uniqueSlug, saveRun, loadRun, worktreeRoot } from '../src/runs.js';

test('slugify transliterates Polish and trims', () => {
  assert.equal(slugify('Sprawdź błąd w logowaniu!'), 'sprawdz-blad-w-logowaniu');
  assert.equal(slugify('ŻÓŁĆ gęślą jaźń'), 'zolc-gesla-jazn');
  assert.equal(slugify('???'), 'task');
  const long = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
  assert.ok(long.length <= 40);
  assert.ok(!long.endsWith('-'));
  assert.equal(slugify('Znajdź i popraw błędy w kalkulatorze i dopisz brakujące testy'), 'znajdz-i-popraw-bledy-w-kalkulatorze-i');
  assert.equal(slugify('x'.repeat(50)), 'x'.repeat(40));
});

test('uniqueSlug appends a number', () => {
  assert.equal(uniqueSlug('x', () => false), 'x');
  assert.equal(uniqueSlug('x', (s) => s === 'x'), 'x-2');
  assert.equal(uniqueSlug('x', (s) => s === 'x' || s === 'x-2'), 'x-3');
});

test('run records round-trip', () => {
  const files = {};
  const p = { runs: '/s/runs' };
  const run = { task: 'fix-login', repo: '/r', base: 'abc', createdAt: 'now', workers: [] };
  saveRun(run, { paths: p, writeFile: (f, d) => { files[f] = d; }, mkdir: () => {} });
  const loaded = loadRun('fix-login', { paths: p, readFile: (f) => files[f] });
  assert.deepEqual(loaded, run);
  assert.equal(loadRun('nope', { paths: p, readFile: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), null);
});

test('worktree root is outside the repo and stable', () => {
  const p = { worktrees: path.join('/s', 'worktrees') };
  const a = worktreeRoot({ paths: p, repo: path.resolve('/code/shop'), task: 'fix-login' });
  const b = worktreeRoot({ paths: p, repo: path.resolve('/code/shop'), task: 'fix-login' });
  const other = worktreeRoot({ paths: p, repo: path.resolve('/other/shop'), task: 'fix-login' });
  assert.equal(a, b);
  assert.notEqual(a, other);
  assert.ok(a.startsWith(p.worktrees));
  assert.match(path.basename(path.dirname(a)), /^shop-[0-9a-f]{6}$/);
  assert.equal(path.basename(a), 'fix-login');
});
