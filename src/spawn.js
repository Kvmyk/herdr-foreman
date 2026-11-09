// Opens workers: one git worktree and one herdr pane per worker, agents
// started in parallel. Panes sit next to the leader in columns of up to three.
// In the Herdr app each worker is a terminal in the leader's tab (or a new
// one), and the app lays them out.
import path from 'node:path';
import { HERDR_KINDS, PROBES, EFFORT_LEVELS } from './inventory/kinds.js';
import { planLayout, columnRatios, rowRatios, MAX_BESIDE_LEADER } from './layout.js';
import { checkStartFlags, flagsOf } from './startflags.js';
import { classifyScreen, describeBlocked } from './blocked.js';
import { recordStartResults } from './startfail.js';
import { screenTail } from './wait.js';
import { worktreeRoot, saveRun, loadRun } from './runs.js';
import { fail } from './errors.js';

export const SPEC_PATTERN = /^([a-z][a-z0-9_-]{0,31})=([a-z][a-z0-9-]*)(?::(.+))?$/;
const TASK = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const BRANCH_TYPES = Object.freeze(['feat', 'fix', 'docs', 'refactor', 'test', 'perf', 'chore']);
const BRANCH = new RegExp('^(' + BRANCH_TYPES.join('|') + ')/([a-z0-9][a-z0-9-]{0,39})$');
// The commit that copies the user's uncommitted work into the run base.
const snapshotMessage = (task) => `chore: save the changes you had not committed yet (foreman "${task}")`;

export function parseSpec(s) {
  const m = SPEC_PATTERN.exec(s);
  if (!m) throw fail('BAD_SPEC', `bad worker spec "${s}"; expected name=kind or name=kind:model (name: lowercase letters, digits, - or _)`);
  return { name: m[1], kind: m[2], model: m[3] ?? null };
}

async function validate({ herdr, git, repo, config, task, specs, existing, pane, newTab, effort, branch }) {
  if (specs.length < 1 || specs.length > config.maxWorkers) {
    throw fail('TOO_MANY', `between 1 and ${config.maxWorkers} workers per spawn (got ${specs.length})`);
  }
  if (!TASK.test(task)) throw fail('BAD_TASK', `bad task slug "${task}"; use lowercase letters, digits and -`);
  if (effort && !EFFORT_LEVELS.includes(effort)) throw fail('BAD_EFFORT', `effort must be one of ${EFFORT_LEVELS.join(', ')}`);
  // Runs recorded before named branches keep their old branch names.
  if (existing && !existing.branch) {
    branch = null;
  } else if (existing) {
    if (branch && branch !== existing.branch) throw fail('BAD_BRANCH', `this task already uses branch ${existing.branch}; do not pass a different --branch`);
  } else {
    if (!branch) throw fail('BRANCH_REQUIRED', `the first spawn of a task needs --branch <type>/<name> (type: ${BRANCH_TYPES.join(', ')})`);
    if (!BRANCH.test(branch)) throw fail('BAD_BRANCH', `bad branch "${branch}"; use <type>/<name> with type one of ${BRANCH_TYPES.join(', ')} and name in lowercase letters, digits and - (at most 40 characters)`);
    if (!(await git.validBranchName(repo, branch))) throw fail('BAD_BRANCH', `git does not accept the branch name "${branch}"`);
    if (await git.branchExists(repo, branch)) throw fail('BAD_BRANCH', `branch ${branch} already exists; choose another name`);
  }
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
  if (!newTab && !pane) throw fail('NO_PANE', 'no pane to open workers next to; run inside herdr or the Herdr app, or pass --new-tab');
  return { parsed, branch };
}

