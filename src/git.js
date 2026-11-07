// The git operations foreman needs: worktrees per worker, status checks, merges.
import path from 'node:path';

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
    async merge(dir, branch) {
      const res = await git(dir, ['merge', '--no-ff', '--no-edit', branch]);
      if (res.code === 0) return { ok: true };
      const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split(/\r?\n/).filter(Boolean);
      await git(dir, ['merge', '--abort']);
      return { ok: false, files };
    },
  };
}
