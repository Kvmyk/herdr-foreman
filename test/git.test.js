import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/run.js';
import { createGit } from '../src/git.js';
import { makeRepo, commitFile, git as rawGit } from './git-repo.js';

const g = createGit({ run });

test('toplevel finds repo root and null outside', async () => {
  const repo = makeRepo();
  assert.equal(path.resolve(await g.toplevel(repo)), path.resolve(repo));
  const outside = mkdtempSync(path.join(tmpdir(), 'foreman-nogit-'));
  // The temp dir may sit inside a repo (e.g. a home directory under git).
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(outside);
  try {
    assert.equal(await g.toplevel(outside), null);
  } finally {
    delete process.env.GIT_CEILING_DIRECTORIES;
  }
});

test('addWorktree creates branch at base', async () => {
  const repo = makeRepo();
  const base = await g.head(repo);
  const wt = path.join(mkdtempSync(path.join(tmpdir(), 'foreman-wt-')), 'w1');
  await g.addWorktree(repo, wt, 'foreman-work/t/w1', base);
  assert.ok(existsSync(path.join(wt, 'a.txt')));
  assert.equal(await g.currentBranch(wt), 'foreman-work/t/w1');
  assert.equal(await g.branchExists(repo, 'foreman-work/t/w1'), true);
  assert.equal(await g.commitsAhead(wt, base), 0);
  commitFile(wt, 'b.txt', 'b\n');
  assert.equal(await g.commitsAhead(wt, base), 1);
});

test('isDirty and changedFiles detect changes', async () => {
  const repo = makeRepo();
  assert.equal(await g.isDirty(repo), false);
  writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
  writeFileSync(path.join(repo, 'new.txt'), 'x\n');
  assert.equal(await g.isDirty(repo), true);
  assert.deepEqual((await g.changedFiles(repo)).sort(), ['a.txt', 'new.txt']);
});

test('merge conflict reports files and aborts', async () => {
  const repo = makeRepo();
  rawGit(repo, 'checkout', '-q', '-b', 'other');
  commitFile(repo, 'a.txt', 'other\n');
  rawGit(repo, 'checkout', '-q', '-');
  commitFile(repo, 'a.txt', 'mine\n');
  const res = await g.merge(repo, 'other');
  assert.deepEqual(res, { ok: false, files: ['a.txt'] });
  assert.equal(await g.isDirty(repo), false);
});

test('clean merge succeeds', async () => {
  const repo = makeRepo();
  rawGit(repo, 'checkout', '-q', '-b', 'other');
  commitFile(repo, 'b.txt', 'b\n');
  rawGit(repo, 'checkout', '-q', '-');
  assert.deepEqual(await g.merge(repo, 'other'), { ok: true });
  assert.ok(existsSync(path.join(repo, 'b.txt')));
});

test('commonDir points at the shared .git, also from a worktree', async () => {
  const repo = makeRepo();
  const wt = path.join(mkdtempSync(path.join(tmpdir(), 'foreman-wt-')), 'w1');
  await g.addWorktree(repo, wt, 'foreman-work/t/w1', await g.head(repo));
  const common = path.join(repo, '.git');
  assert.equal(path.resolve(await g.commonDir(repo)), path.resolve(common));
  assert.equal(path.resolve(await g.commonDir(wt)), path.resolve(common));
  writeFileSync(path.join(common, 'info', 'exclude'), '.foreman/\n');
  mkdirSync(path.join(wt, '.foreman'));
  writeFileSync(path.join(wt, '.foreman', 'proposals.md'), '- x\n');
  assert.equal(await g.isDirty(wt), false, 'excluded reports do not dirty the worktree');
});

test('removeWorktree and deleteBranch clean up', async () => {
  const repo = makeRepo();
  const wt = path.join(mkdtempSync(path.join(tmpdir(), 'foreman-wt-')), 'w1');
  await g.addWorktree(repo, wt, 'foreman-work/t/w1', await g.head(repo));
  await g.removeWorktree(repo, wt);
  assert.equal(existsSync(wt), false);
  await g.deleteBranch(repo, 'foreman-work/t/w1');
  assert.equal(await g.branchExists(repo, 'foreman-work/t/w1'), false);
});

function tryPush(dir, ...args) {
  try {
    execFileSync('git', ['-C', dir, 'push', ...args], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return String(err.stderr);
  }
}

test('push guard blocks pushes from a worker worktree and leaves the main checkout alone', async () => {
  const repo = makeRepo();
  const bare = path.join(mkdtempSync(path.join(tmpdir(), 'foreman-bare-')), 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  rawGit(repo, 'remote', 'add', 'origin', bare);
  const branch = rawGit(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const wt = path.join(mkdtempSync(path.join(tmpdir(), 'foreman-wt-')), 'w1');
  await g.addWorktree(repo, wt, 'foreman-work/t/w1', await g.head(repo));
  await g.armPushGuard(wt);

  assert.notEqual(tryPush(wt, 'origin', 'HEAD:refs/heads/w1'), null);
  assert.notEqual(tryPush(wt, bare, 'HEAD:refs/heads/w1-direct'), null);
  assert.match(tryPush(wt, bare, 'HEAD:refs/heads/w1-direct'), /push blocked by foreman/);
  assert.equal(rawGit(bare, 'branch', '--list').trim(), '');

  assert.equal(tryPush(repo, 'origin', `HEAD:refs/heads/${branch}`), null);
  assert.match(rawGit(bare, 'branch', '--list'), new RegExp(branch));
  assert.throws(() => rawGit(repo, 'config', '--get', 'core.hooksPath'));
  assert.throws(() => rawGit(repo, 'config', '--get', 'remote.origin.pushurl'));
  assert.equal(rawGit(repo, 'config', '--get', 'remote.origin.url'), bare);
});

test('pushGuardArmed turns false when the hook is deleted', async () => {
  const repo = makeRepo();
  rawGit(repo, 'remote', 'add', 'origin', 'https://example.invalid/x.git');
  const wt = path.join(mkdtempSync(path.join(tmpdir(), 'foreman-wt-')), 'w1');
  await g.addWorktree(repo, wt, 'foreman-work/t/w1', await g.head(repo));
  assert.equal(await g.pushGuardArmed(wt), false);
  await g.armPushGuard(wt);
  assert.equal(await g.pushGuardArmed(wt), true);
  rmSync(path.join(rawGit(wt, 'rev-parse', '--absolute-git-dir'), 'foreman-hooks', 'pre-push'));
  assert.equal(await g.pushGuardArmed(wt), false);
});
