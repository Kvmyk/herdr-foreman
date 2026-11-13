import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { run } from '../src/run.js';
import { createGit } from '../src/git.js';
import { makeRepo, makeTempDir, commitFile, git as rawGit } from './git-repo.js';

const g = createGit({ run });

test('toplevel finds repo root and null outside', async () => {
  const repo = makeRepo();
  assert.equal(path.resolve(await g.toplevel(repo)), path.resolve(repo));
  const outside = makeTempDir('foreman-nogit-');
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
  const wt = path.join(makeTempDir('foreman-wt-'), 'w1');
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

test('createSnapshot copies modified, staged, deleted and untracked files without touching index or worktree', async () => {
  const repo = makeRepo({ 'a.txt': 'one\n', 'gone.txt': 'gone\n' });
  rawGit(repo, 'config', 'core.autocrlf', 'false');
  const head = await g.head(repo);
  writeFileSync(path.join(repo, 'a.txt'), 'edited\n');            // modified
  unlinkSync(path.join(repo, 'gone.txt'));                        // deleted
  writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');       // staged
  rawGit(repo, 'add', 'staged.txt');
  writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');       // untracked

  const snap = await g.createSnapshot(repo, 'chore: snapshot');
  assert.match(snap, /^[0-9a-f]{40}$/);

  // The snapshot holds every kind of change.
  const show = (f) => rawGit(repo, 'show', `${snap}:${f}`);
  assert.equal(show('a.txt'), 'edited');
  assert.equal(show('staged.txt'), 'staged');
  assert.equal(show('new.txt'), 'untracked');
  assert.equal(await g.fileMatchesTree(repo, snap, 'gone.txt'), true); // absent on both sides
  let missing = false;
  try { show('gone.txt'); } catch { missing = true; }
  assert.equal(missing, true);
  assert.equal(rawGit(repo, 'rev-parse', `${snap}^`), head);

  // The user's index, working tree and HEAD are untouched.
  assert.equal(await g.head(repo), head);
  const entries = rawGit(repo, 'status', '--porcelain', '-z').split('\0').filter(Boolean);
  // The first entry may lose its leading column to trim; a.txt is not staged here.
  assert.ok(entries.some((e) => e.startsWith('M a.txt')), 'a.txt is still modified, not committed');
  assert.ok(entries.includes('A  staged.txt'), 'staged.txt is still staged');
  assert.ok(entries.includes(' D gone.txt'), 'gone.txt is still deleted');
  assert.ok(entries.includes('?? new.txt'), 'new.txt is still untracked');
  assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'edited\n');
  assert.equal(existsSync(path.join(repo, 'gone.txt')), false);
});

test('a worktree can start from a snapshot; fileMatchesTree and commitTracked support land', async () => {
  const repo = makeRepo({ 'a.txt': 'one\n' });
  rawGit(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(repo, 'a.txt'), 'edited\n');
  const snap = await g.createSnapshot(repo, 'chore: snapshot');

  const wt = path.join(makeTempDir('foreman-wt-'), 'w1');
  await g.addWorktree(repo, wt, 'foreman-work/t/w1', snap);
  assert.equal(readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'edited\n');

  // fileMatchesTree and commitTracked, used by land:
  assert.equal(await g.fileMatchesTree(repo, snap, 'a.txt'), true);
  writeFileSync(path.join(repo, 'a.txt'), 'user changed\n');
  assert.equal(await g.fileMatchesTree(repo, snap, 'a.txt'), false);
  const commit = await g.commitTracked(repo, 'chore: save unsaved work');
  assert.equal(rawGit(repo, 'show', 'HEAD:a.txt'), 'user changed');
  assert.equal(await g.fileMatchesTree(repo, commit, 'a.txt'), true);
  assert.equal(await g.isDirty(repo, { untracked: false }), false);
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
  const wt = path.join(makeTempDir('foreman-wt-'), 'w1');
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
  const wt = path.join(makeTempDir('foreman-wt-'), 'w1');
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
  const bare = path.join(makeTempDir('foreman-bare-'), 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  rawGit(repo, 'remote', 'add', 'origin', bare);
  const branch = rawGit(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const wt = path.join(makeTempDir('foreman-wt-'), 'w1');
  await g.addWorktree(repo, wt, 'foreman-work/t/w1', await g.head(repo));
  await g.armPushGuard(wt);

  const named = tryPush(wt, 'origin', 'HEAD:refs/heads/w1');
  assert.notEqual(named, null);
  assert.match(named, /does not appear to be a git repository|push blocked by foreman/);
  assert.doesNotMatch(named, /not a git command/);
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
  const wt = path.join(makeTempDir('foreman-wt-'), 'w1');
  await g.addWorktree(repo, wt, 'foreman-work/t/w1', await g.head(repo));
  assert.equal(await g.pushGuardArmed(wt), false);
  await g.armPushGuard(wt);
  assert.equal(await g.pushGuardArmed(wt), true);
  rmSync(path.join(rawGit(wt, 'rev-parse', '--absolute-git-dir'), 'foreman-hooks', 'pre-push'));
  assert.equal(await g.pushGuardArmed(wt), false);
});

test('pushGuardArmed turns false after a remote is added in the worker worktree', async () => {
  const repo = makeRepo();
  const wt = path.join(makeTempDir('foreman-wt-'), 'w1');
  await g.addWorktree(repo, wt, 'foreman-work/t/w1', await g.head(repo));
  await g.armPushGuard(wt);
  assert.equal(await g.pushGuardArmed(wt), true);
  rawGit(wt, 'remote', 'add', 'sneaky', 'https://example.invalid/y.git');
  assert.equal(await g.pushGuardArmed(wt), false);
});

test('validBranchName follows git rules and merge takes a message', async () => {
  const repo = makeRepo();
  assert.equal(await g.validBranchName(repo, 'feat/ok-name'), true);
  assert.equal(await g.validBranchName(repo, 'feat/a..b'), false);
  assert.equal(await g.validBranchName(repo, 'feat/a b'), false);
  rawGit(repo, 'checkout', '-q', '-b', 'side');
  commitFile(repo, 'z.txt', 'z\n');
  rawGit(repo, 'checkout', '-q', '-');
  assert.deepEqual(await g.merge(repo, 'side', 'Merge side (custom)'), { ok: true });
  assert.equal(rawGit(repo, 'log', '-1', '--format=%s'), 'Merge side (custom)');
});
