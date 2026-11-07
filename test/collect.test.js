import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run as runProcess } from '../src/run.js';
import { createGit } from '../src/git.js';
import { worktreeRoot } from '../src/runs.js';
import { workerStatus, mergeWorkers, land, cleanup, findLeftovers } from '../src/collect.js';
import { makeRepo, commitFile, git as rawGit } from './git-repo.js';

const git = createGit({ run: runProcess });

async function setup(names = ['w1', 'w2']) {
  const repo = makeRepo({ 'a.txt': 'one\n', 'shared.txt': 'base\n' });
  const home = mkdtempSync(path.join(tmpdir(), 'foreman-home-'));
  const paths = { runs: path.join(home, 'runs'), worktrees: path.join(home, 'worktrees') };
  const base = await git.head(repo);
  const root = worktreeRoot({ paths, repo, task: 't' });
  const workers = [];
  for (const [i, name] of names.entries()) {
    const worktree = path.join(root, name);
    const branch = `foreman-work/t/${name}`;
    await git.addWorktree(repo, worktree, branch, base);
    const reportDir = path.join(paths.runs, 't', name);
    mkdirSync(reportDir, { recursive: true });
    workers.push({ name, kind: 'claude', model: null, paneId: `w1:p${i + 2}`, worktree, branch, reportDir });
  }
  return { repo, paths, run: { task: 't', repo, base, createdAt: 'x', workers } };
}

function fakeHerdr(log, { failClose = false, agents = null, panes = [] } = {}) {
  return {
    agentList: async () => agents ?? [{ name: 'w1', pane_id: 'w1:p2' }, { name: 'w2', pane_id: 'w1:p3' }, { name: 'w3', pane_id: 'w1:p4' }],
    paneList: async () => panes,
    paneClose: async (id) => {
      log.push(['close', id]);
      if (failClose) throw Object.assign(new Error('boom'), { code: 'herdr_failed' });
    },
  };
}

test('status shows dirty, commits ahead and reports', async () => {
  const { run } = await setup();
  commitFile(run.workers[0].worktree, 'b.txt', 'b\n');
  writeFileSync(path.join(run.workers[1].worktree, 'a.txt'), 'edited\n');
  writeFileSync(path.join(run.workers[1].reportDir, 'proposals.md'), '- [high] a.txt: x -> y\n');
  const st = await workerStatus({ run, git, exists: existsSync });
  assert.deepEqual(st.map((s) => [s.name, s.dirty, s.commitsAhead, s.proposals, s.report]), [
    ['w1', false, 1, false, false],
    ['w2', true, 0, true, false],
  ]);
  assert.deepEqual(st[1].changedFiles, ['a.txt']);
});

test('merge collects committed work into foreman branch', async () => {
  const { run, paths } = await setup();
  commitFile(run.workers[0].worktree, 'b.txt', 'b\n');
  commitFile(run.workers[1].worktree, 'c.txt', 'c\n');
  const before = await git.currentBranch(run.repo);
  const res = await mergeWorkers({ run, git, paths, exists: existsSync });
  assert.equal(res.branch, 'foreman/t');
  assert.deepEqual(res.merged, ['w1', 'w2']);
  assert.equal(res.conflict, null);
  assert.ok(existsSync(path.join(res.worktree, 'b.txt')) && existsSync(path.join(res.worktree, 'c.txt')));
  assert.equal(await git.currentBranch(run.repo), before);
  assert.equal(existsSync(path.join(run.repo, 'b.txt')), false, 'user checkout untouched');
});

test('merge can run twice and skips workers without commits', async () => {
  const { run, paths } = await setup();
  commitFile(run.workers[0].worktree, 'b.txt', 'b\n');
  await mergeWorkers({ run, git, paths, exists: existsSync });
  const again = await mergeWorkers({ run, git, paths, exists: existsSync });
  assert.deepEqual(again.merged, ['w1']);
  assert.deepEqual(again.skipped, [{ worker: 'w2', reason: 'no commits' }]);
});

test('merge refuses dirty worker', async () => {
  const { run, paths } = await setup();
  writeFileSync(path.join(run.workers[0].worktree, 'a.txt'), 'edited\n');
  const res = await mergeWorkers({ run, git, paths, exists: existsSync });
  assert.deepEqual(res.refused, [{ worker: 'w1', reason: 'uncommitted changes' }]);
});

test('merge stops at conflict and leaves merge worktree clean', async () => {
  const { run, paths } = await setup(['w1', 'w2', 'w3']);
  commitFile(run.workers[0].worktree, 'shared.txt', 'from w1\n');
  commitFile(run.workers[1].worktree, 'shared.txt', 'from w2\n');
  commitFile(run.workers[2].worktree, 'd.txt', 'd\n');
  const res = await mergeWorkers({ run, git, paths, exists: existsSync });
  assert.deepEqual(res.merged, ['w1']);
  assert.deepEqual(res.conflict, { worker: 'w2', files: ['shared.txt'] });
  assert.equal(await git.isDirty(res.worktree), false);
});

test('merge --only limits workers', async () => {
  const { run, paths } = await setup();
  commitFile(run.workers[0].worktree, 'b.txt', 'b\n');
  commitFile(run.workers[1].worktree, 'c.txt', 'c\n');
  const res = await mergeWorkers({ run, git, paths, exists: existsSync, only: ['w2'] });
  assert.deepEqual(res.merged, ['w2']);
});

