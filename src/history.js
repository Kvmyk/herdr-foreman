// The history of a run: which phase it is in, when it last changed, what was
// merged and landed, and how it ended. spawn writes the run record; wait,
// merge, land and cleanup add to it here, so `foreman runs` and
// `foreman show` can tell what happened after the leader is gone.
import path from 'node:path';
import { loadRun, saveRun } from './runs.js';
import { formatUsage, formatTokens, costText } from './usage.js';
import { createUi, table, isNarrow, kv } from './ui.js';

// spawned -> investigate -> implement -> merged -> landed -> cleaned
export const PHASES = Object.freeze(['spawned', 'investigate', 'implement', 'merged', 'landed', 'cleaned']);

// Where `foreman "<task>"` keeps the task text of a run.
export const taskFile = (paths, slug) => path.join(paths.home ?? path.dirname(paths.runs), 'tasks', `${slug}.md`);

const iso = (now) => new Date(now()).toISOString();

const norm = (p) => {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

export const isInside = (child, parent) => norm(child) === norm(parent) || norm(child).startsWith(norm(parent) + path.sep);

// Names such as "w1" come back in every run: an agent is this worker only if
// it also sits in the worker's pane or works inside its worktree.
export function isLive(w, agents) {
  return agents.some((a) => a.name === w.name && (a.cwd ? isInside(a.cwd, w.worktree) : a.pane_id === w.paneId));
}

// Applies change(run) -> fields to the saved record. History is a side note:
// a failure to save it never fails the command that called it.
export function updateRun(task, change, { paths, readFile, writeFile, mkdir, now = Date.now }) {
  try {
    const run = loadRun(task, { paths, readFile });
    if (!run) return null;
    const next = { ...run, updatedAt: iso(now), ...change(run) };
    saveRun(next, { paths, writeFile, mkdir });
    return next;
  } catch {
    return null;
  }
}

// After `foreman wait`: the phase it waited for, and when each worker finished it.
export function afterWait(run, { phase = null, result, now = Date.now }) {
  const at = iso(now);
  const done = (name) => result?.workers?.[name] === 'done';
  return {
    ...(phase ? { phase } : {}),
    workers: run.workers.map((w) => (done(w.name) && (!w.endedAt || w.endedPhase !== (phase ?? w.endedPhase))
      ? { ...w, endedAt: at, endedPhase: phase ?? w.endedPhase ?? null }
      : w)),
  };
}

export function afterMerge(run, { result, now = Date.now }) {
  if (!result?.merged?.length) return {};
  return {
    phase: 'merged',
    mergedAt: iso(now),
    merged: [...new Set([...(run.merged ?? []), ...result.merged])],
  };
}

export function afterLand(run, { result, now = Date.now }) {
  if (!result?.ok) return {};
  return { phase: 'landed', landedAt: iso(now), outcome: 'landed' };
}

// landed: on the user's branch. branch-kept: merged on <type>/<name>, left
// for later. discarded: nothing kept.
export function afterCleanup(run, { deleteBranch = false, now = Date.now }) {
  const outcome = run.outcome === 'landed' ? 'landed' : run.merged?.length && !deleteBranch ? 'branch-kept' : 'discarded';
  return { phase: 'cleaned', cleanedAt: iso(now), outcome };
}

// Records written before history: guess the phase from what they hold.
export const phaseOf = (run) => run.phase ?? (run.landedAt ? 'landed' : 'spawned');

export function readTask(slug, { paths, readFile }) {
  try {
    return readFile(taskFile(paths, slug)).trim();
  } catch {
    return null;
  }
}

// One line per run for `foreman runs`, newest first.
export function summarizeRuns({ runs, exists, agents = [] }) {
  return runs
    .map((run) => ({
      task: run.task,
      repo: run.repo,
      branch: run.branch ?? null,
      backend: run.backend ?? 'herdr',
      phase: phaseOf(run),
      outcome: run.outcome ?? null,
      createdAt: run.createdAt ?? null,
      updatedAt: run.updatedAt ?? run.createdAt ?? null,
      workers: run.workers.length,
      liveWorkers: run.workers.filter((w) => isLive(w, agents)).map((w) => w.name),
      worktrees: run.workers.filter((w) => exists(w.worktree)).length,
      merged: run.merged ?? [],
      landedAt: run.landedAt ?? null,
      ...(run.usage ? { usage: run.usage } : {}),
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

const REPORTS = ['proposals.md', 'report.md'];

// Everything known about one run for `foreman show`.
export function describeRun(run, { paths, readFile, exists, agents = [] }) {
  return {
    task: run.task,
    text: readTask(run.task, { paths, readFile }),
    repo: run.repo,
    branch: run.branch ?? null,
    base: run.base,
    snapshot: run.snapshot ?? null,
    backend: run.backend ?? 'herdr',
    phase: phaseOf(run),
    outcome: run.outcome ?? null,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? run.createdAt ?? null,
    mergedAt: run.mergedAt ?? null,
    merged: run.merged ?? [],
    landedAt: run.landedAt ?? null,
    cleanedAt: run.cleanedAt ?? null,
    workers: run.workers.map((w) => ({
      name: w.name,
      kind: w.kind,
      model: w.model ?? null,
      auto: Boolean(w.auto),
      state: isLive(w, agents) ? 'live' : exists(w.worktree) ? 'stopped' : 'removed',
      worktree: w.worktree,
      branch: w.branch,
      startedAt: w.startedAt ?? null,
      endedAt: w.endedAt ?? null,
      respawns: w.respawns?.length ?? 0,
      reports: REPORTS.filter((r) => exists(path.join(w.reportDir, r))).map((r) => path.join(w.reportDir, r)),
    })),
  };
}

const OUTCOMES = { landed: 'landed', 'branch-kept': 'branch kept', discarded: 'discarded' };

// The phase once; the outcome only when it says more, in plain words.
export function phaseText(phase, outcome) {
  if (!outcome || outcome === phase) return phase;
  const words = OUTCOMES[outcome] ?? outcome;
  return phase === 'cleaned' ? (outcome === 'landed' ? 'landed, cleaned up' : `cleaned up, ${words}`) : `${phase}, ${words}`;
}

const when = (s) => (s ? s.slice(0, 16).replace('T', ' ') : '-');

export function formatRuns(rows, ui = createUi()) {
  if (!rows.length) return 'no foreman runs yet\n';
  const lines = rows.map((r) => {
    const live = r.liveWorkers.length ? `, ${r.liveWorkers.length} live` : '';
    const cost = r.usage?.total ? `${formatTokens(r.usage.total)} ${costText(r.usage)}` : '-';
    const phase = phaseText(r.phase, r.outcome);
    return [r.task, r.liveWorkers.length ? ui.cyan(phase) : phase, String(r.branch ?? '-'), `${r.workers} ${r.workers === 1 ? 'worker' : 'workers'}${live}`, cost, when(r.createdAt), r.repo];
  });
  const text = table({ headers: ['TASK', 'PHASE', 'BRANCH', 'WORKERS', 'TOKENS', 'STARTED', 'REPO'], rows: lines, ui });
  return `${text}\nDetails: foreman show --task <slug>\n`;
}

export function formatShow(d, ui = createUi()) {
  if (isNarrow(ui)) return formatShowNarrow(d, ui);
  const out = [
    `task     ${d.task}`,
    ...(d.text ? [`asked    ${d.text.split(/\r?\n/)[0].slice(0, 200)}`] : []),
    `repo     ${d.repo}`,
    `branch   ${d.branch ?? '-'} (base ${String(d.base).slice(0, 10)}${d.snapshot ? ', with your uncommitted changes' : ''})`,
    `phase    ${ui.bold(phaseText(d.phase, d.outcome))}`,
    `started  ${when(d.createdAt)}   last change ${when(d.updatedAt)}`,
  ];
  if (d.merged.length) out.push(`merged   ${d.merged.join(', ')} (${when(d.mergedAt)})`);
  if (d.landedAt) out.push(`landed   ${when(d.landedAt)}`);
  if (d.usage) {
    const missing = d.usage.unknown?.length ? `; no log for ${d.usage.unknown.join(', ')}` : '';
    out.push(`usage    ${formatUsage(d.usage)}${missing} (workers only, API prices)`);
  }
  out.push('workers');
  for (const w of d.workers) {
    const agent = w.model ? `${w.kind}:${w.model}` : w.kind;
    const times = `${when(w.startedAt)} -> ${w.endedAt ? when(w.endedAt) : '...'}`;
    out.push(`  ${w.name.padEnd(10)} ${agent.padEnd(24)} ${w.state.padEnd(8)} ${times}${w.respawns ? `  respawned ${w.respawns}x` : ''}`);
    if (w.usage !== undefined) out.push(`             ${formatUsage(w.usage)}`);
    for (const r of w.reports) out.push(`             ${r}`);
  }
  return `${out.join('\n')}\n`;
}

// The same facts as formatShow, one "name: value" line each, for about 40 columns.
function formatShowNarrow(d, ui) {
  const out = [
    ...kv('task', d.task, ui),
    ...kv('asked', d.text?.split(/\r?\n/)[0].slice(0, 200), ui),
    ...kv('repo', d.repo, ui),
    ...kv('branch', `${d.branch ?? '-'} (base ${String(d.base).slice(0, 10)}${d.snapshot ? ', with your uncommitted changes' : ''})`, ui),
    ...kv('phase', ui.bold(phaseText(d.phase, d.outcome)), ui),
    ...kv('started', when(d.createdAt), ui),
    ...kv('last change', when(d.updatedAt), ui),
  ];
  if (d.merged.length) out.push(...kv('merged', `${d.merged.join(', ')} (${when(d.mergedAt)})`, ui));
  if (d.landedAt) out.push(...kv('landed', when(d.landedAt), ui));
  if (d.usage) {
    const missing = d.usage.unknown?.length ? `; no log for ${d.usage.unknown.join(', ')}` : '';
    out.push(...kv('usage', `${formatUsage(d.usage)}${missing} (workers only, API prices)`, ui));
  }
  for (const w of d.workers) {
    out.push('', `worker: ${w.name}`);
    out.push(...kv('agent', w.model ? `${w.kind}:${w.model}` : w.kind, ui, '  '));
    out.push(...kv('state', w.state, ui, '  '));
    out.push(...kv('started', when(w.startedAt), ui, '  '));
    out.push(...kv('ended', w.endedAt ? when(w.endedAt) : '...', ui, '  '));
    if (w.respawns) out.push(...kv('respawned', `${w.respawns}x`, ui, '  '));
    if (w.usage !== undefined) out.push(...kv('usage', formatUsage(w.usage), ui, '  '));
    for (const r of w.reports) out.push(...kv('report', r, ui, '  '));
  }
  return `${out.join('\n')}\n`;
}
