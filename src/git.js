// The git operations foreman needs: worktrees per worker, status checks, merges.
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const PUSH_HOOK = '#!/bin/sh\necho "push blocked by foreman" >&2\nexit 1\n';

export function createGit({ run }) {
  async function git(dir, args) {
    return run('git', ['-C', dir, ...args], { timeoutMs: 120000 });
  }

  async function ok(dir, args) {
    const res = await git(dir, args);
    if (res.code !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim()}`);
    }
    return res.stdout.trim();
  }

  // Not trimmed: the first column of porcelain output is significant.
  async function porcelain(dir) {
    const res = await git(dir, ['status', '--porcelain']);
    if (res.code !== 0) throw new Error(`git status failed in ${dir}: ${(res.stderr || res.stdout).trim()}`);
    return res.stdout.split(/\r?\n/).filter(Boolean);
  }

  return {
    async toplevel(cwd) {
      const res = await git(cwd, ['rev-parse', '--show-toplevel']);
      return res.code === 0 ? path.resolve(res.stdout.trim()) : null;
    },
    head: (repo) => ok(repo, ['rev-parse', 'HEAD']),
    // The .git directory shared by the repository and all its worktrees.
    async commonDir(dir) {
      return path.resolve(dir, await ok(dir, ['rev-parse', '--git-common-dir']));
    },
    currentBranch: (dir) => ok(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    // untracked: false ignores new files nobody has added yet (they do not block a merge).
    async isDirty(dir, { untracked = true } = {}) {
      if (untracked) return (await porcelain(dir)).length > 0;
      return (await ok(dir, ['status', '--porcelain', '--untracked-files=no'])).length > 0;
    },
    async changedFiles(dir) {
      return (await porcelain(dir)).map((l) => l.slice(3).replace(/^"|"$/g, ''));
    },
    // With base: new branch at base. Without: check out an existing branch.
    async addWorktree(repo, wtPath, branch, base = null) {
      await ok(repo, base ? ['worktree', 'add', '-b', branch, wtPath, base] : ['worktree', 'add', wtPath, branch]);
    },
    // Tripwire against pushes from a worker worktree: a pre-push hook that always fails
    // and a dead pushurl per remote, both in per-worktree config so the user's checkout
    // keeps its own settings. The hook lives in the worktree's git admin dir, which goes
    // away with the worktree. A worker could disarm it; it stops accidents.
    async armPushGuard(wtPath) {
      await ok(wtPath, ['config', 'extensions.worktreeConfig', 'true']);
      const gitDir = await ok(wtPath, ['rev-parse', '--absolute-git-dir']);
      const hooks = path.join(gitDir, 'foreman-hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(path.join(hooks, 'pre-push'), PUSH_HOOK, { mode: 0o755 });
      await ok(wtPath, ['config', '--worktree', 'core.hooksPath', hooks.replace(/\\/g, '/')]);
      // A plain path that does not exist: a named-remote push refuses cleanly.
      const deadUrl = path.join(gitDir, 'foreman-no-push').replace(/\\/g, '/');
      for (const remote of (await ok(wtPath, ['remote'])).split(/\r?\n/).filter(Boolean)) {
        await ok(wtPath, ['config', '--worktree', `remote.${remote}.pushurl`, deadUrl]);
      }
    },
    // extensions.worktreeConfig lives in the shared config; foreman turns it on only if it was unset.
    async worktreeConfigEnabled(repo) {
      const res = await git(repo, ['config', '--local', '--get', 'extensions.worktreeConfig']);
      return res.code === 0 && res.stdout.trim() !== '';
    },
    async disableWorktreeConfig(repo) {
      await ok(repo, ['config', '--local', '--unset', 'extensions.worktreeConfig']);
    },
    async foremanWorktreeCount(repo) {
      const out = await ok(repo, ['worktree', 'list', '--porcelain']);
      return out.split(/\r?\n/).filter((l) => /^branch refs\/heads\/foreman(-work)?\//.test(l)).length;
    },
    async pushGuardArmed(wtPath) {
      const hooksPath = await git(wtPath, ['config', '--worktree', '--get', 'core.hooksPath']);
      if (hooksPath.code !== 0 || !existsSync(path.join(hooksPath.stdout.trim(), 'pre-push'))) return false;
      const remotes = await git(wtPath, ['remote']);
      if (remotes.code !== 0) return false;
      for (const remote of remotes.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        const url = await git(wtPath, ['config', '--worktree', '--get', `remote.${remote}.pushurl`]);
        if (url.code !== 0 || !url.stdout.trim()) return false;
      }
      return true;
    },
    async removeWorktree(repo, wtPath) {
      await ok(repo, ['worktree', 'remove', '--force', wtPath]);
    },
    async pruneWorktrees(repo) {
      await ok(repo, ['worktree', 'prune']);
    },
    async deleteBranch(repo, branch) {
      await ok(repo, ['branch', '-D', branch]);
    },
    async branchExists(repo, branch) {
      return (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    },
    async commitsAhead(dir, base) {
      return Number(await ok(dir, ['rev-list', '--count', `${base}..HEAD`]));
    },
    // True when git accepts the name as a branch name.
    async validBranchName(repo, name) {
      return (await git(repo, ['check-ref-format', '--branch', name])).code === 0;
    },
    async merge(dir, branch, message = null) {
      const res = await git(dir, ['merge', '--no-ff', ...(message ? ['-m', message] : ['--no-edit']), branch]);
      if (res.code === 0) return { ok: true };
      const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split(/\r?\n/).filter(Boolean);
      await git(dir, ['merge', '--abort']);
      return { ok: false, files };
    },
  };
}