test('land refuses when user repo is dirty', async () => {
  const { run, paths } = await setup();
  commitFile(run.workers[0].worktree, 'b.txt', 'b\n');
  await mergeWorkers({ run, git, paths, exists: existsSync });
  writeFileSync(path.join(run.repo, 'a.txt'), 'local edit\n');
  const res = await land({ run, git });
  assert.equal(res.ok, false);
  assert.match(res.reason, /uncommitted changes/);
});

test('land ignores untracked files and merges into current branch', async () => {
  const { run, paths } = await setup();
  commitFile(run.workers[0].worktree, 'b.txt', 'b\n');
  await mergeWorkers({ run, git, paths, exists: existsSync });
  writeFileSync(path.join(run.repo, 'notes.txt'), 'scratch\n');
  const res = await land({ run, git });
  assert.deepEqual(res, { ok: true, branch: 'foreman/t' });
  assert.ok(existsSync(path.join(run.repo, 'b.txt')));
});

test('land without merge branch explains', async () => {
  const { run } = await setup();
  const res = await land({ run, git });
  assert.equal(res.ok, false);
  assert.match(res.reason, /foreman merge/);
});

test('cleanup closes panes before removing worktrees', async () => {
  const { run, paths } = await setup();
  const log = [];
  const order = [];
  const tracingGit = { ...git, removeWorktree: async (r, wt) => { order.push('rm'); return git.removeWorktree(r, wt); } };
  const herdr = { ...fakeHerdr(log), paneClose: async (id) => { order.push('close'); log.push(id); } };
  const res = await cleanup({ run, git: tracingGit, herdr, paths, exists: existsSync });
  assert.deepEqual(order.slice(0, 2), ['close', 'close']);
  assert.equal(res.closedPanes.length, 2);
  assert.equal(res.removedWorktrees.length, 2);
  assert.deepEqual(res.deletedBranches, ['foreman-work/t/w1', 'foreman-work/t/w2']);
  assert.deepEqual(res.errors, []);
  assert.equal(existsSync(run.workers[0].worktree), false);
});

test('cleanup continues after a failing step', async () => {
  const { run, paths } = await setup(['w1']);
  const log = [];
  const res = await cleanup({ run, git, herdr: fakeHerdr(log, { failClose: true }), paths, exists: existsSync });
  assert.equal(res.errors.length, 1);
  assert.equal(existsSync(run.workers[0].worktree), false);
});

test('cleanup retries a locked worktree and falls back to deleting the folder', async () => {
  const { run, paths } = await setup(['w1']);
  const wt = run.workers[0].worktree;
  let left = true;
  const calls = [];
  const lockedGit = {
    ...git,
    removeWorktree: async () => { calls.push('remove'); throw new Error('Permission denied'); },
    pruneWorktrees: async (repo) => { calls.push('prune'); return git.pruneWorktrees(repo); },
  };
  const exists = (p) => (p === wt ? left : existsSync(p));
  const removeDir = (d) => { calls.push('rmdir'); assert.equal(d, wt); rmSync(d, { recursive: true, force: true }); left = false; };
  const res = await cleanup({ run, git: lockedGit, herdr: fakeHerdr([]), paths, exists, removeDir });
  assert.deepEqual(calls, ['remove', 'remove', 'remove', 'rmdir', 'prune']);
  assert.deepEqual(res.removedWorktrees, [wt]);
  assert.deepEqual(res.errors, []);
});

test('cleanup never closes a pane that another agent now uses', async () => {
  const { run, paths } = await setup(['w1', 'w2']);
  const log = [];
  // After a herdr restart w1:p2 hosts someone else; w1:p3 is a plain shell inside w2's worktree.
  const herdr = fakeHerdr(log, {
    agents: [{ name: 'reviewer', pane_id: 'w1:p2' }],
    panes: [{ pane_id: 'w1:p2', cwd: '/elsewhere' }, { pane_id: 'w1:p3', cwd: run.workers[1].worktree }],
  });
  const res = await cleanup({ run, git, herdr, paths, exists: existsSync });
  assert.deepEqual(log.filter(([k]) => k === 'close').map(([, id]) => id), ['w1:p3']);
  assert.deepEqual(res.closedPanes, ['w1:p3']);
});

test('findLeftovers lists runs with worktrees or live workers', async () => {
  const { run, paths } = await setup(['w1']);
  const done = { ...run, task: 'old', workers: [{ ...run.workers[0], name: 'gone', worktree: path.join(paths.worktrees, 'nope') }] };
  const list = findLeftovers({ runs: [run, done], paths, exists: existsSync, agents: [{ name: 'w1', pane_id: 'w1:p2' }] });
  assert.deepEqual(list.map((l) => [l.task, l.worktrees.length, l.liveWorkers]), [['t', 1, ['w1']]]);
});

test('cleanup removes merge worktree and keeps foreman branch unless asked', async () => {
  const { run, paths } = await setup(['w1']);
  commitFile(run.workers[0].worktree, 'b.txt', 'b\n');
  const merged = await mergeWorkers({ run, git, paths, exists: existsSync });
  const log = [];
  await cleanup({ run, git, herdr: fakeHerdr(log), paths, exists: existsSync });
  assert.equal(existsSync(merged.worktree), false);
  assert.equal(await git.branchExists(run.repo, 'foreman/t'), true);
  const { run: run2, paths: paths2 } = await setup(['w1']);
  commitFile(run2.workers[0].worktree, 'b.txt', 'b\n');
  await mergeWorkers({ run: run2, git, paths: paths2, exists: existsSync });
  await cleanup({ run: run2, git, herdr: fakeHerdr(log), paths: paths2, exists: existsSync, deleteBranch: true });
  assert.equal(await git.branchExists(run2.repo, 'foreman/t'), false);
  rawGit(run2.repo, 'status');
});
