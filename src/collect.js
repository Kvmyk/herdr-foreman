// After workers report: check what they changed, collect committed work on
// foreman/<task> in a separate worktree, land it on the user's branch, clean up.
import path from 'node:path';
import { worktreeRoot } from './runs.js';

const mergeBranch = (run) => `foreman/${run.task}`;
const mergeWorktree = (run, paths) => path.join(worktreeRoot({ paths, repo: run.repo, task: run.task }), '_merge');

export async function workerStatus({ run, git, exists }) {
  return Promise.all(run.workers.map(async (w) => {
    const reports = {
      proposals: exists(path.join(w.reportDir, 'proposals.md')),
      report: exists(path.join(w.reportDir, 'report.md')),
    };
    if (!exists(w.worktree)) return { name: w.name, missing: true, dirty: false, changedFiles: [], commitsAhead: 0, ...reports };
    const changedFiles = await git.changedFiles(w.worktree);
    return {
      name: w.name,
      dirty: changedFiles.length > 0,
      changedFiles,
      commitsAhead: await git.commitsAhead(w.worktree, run.base),
      ...reports,
    };
  }));
}

export async function mergeWorkers({ run, git, paths, exists, only = null }) {
  const branch = mergeBranch(run);
  const worktree = mergeWorktree(run, paths);
  if (!exists(worktree)) {
    const hasBranch = await git.branchExists(run.repo, branch);
    await git.addWorktree(run.repo, worktree, branch, hasBranch ? null : run.base);
  }

  const result = { branch, worktree, base: run.base, merged: [], skipped: [], refused: [], conflict: null };
  for (const w of run.workers.filter((x) => !only || only.includes(x.name))) {
    if (await git.isDirty(w.worktree)) {
      result.refused.push({ worker: w.name, reason: 'uncommitted changes' });
      continue;
    }
    if ((await git.commitsAhead(w.worktree, run.base)) === 0) {
      result.skipped.push({ worker: w.name, reason: 'no commits' });
      continue;
    }
    const res = await git.merge(worktree, w.branch);
    if (!res.ok) {
      result.conflict = { worker: w.name, files: res.files };
      break;
    }
    result.merged.push(w.name);
  }
  return result;
}

export async function land({ run, git }) {
  const branch = mergeBranch(run);
  if (await git.isDirty(run.repo, { untracked: false })) {
    return { ok: false, reason: `uncommitted changes in your repo (${run.repo}); commit or stash them first` };
  }
  if (!(await git.branchExists(run.repo, branch))) {
    return { ok: false, reason: `nothing to land: ${branch} does not exist; run foreman merge first` };
  }
  const res = await git.merge(run.repo, branch);
  return res.ok ? { ok: true, branch } : { ok: false, reason: 'merge conflict', files: res.files };
}

// On Windows a process that just lost its pane can hold its folder for a
// moment: retry, then delete the leftover folder and prune git's records.
async function removeWorktree({ git, repo, wt, exists, sleep, removeDir }) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      await git.removeWorktree(repo, wt);
      return null;
    } catch (err) {
      lastErr = err;
      await sleep(1000);
      if (!exists(wt)) return null;
    }
  }
  if (!removeDir) return lastErr;
  try {
    removeDir(wt);
    await git.pruneWorktrees(repo);
    return null;
  } catch (err) {
    return err;
  }
}

export async function cleanup({ run, git, herdr, paths, exists, deleteBranch = false, sleep = async () => {}, removeDir = null }) {
  const out = { closedPanes: [], removedWorktrees: [], deletedBranches: [], errors: [] };
  const attempt = async (label, fn) => {
    try {
      await fn();
      return true;
    } catch (err) {
      out.errors.push(`${label}: ${err.message}`);
      return false;
    }
  };

  // Panes first: on Windows a worktree with a process still inside cannot be removed.
  for (const w of run.workers) {
    if (!w.paneId) continue;
    try {
      await herdr.paneClose(w.paneId);
      out.closedPanes.push(w.paneId);
    } catch (err) {
      if (err.code !== 'pane_not_found') out.errors.push(`close pane ${w.paneId}: ${err.message}`);
    }
  }

  // Let the closed panes' processes exit before touching their folders.
  if (out.closedPanes.length) await sleep(1500);

  const worktrees = [...run.workers.map((w) => w.worktree), mergeWorktree(run, paths)];
  for (const wt of worktrees) {
    if (!exists(wt)) continue;
    const err = await removeWorktree({ git, repo: run.repo, wt, exists, sleep, removeDir });
    if (err) out.errors.push(`remove worktree ${wt}: ${err.message}`);
    else out.removedWorktrees.push(wt);
  }

  const branches = [...run.workers.map((w) => w.branch), ...(deleteBranch ? [mergeBranch(run)] : [])];
  for (const b of branches) {
    if (!(await git.branchExists(run.repo, b))) continue;
    if (await attempt(`delete branch ${b}`, () => git.deleteBranch(run.repo, b))) out.deletedBranches.push(b);
  }
  return out;
}
