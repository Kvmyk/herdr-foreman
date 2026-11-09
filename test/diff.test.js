import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run as runProcess } from '../src/run.js';
import { createGit } from '../src/git.js';
import { worktreeRoot } from '../src/runs.js';
import { mergeWorkers } from '../src/collect.js';
import { runDiff, formatDiff } from '../src/diff.js';
import { main } from '../src/cli.js';
import { makeRepo, commitFile } from './git-repo.js';

const git = createGit({ run: runProcess });

async function setup() {
  const repo = makeRepo({ 'a.txt': 'one\n' });
  const home = mkdtempSync(path.join(tmpdir(), 'foreman-home-'));
  const paths = { runs: path.join(home, 'runs'), worktrees: path.join(home, 'worktrees') };
  const base = await git.head(repo);
  const root = worktreeRoot({ paths, repo, task: 't' });
  const workers = [];
  for (const name of ['w1', 'w2']) {
    const worktree = path.join(root, name);
    const branch = `wip/t/${name}`;
    await git.addWorktree(repo, worktree, branch, base);
    workers.push({ name, kind: 'claude', model: name === 'w1' ? 'opus' : null, worktree, branch, reportDir: path.join(worktree, '.foreman') });
  }
  return { repo, home, paths, run: { task: 't', repo, base, branch: 'fix/t', createdAt: 'x', workers } };
}

const cleanupDirs = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));

test('a worker diff covers commits, uncommitted edits and new files', async () => {
  const { repo, home, run } = await setup();
  try {
    const [w1] = run.workers;
    commitFile(w1.worktree, 'b.txt', 'bee\n');
    writeFileSync(path.join(w1.worktree, 'a.txt'), 'two\n');
    writeFileSync(path.join(w1.worktree, 'new.txt'), 'n\n');
    const d = await runDiff({ run, git, exists: existsSync, name: 'w1' });
    assert.equal(d.target, 'wip/t/w1');
    assert.match(d.text, /\+bee/);
    assert.match(d.text, /-one\n\+two/);
    assert.match(d.text, /new files not added to git yet: new\.txt/);
    const stat = await runDiff({ run, git, exists: existsSync, name: 'w1', stat: true });
    assert.match(stat.text, /a\.txt\s+\|\s+2 \+-/);
    assert.match(stat.text, /2 files changed/);
    await assert.rejects(runDiff({ run, git, exists: existsSync, name: 'nobody' }), /no worker "nobody" in t; its workers are w1, w2/);
  } finally {
    cleanupDirs(repo, home);
  }
});

test('before a merge the run diff lists each worker with changes; after it, the run branch', async () => {
  const { repo, home, paths, run } = await setup();
  try {
    commitFile(run.workers[0].worktree, 'b.txt', 'bee\n');
    commitFile(run.workers[1].worktree, 'c.txt', 'sea\n');
    const before = await runDiff({ run, git, exists: existsSync });
    assert.equal(before.target, 'workers');
    assert.match(before.text, /^# w1 \(claude:opus, wip\/t\/w1\)/m);
    assert.match(before.text, /^# w2 \(claude, wip\/t\/w2\)/m);

    const merged = await mergeWorkers({ run, git, paths, exists: existsSync });
    assert.deepEqual(merged.merged, ['w1', 'w2']);
    const after = await runDiff({ run, git, exists: existsSync, stat: true });
    assert.equal(after.target, 'fix/t');
    assert.match(after.text, /b\.txt/);
    assert.match(after.text, /c\.txt/);
  } finally {
    cleanupDirs(repo, home);
  }
});

test('a removed worktree falls back to its branch; nothing changed says so', async () => {
  const { repo, home, run } = await setup();
  try {
    const [w1, w2] = run.workers;
    commitFile(w1.worktree, 'b.txt', 'bee\n');
    await git.removeWorktree(repo, w1.worktree);
    const d = await runDiff({ run, git, exists: existsSync, name: 'w1' });
    assert.match(d.text, /\+bee/);
    const none = await runDiff({ run, git, exists: existsSync, name: w2.name });
    assert.equal(formatDiff(none), `no changes in wip/t/w2 against ${run.base.slice(0, 10)}\n`);
  } finally {
    cleanupDirs(repo, home);
  }
});

test('foreman diff routes with an optional worker and --stat; a task sentence still starts', async () => {
  let out = '';
  const calls = [];
  const deps = {
    env: {},
    paths: { runs: '/s/runs' },
    readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    stdout: { write: (x) => { out += x; } },
    stderr: { write: () => {} },
    ops: {
      diff: async (o) => { calls.push(o); return { base: 'abc', target: 'fix/t', text: 'diff --git a/x b/x\n' }; },
      start: async ({ task }) => { calls.push(task); return { ok: true }; },
    },
  };
  assert.equal(await main(['diff', '--task', 't', 'w1', '--stat'], deps), 0);
  assert.equal(await main(['diff', '--task', 't'], deps), 0);
  assert.equal(await main(['diff', 'view', 'is', 'broken'], deps), 0);
  assert.deepEqual(calls, [{ task: 't', name: 'w1', stat: true }, { task: 't', name: null, stat: false }, 'diff view is broken']);
  assert.equal(out, 'diff --git a/x b/x\n'.repeat(2));
});
