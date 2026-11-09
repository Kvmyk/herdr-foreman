// After workers report: check what they changed, collect committed work on
// <type>/<name> (foreman/<task> for old runs) in a separate worktree, land it on the user's branch, clean up.
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { worktreeRoot } from './runs.js';

function isInside(child, parent) {
  const norm = (p) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep);
}

// Runs from before named branches have no run.branch and keep foreman/<task>.
export const mergeBranch = (run) => run.branch ?? `foreman/${run.task}`;
const mergeWorktree = (run, paths) => path.join(worktreeRoot({ paths, repo: run.repo, task: run.task }), '_merge');

// What each worker has done: its agent's state, how long it has run, what it changed, what it reported.
export async function workerStatus({ run, git, exists, herdr = null, now = Date.now }) {
  const agents = herdr ? await herdr.agentList().catch(() => null) : null;
  return Promise.all(run.workers.map(async (w) => {
    const started = Date.parse(w.startedAt ?? run.createdAt);
    const live = {
      state: agents ? agents.find((a) => a.name === w.name)?.agent_status ?? 'gone' : null,
      ageS: Number.isFinite(started) ? Math.max(0, Math.round((now() - started) / 1000)) : null,
    };
    const reports = {
      proposals: exists(path.join(w.reportDir, 'proposals.md')),
      report: exists(path.join(w.reportDir, 'report.md')),
    };
    if (!exists(w.worktree)) return { name: w.name, ...live, missing: true, dirty: false, changedFiles: [], added: 0, removed: 0, commitsAhead: 0, pushGuardArmed: false, ...reports };
    const changedFiles = await git.changedFiles(w.worktree);
    // FILES and LINES come from the same diff against the base, so committed work counts too.
    const { added, removed, files } = git.diffStat ? await git.diffStat(w.worktree, run.base) : { added: 0, removed: 0, files: changedFiles.length };
    return {
      name: w.name,
      ...live,
      dirty: changedFiles.length > 0,
      changedFiles,
      files: files ?? changedFiles.length,
      added,
      removed,
      commitsAhead: await git.commitsAhead(w.worktree, run.base),
      pushGuardArmed: await git.pushGuardArmed(w.worktree),
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

  const result = { branch, worktree, base: run.base, merged: [], skipped: [], refused: [], conflict: null, warnings: [] };
  for (const w of run.workers.filter((x) => !only || only.includes(x.name))) {
    if (exists(w.worktree) && !(await git.pushGuardArmed(w.worktree))) result.warnings.push(`push guard is not armed in ${w.name}'s worktree; check it did not push`);
    if (await git.isDirty(w.worktree)) {
      result.refused.push({ worker: w.name, reason: 'uncommitted changes' });
      continue;
    }
    if ((await git.commitsAhead(w.worktree, run.base)) === 0) {
      result.skipped.push({ worker: w.name, reason: 'no commits' });
      continue;
    }
    const label = w.model ? `${w.kind}:${w.model}` : w.kind;
    const res = await git.merge(worktree, w.branch, `Merge ${w.branch} (${label})`);
    if (!res.ok) {
      result.conflict = { worker: w.name, files: res.files };
      break;
    }
    result.merged.push(w.name);
  }
  return result;
}

// Merge the run branch into a branch that is not checked out, in a temporary
// worktree of that branch, so the user's checkout is never touched.
async function landElsewhere({ run, git, branch, title, tmpdir, makeTempDir }) {
  const base = run.baseBranch;
  const dir = makeTempDir(tmpdir);
  try {
    try {
      await git.addWorktree(run.repo, dir, base);
    } catch (err) {
      return { ok: false, reason: `cannot update ${base} without touching your checkout: ${err.message.split(/\r?\n/)[0]}` };
    }
    const res = await git.merge(dir, branch, title ? `Merge ${branch}: ${title}` : `Merge ${branch}`);
    return res.ok ? { ok: true, branch, into: base } : { ok: false, reason: `merge conflict with ${base}; ${base} is unchanged`, files: res.files };
  } finally {
    await git.removeWorktree(run.repo, dir).catch(() => {});
    await git.pruneWorktrees(run.repo).catch(() => {});
    try {
      if (path.basename(path.dirname(dir)).startsWith('foreman-land-')) rmSync(path.dirname(dir), { recursive: true, force: true });
    } catch {
      // a leftover empty temp folder is harmless
    }
  }
}

export async function land({ run, git, title = null, tmpdir = os.tmpdir(), makeTempDir = (t) => path.join(mkdtempSync(path.join(t, 'foreman-land-')), 'wt') }) {
  const branch = mergeBranch(run);
  if (run.baseBranch && (await git.currentBranch(run.repo).catch(() => null)) !== run.baseBranch) {
    if (!(await git.branchExists(run.repo, branch))) return { ok: false, reason: `nothing to land: ${branch} does not exist; run foreman merge first` };
    if (!(await git.branchExists(run.repo, run.baseBranch))) return { ok: false, reason: `the base branch ${run.baseBranch} no longer exists` };
    return landElsewhere({ run, git, branch, title, tmpdir, makeTempDir });
  }
  // A dirty checkout again: if the run captured a snapshot of the user's
  // uncommitted work and the working tree still matches it, saving those
  // changes as a commit now merges cleanly (the run branch already carries
  // the same content). If they differ, the user has changed them since.
  if (await git.isDirty(run.repo, { untracked: false })) {
    if (!run.snapshot) {
      return { ok: false, reason: `uncommitted changes in your repo (${run.repo}); commit or stash them first` };
    }
    let mismatched = [];
    try {
      const files = await git.modifiedTracked(run.repo);
      for (const f of files) {
        if (!(await git.fileMatchesTree(run.repo, run.snapshot, f))) mismatched.push(f);
      }
    } catch (err) {
      return { ok: false, reason: `cannot compare your changes with the start copy: ${err.message}` };
    }
    if (mismatched.length) {
      return {
        ok: false,
        reason: `you have changed ${mismatched.join(', ')} since the workers started; commit or stash it first`,
      };
    }
    try {
      await git.commitTracked(run.repo, 'chore: include the changes you had not committed yet');
    } catch (err) {
      return { ok: false, reason: `cannot save your uncommitted changes: ${err.message}` };
    }
  }
  if (!(await git.branchExists(run.repo, branch))) {
    return { ok: false, reason: `nothing to land: ${branch} does not exist; run foreman merge first` };
  }
  const res = await git.merge(run.repo, branch, title ? `Merge ${branch}: ${title}` : `Merge ${branch}`);
  return res.ok ? { ok: true, branch, ...(run.baseBranch ? { into: run.baseBranch } : {}) } : { ok: false, reason: 'merge conflict', files: res.files };
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
  // Pane ids restart after a herdr restart, so close a recorded pane only if it
  // still hosts this worker, or a process working inside this worker's worktree.
  const [agents, panes] = await Promise.all([
    herdr.agentList().catch(() => []),
    herdr.paneList ? herdr.paneList().catch(() => []) : [],
  ]);
  const ownsPane = (w) => {
    if (agents.some((a) => a.pane_id === w.paneId && a.name === w.name)) return true;
    const pane = panes.find((p) => p.pane_id === w.paneId);
    const cwd = pane?.foreground_cwd || pane?.cwd;
    return Boolean(cwd && isInside(cwd, w.worktree));
  };
  for (const w of run.workers) {
    if (!w.paneId || !ownsPane(w)) continue;
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

  // Undo extensions.worktreeConfig if foreman turned it on and no foreman worktree is left.
  if (run.ownsWorktreeConfig && await git.worktreeConfigEnabled(run.repo)) {
    await attempt('unset extensions.worktreeConfig', async () => {
      if ((await git.foremanWorktreeCount(run.repo)) === 0) await git.disableWorktreeConfig(run.repo);
    });
  }

  const branches = [...run.workers.map((w) => w.branch), ...(deleteBranch ? [mergeBranch(run)] : [])];
  for (const b of branches) {
    if (!(await git.branchExists(run.repo, b))) continue;
    if (await attempt(`delete branch ${b}`, () => git.deleteBranch(run.repo, b))) out.deletedBranches.push(b);
  }
  return out;
}

// Runs that still have worktrees on disk or worker agents alive in herdr,
// for example because the leader stopped before cleaning up.
export function findLeftovers({ runs, paths, exists, agents = [] }) {
  const live = new Set(agents.map((a) => a.name).filter(Boolean));
  return runs
    .map((run) => ({
      task: run.task,
      repo: run.repo,
      createdAt: run.createdAt,
      worktrees: [...run.workers.map((w) => w.worktree), mergeWorktree(run, paths)].filter((wt) => exists(wt)),
      liveWorkers: run.workers.map((w) => w.name).filter((n) => live.has(n)),
    }))
    .filter((r) => r.worktrees.length || r.liveWorkers.length);
}