// The Herdr app: the space and tab the workers' terminals will show up in.
async function appPlace({ herdr, pane, newTab, task, workers }) {
  const here = pane ? await herdr.here(pane) : null;
  if (!newTab && here?.tab) return { space: here.space, tab: here.tab, label: null };
  const { workspaceId, tabId } = await herdr.tabCreate({ workspaceId: here?.space, cwd: workers[0].worktree, label: `foreman:${task}`, focus: false });
  return { space: workspaceId, tab: tabId, label: `foreman:${task}` };
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

// The end of an agent's pane, by name or by pane id; '' when it cannot be read.
async function readTail(herdr, targets) {
  for (const t of targets.filter(Boolean)) {
    try {
      const tail = screenTail(await herdr.agentRead(t));
      if (tail) return tail;
    } catch { /* the agent may be gone; try the next target */ }
  }
  return '';
}

// Press the answer, then wait for the agent to stop being blocked.
async function answerTrust({ herdr, w, keys, sleep }) {
  try {
    await herdr.agentKeys(w.name, keys);
    for (let waited = 0; waited < 30000; waited += 1000) {
      await sleep(1000);
      const status = (await herdr.agentList()).find((a) => a.name === w.name)?.agent_status;
      if (['idle', 'done', 'working'].includes(status)) return true;
    }
  } catch { /* leave it for the user */ }
  return false;
}

// Worker reports live in <worktree>/.foreman/, inside the worker's own folder
// (agents ask before writing outside it) but excluded from git for every worktree.
async function excludeReports({ git, repo, readFile, appendFile, mkdir }) {
  const file = path.join(await git.commonDir(repo), 'info', 'exclude');
  let text = '';
  try {
    text = readFile(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === '.foreman/')) return;
  mkdir(path.dirname(file), { recursive: true });
  appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}.foreman/\n`);
}

export async function spawnWorkers({
  herdr, git, paths, config, repo, task, specs, pane, newTab = false, effort = null, full = false, auto = false, branch = null, includeUncommitted = false, run = null, writeFile, readFile, appendFile, mkdir, sleep = null, now = Date.now, foremanCmd = 'foreman',
}) {
  const existing = loadRun(task, { paths, readFile });
  const backend = herdr.kind ?? 'herdr';
  if (existing && (existing.backend ?? 'herdr') !== backend) {
    const where = existing.backend === 'app' ? 'the Herdr app' : 'herdr';
    throw fail('USAGE', `task "${task}" runs its workers in ${where}; run foreman spawn from there`);
  }
  const warnings = [];
  if (!newTab && specs.length > MAX_BESIDE_LEADER && specs.length <= config.maxWorkers) {
    newTab = true;
    warnings.push(`${specs.length} workers would be too narrow next to the leader; opened them in a new tab`);
  }
  const checked = await validate({ herdr, git, repo, config, task, specs, existing, pane, newTab, effort, branch });
  const parsed = checked.parsed;
  const runBranch = existing ? existing.branch : checked.branch;

  // Uncommitted work: on the first spawn the user can have it copied into a
  // snapshot commit the workers start from (--include-uncommitted); otherwise
  // the workers never see it, so say so. A dirty repo on a later spawn keeps
  // warning: only the first snapshot is taken.
  let snapshot = existing?.snapshot ?? null;
  let base = existing?.base ?? null;
  const dirty = await git.isDirty(repo);
  if (dirty) {
    if (!existing?.base && includeUncommitted) {
      snapshot = await git.createSnapshot(repo, snapshotMessage(task));
      base = snapshot;
    } else {
      warnings.push(`uncommitted changes in ${repo} are not copied to the workers; spawn again with --include-uncommitted to include them`);
    }
  }
  base ??= await git.head(repo);
  await excludeReports({ git, repo, readFile, appendFile, mkdir });

  const root = worktreeRoot({ paths, repo, task });
  const workers = parsed.map((w) => ({
    ...w,
    worktree: path.join(root, w.name),
    // wip/<name>/<worker>: <type>/<name> is itself a branch, so workers cannot live below it.
    branch: runBranch ? `wip/${runBranch.split('/')[1]}/${w.name}` : `foreman-work/${task}/${w.name}`,
    reportDir: path.join(root, w.name, '.foreman'),
  }));

  // Remember whether foreman turns on extensions.worktreeConfig, so cleanup can undo it.
  const ownsWorktreeConfig = existing?.ownsWorktreeConfig ?? !(await git.worktreeConfigEnabled(repo));
  const made = [];
  try {
    for (const w of workers) {
      await git.addWorktree(repo, w.worktree, w.branch, base);
      made.push(w);
      await git.armPushGuard(w.worktree);
      mkdir(w.reportDir, { recursive: true });
    }
    if (backend === 'app') {
      const place = await appPlace({ herdr, pane, newTab, task, workers });
      workers.forEach((w) => { w.place = place; w.paneId = null; });
    } else {
      const panes = await openPanes({ herdr, pane, newTab, task, workers });
      workers.forEach((w, i) => { w.paneId = panes[i]; });
    }
  } catch (err) {
    for (const w of made) {
      await git.removeWorktree(repo, w.worktree).catch(() => {});
      await git.deleteBranch(repo, w.branch).catch(() => {});
    }
    throw err;
  }

  const argsOf = new Map();
  const startArgs = workers.map((w) => {
    const probe = PROBES[w.kind];
    w.auto = false;
    const args = [];
    if (w.model && probe) args.push(...probe.modelArgs(w.model));
    else if (w.model) warnings.push(`no model flag known for ${w.kind}; ${w.name} starts with its default model`);
    if (effort && probe?.effortFromModel && w.model) warnings.push(`${w.name}: ${w.kind} takes effort from the model id; --effort not passed with --model ${w.model}`);
    else if (effort && probe?.effortArgs) args.push(...probe.effortArgs(effort));
    else if (effort) warnings.push(`no effort setting known for ${w.kind}; ${w.name} uses its default effort`);
    // Lean start: fewer tool definitions re-sent on every turn; the user's skills stay.
    // --full keeps MCP servers and all tools, e.g. for a worker that tests a web app in the browser.
    if (auto && probe?.autoArgs) {
      args.push(...probe.autoArgs);
      w.auto = true;
    }
    else if (auto) warnings.push(`no auto-approve mode known for ${w.kind}; ${w.name} may still ask for permission`);
    if (config.lean !== false && !full && probe?.leanArgs) args.push(...probe.leanArgs.worker);
    argsOf.set(w.kind, [...new Set([...(argsOf.get(w.kind) ?? []), ...flagsOf(args)])]);
    return args;
  });
  // Each kind's start flags are checked once against its own --help.
  if (run) warnings.push(...await checkStartFlags({ run, byKind: argsOf }));

  const results = await Promise.all(workers.map((w, i) => herdr.agentStart({
    name: w.name, kind: w.kind, pane: w.paneId, cwd: w.worktree, space: w.place?.space, tab: w.place?.tab, label: w.place?.label,
    timeoutMs: config.startTimeoutMs, args: startArgs[i],
  })));
  for (const [i, w] of workers.entries()) {
    const res = results[i];
    w.paneId = res.pane ?? w.paneId;
    delete w.place;
    w.status = res.ok ? 'ready' : 'not_ready';
    w.error = null;
    if (res.ok) continue;
    w.error = `${res.code}: ${res.message}`;
    w.exited = res.code === 'agent_exited';
    const screen = await readTail(herdr, [w.name, w.paneId]);
    if (screen) w.screen = screen;
    const c = classifyScreen(w.kind, screen);
    // The worktree is foreman's own, so a known trust dialog is answered here.
    if (c?.safeToAnswer && sleep && await answerTrust({ herdr, w, keys: c.keys, sleep })) {
      w.status = 'ready';
      w.error = null;
      warnings.push(`${w.name}: answered the folder-trust dialog of ${w.kind} for its worktree`);
      continue;
    }
    const hint = describeBlocked({ kind: w.kind, screen, task, name: w.name, foremanCmd });
    if (hint) w.error += `; ${hint}`;
    if (screen) w.error += `
${screen}`;
  }
  try {
    recordStartResults({
      paths, readFile, writeFile, mkdir, now,
      failed: workers.filter((w) => w.exited).map((w) => ({ kind: w.kind, message: w.error.split(/\r?\n/)[0] })),
      worked: workers.filter((w) => w.status === 'ready').map((w) => w.kind),
    });
  } catch { /* the note about failures is optional */ }

  const record = {
    task,
    repo,
    base,
    ...(snapshot ? { snapshot } : {}),
    ...(runBranch ? { branch: runBranch } : {}),
    ...(backend === 'app' ? { backend } : {}),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    ownsWorktreeConfig,
    workers: [
      ...(existing?.workers ?? []),
      ...workers.map(({ name, kind, model, auto = false, paneId, worktree, branch, reportDir }) => ({ name, kind, model, auto, paneId, worktree, branch, reportDir })),
    ],
  };
  saveRun(record, { paths, writeFile, mkdir });
  return { workers, warnings, snapshot };
}
