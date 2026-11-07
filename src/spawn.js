// Opens workers: one git worktree and one herdr pane per worker, agents
// started in parallel. Panes sit next to the leader in columns of up to three.
import path from 'node:path';
import { HERDR_KINDS, PROBES } from './inventory/kinds.js';
import { planLayout, columnRatios, rowRatios } from './layout.js';
import { worktreeRoot, saveRun, loadRun } from './runs.js';
import { fail } from './errors.js';

export const SPEC_PATTERN = /^([a-z][a-z0-9_-]{0,31})=([a-z][a-z0-9-]*)(?::(.+))?$/;
const TASK = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function parseSpec(s) {
  const m = SPEC_PATTERN.exec(s);
  if (!m) throw fail('BAD_SPEC', `bad worker spec "${s}"; expected name=kind or name=kind:model (name: lowercase letters, digits, - or _)`);
  return { name: m[1], kind: m[2], model: m[3] ?? null };
}

async function validate({ herdr, config, task, specs, existing, pane, newTab }) {
  if (specs.length < 1 || specs.length > config.maxWorkers) {
    throw fail('TOO_MANY', `between 1 and ${config.maxWorkers} workers per spawn (got ${specs.length})`);
  }
  if (!TASK.test(task)) throw fail('BAD_TASK', `bad task slug "${task}"; use lowercase letters, digits and -`);
  const parsed = specs.map(parseSpec);
  const unknown = parsed.find((w) => !HERDR_KINDS.includes(w.kind));
  if (unknown) throw fail('UNKNOWN_KIND', `herdr cannot start agent kind "${unknown.kind}"`);
  const taken = new Set([
    ...(await herdr.agentList()).map((a) => a.name).filter(Boolean),
    ...(existing?.workers ?? []).map((w) => w.name),
  ]);
  for (const w of parsed) {
    if (taken.has(w.name)) throw fail('NAME_TAKEN', `agent name "${w.name}" is already in use`);
    taken.add(w.name);
  }
  if (!newTab && !pane) throw fail('NO_PANE', 'no pane to open workers next to; run inside herdr or pass --new-tab');
  return parsed;
}

async function openPanes({ herdr, pane, newTab, task, workers }) {
  const { cols, rows } = planLayout(workers.length);
  const cwdAt = (c, j) => workers[rows.slice(0, c).reduce((s, n) => s + n, 0) + j].worktree;
  const created = [];
  const split = async (o) => {
    const id = await herdr.paneSplit(o);
    created.push(id);
    return id;
  };

  let region;
  if (newTab) {
    region = (await herdr.tabCreate({ cwd: cwdAt(0, 0), label: `foreman:${task}`, focus: false })).paneId;
  } else {
    region = await split({ pane, direction: 'right', ratio: 1 / (cols + 1), cwd: cwdAt(0, 0) });
  }

  try {
    const columns = [region];
    const colRatios = columnRatios(cols);
    for (let i = 1; i < cols; i++) {
      columns.push(await split({ pane: columns[i - 1], direction: 'right', ratio: colRatios[i - 1], cwd: cwdAt(i, 0) }));
    }
    const panes = [];
    for (let c = 0; c < cols; c++) {
      const cell = [columns[c]];
      const ratios = rowRatios(rows[c]);
      for (let j = 1; j < rows[c]; j++) {
        cell.push(await split({ pane: cell[j - 1], direction: 'down', ratio: ratios[j - 1], cwd: cwdAt(c, j) }));
      }
      panes.push(...cell);
    }
    return panes;
  } catch (err) {
    await Promise.allSettled([region, ...created].filter(Boolean).map((id) => herdr.paneClose(id)));
    throw err;
  }
}

export async function spawnWorkers({ herdr, git, paths, config, repo, task, specs, pane, newTab = false, writeFile, readFile, mkdir }) {
  const existing = loadRun(task, { paths, readFile });
  const parsed = await validate({ herdr, config, task, specs, existing, pane, newTab });
  const warnings = [];

  const base = existing?.base ?? await git.head(repo);
  if (await git.isDirty(repo)) warnings.push(`uncommitted changes in ${repo} are not visible to workers`);

  const root = worktreeRoot({ paths, repo, task });
  const workers = parsed.map((w) => ({
    ...w,
    worktree: path.join(root, w.name),
    branch: `foreman-work/${task}/${w.name}`,
    reportDir: path.join(paths.runs, task, w.name),
  }));

  const made = [];
  try {
    for (const w of workers) {
      await git.addWorktree(repo, w.worktree, w.branch, base);
      made.push(w);
      mkdir(w.reportDir, { recursive: true });
    }
    const panes = await openPanes({ herdr, pane, newTab, task, workers });
    workers.forEach((w, i) => { w.paneId = panes[i]; });
  } catch (err) {
    for (const w of made) {
      await git.removeWorktree(repo, w.worktree).catch(() => {});
      await git.deleteBranch(repo, w.branch).catch(() => {});
    }
    throw err;
  }

  const results = await Promise.all(workers.map((w) => {
    const probe = PROBES[w.kind];
    if (w.model && !probe) warnings.push(`no model flag known for ${w.kind}; ${w.name} starts with its default model`);
    const args = w.model && probe ? probe.modelArgs(w.model) : [];
    return herdr.agentStart({ name: w.name, kind: w.kind, pane: w.paneId, timeoutMs: config.startTimeoutMs, args });
  }));
  workers.forEach((w, i) => {
    w.status = results[i].ok ? 'ready' : 'not_ready';
    w.error = results[i].ok ? null : `${results[i].code}: ${results[i].message}`;
  });

  const record = {
    task,
    repo,
    base,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    workers: [
      ...(existing?.workers ?? []),
      ...workers.map(({ name, kind, model, paneId, worktree, branch, reportDir }) => ({ name, kind, model, paneId, worktree, branch, reportDir })),
    ],
  };
  saveRun(record, { paths, writeFile, mkdir });
  return { workers, warnings };
}
