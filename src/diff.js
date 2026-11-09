// `foreman diff`: what one worker or the whole run changed against the run's
// base, so the user can look before `foreman land`. A worker's diff covers its
// worktree as it is now (commits and changes not committed yet); the run's
// diff is the run branch, or every worker in turn before anything is merged.
import { mergeBranch } from './collect.js';
import { fail } from './errors.js';

const label = (w) => (w.model ? `${w.kind}:${w.model}` : w.kind);

async function workerDiff({ run, w, git, exists, flags }) {
  if (exists(w.worktree)) {
    let text = await git.diff(w.worktree, [...flags, run.base]);
    const added = await git.untracked(w.worktree);
    if (added.length) text += `${text && !text.endsWith('\n') ? '\n' : ''}new files not added to git yet: ${added.join(', ')}\n`;
    return { target: w.branch, text };
  }
  if (await git.branchExists(run.repo, w.branch)) {
    return { target: w.branch, text: await git.diff(run.repo, [...flags, run.base, w.branch]) };
  }
  throw fail('NO_RUN', `${w.name}'s worktree and branch ${w.branch} are gone; nothing to compare`);
}

export async function runDiff({ run, git, exists, name = null, stat = false }) {
  const flags = stat ? ['--stat'] : [];
  if (name) {
    const w = run.workers.find((x) => x.name === name);
    if (!w) throw fail('USAGE', `no worker "${name}" in ${run.task}; its workers are ${run.workers.map((x) => x.name).join(', ')}`);
    return { base: run.base, ...(await workerDiff({ run, w, git, exists, flags })) };
  }
  const branch = mergeBranch(run);
  if (await git.branchExists(run.repo, branch)) {
    return { base: run.base, target: branch, text: await git.diff(run.repo, [...flags, run.base, branch]) };
  }
  const parts = [];
  for (const w of run.workers) {
    const d = await workerDiff({ run, w, git, exists, flags }).catch(() => null);
    if (d?.text.trim()) parts.push(`# ${w.name} (${label(w)}, ${w.branch})\n${d.text}`);
  }
  return { base: run.base, target: 'workers', text: parts.join('\n') };
}

export function formatDiff(d) {
  if (!d.text.trim()) return `no changes in ${d.target} against ${String(d.base).slice(0, 10)}\n`;
  return d.text.endsWith('\n') ? d.text : `${d.text}\n`;
}
