// Picking up an interrupted run. `foreman resume` starts a new leader whose
// prompt points at a note with the user's task, the run record and the
// workers' reports; `foreman respawn` restarts one worker's agent in the
// worktree it already has.
import path from 'node:path';
import { HERDR_KINDS } from './inventory/kinds.js';
import { agentArgs } from './spawn.js';
import { describeRun, isInside } from './history.js';
import { fail } from './errors.js';

export const RESPAWN_SPEC = /^([a-z][a-z0-9_-]{0,31})(?:=([a-z][a-z0-9-]*)(?::(.+))?)?$/;
const REPORT_LIMIT = 6000;

export const resumeFile = (paths, slug) => path.join(paths.home ?? path.dirname(paths.runs), 'tasks', `${slug}.resume.md`);

// Where the run stopped, as a step of the leader instructions.
function nextStep(d) {
  const reports = (name) => d.workers.find((w) => w.name === name)?.reports.map((r) => path.basename(r)) ?? [];
  const all = (file) => d.workers.length > 0 && d.workers.every((w) => reports(w.name).includes(file));
  switch (d.phase) {
    case 'landed': return 'The run branch is already merged into the user\'s branch: go to step 9.';
    case 'merged': return 'Work is collected on the run branch: check it (step 7), then ask the user (step 8).';
    case 'implement': return all('report.md') ? 'Every worker reported: go to step 7.' : 'Workers were implementing: wait for them (step 6, `foreman wait --phase implement`).';
    default: return all('proposals.md')
      ? 'Every worker wrote its proposals: show the user one list (step 5). If the user already approved items, ask which.'
      : 'Workers were investigating: wait for them (step 4, `foreman wait --phase investigate`).';
  }
}

// The note the new leader reads first.
export function resumeNotes(run, { paths, readFile, exists, agents = [], foremanCmd = 'foreman' }) {
  const d = describeRun(run, { paths, readFile, exists, agents });
  const out = [
    `# Resuming foreman run "${d.task}"`,
    '',
    'The leader of this run stopped before it finished. Continue the run; do not start it over and do not spawn its workers again.',
    '',
    '## The user\'s task',
    '',
    d.text ?? '(the task text was not saved; ask the user what the run was for if the reports do not tell)',
    '',
    '## The run so far',
    '',
    `- repository: ${d.repo}`,
    `- run branch: ${d.branch ?? '-'} (base ${d.base}${d.snapshot ? ', a snapshot that includes the user\'s uncommitted changes' : ''})`,
    `- phase: ${d.phase}${d.outcome ? `, ${d.outcome}` : ''} (spawned, investigate, implement, merged, landed, cleaned)`,
    `- merged: ${d.merged.join(', ') || 'nothing yet'}`,
    '- workers (live: its agent runs; stopped: the agent exited, the worktree is there; removed: worktree gone):',
    ...d.workers.map((w) => `  - ${w.name}: ${w.model ? `${w.kind}:${w.model}` : w.kind}, ${w.state}${w.auto ? ', auto mode' : ''}; worktree ${w.worktree}; branch ${w.branch}; reports in ${path.join(w.worktree, '.foreman')}`),
    '',
    '## Reports',
    '',
  ];
  let any = false;
  for (const w of d.workers) {
    for (const file of w.reports) {
      let text;
      try {
        text = readFile(file).trim();
      } catch {
        continue;
      }
      any = true;
      const cut = text.length > REPORT_LIMIT ? `${text.slice(0, REPORT_LIMIT)}\n(cut; the full file is ${file})` : text;
      out.push(`### ${w.name}: ${path.basename(file)}`, '', cut, '');
    }
  }
  if (!any) out.push('No worker has written a report yet.', '');
  out.push(
    '## How to continue',
    '',
    `1. Run \`${foremanCmd} status --task ${d.task} --json\` to see each worker's changes and reports now.`,
    `2. A stopped worker can be restarted in its worktree with \`${foremanCmd} respawn --task ${d.task} <name>\` (add \`=<kind>[:<model>]\` to switch agents). It starts with no memory of its brief: send the brief again with \`${foremanCmd} prompt\`. A live worker keeps its context; just wait for it.`,
    `3. ${nextStep(d)}`,
    '4. Tell the user in one or two sentences where the run stands before you go on.',
  );
  return `${out.join('\n')}\n`;
}

// One line, like the first leader's prompt.
export function buildResumePrompt({ slug, instructionsPath, notesPath, foremanCmd = 'foreman' }) {
  const cmd = foremanCmd === 'foreman' ? '' : ` Run foreman commands as: ${foremanCmd}.`;
  return `You are the foreman leader for task "${slug}", taking over a run whose leader stopped. Read ${instructionsPath} and follow it exactly.${cmd} Then read ${notesPath}: it holds the user's task, the run so far and the workers' reports. Continue the run from there; do not start it over.`;
}

// Restarts one worker's agent in its worktree: in its old pane if that pane
// is still open in the worktree, else next to the caller (or in a new tab).
export async function respawnWorker({ run, herdr, spec, pane = null, newTab = false, effort = null, auto = false, full = false, config, exists, now = Date.now }) {
  const m = RESPAWN_SPEC.exec(spec);
  if (!m) throw fail('BAD_SPEC', `bad worker "${spec}"; expected name, name=kind or name=kind:model`);
  const [, name, newKind, newModel] = m;
  const w = run.workers.find((x) => x.name === name);
  if (!w) throw fail('USAGE', `no worker "${name}" in ${run.task}; its workers are ${run.workers.map((x) => x.name).join(', ')}`);
  const kind = newKind ?? w.kind;
  const model = newKind ? newModel ?? null : w.model ?? null;
  if (!HERDR_KINDS.includes(kind)) throw fail('UNKNOWN_KIND', `herdr cannot start agent kind "${kind}"`);
  const backend = herdr.kind ?? 'herdr';
  if ((run.backend ?? 'herdr') !== backend) {
    throw fail('USAGE', `task "${run.task}" runs its workers in ${run.backend === 'app' ? 'the Herdr app' : 'herdr'}; run foreman respawn from there`);
  }
  if (!exists(w.worktree)) throw fail('NO_RUN', `${name}'s worktree ${w.worktree} is gone (cleaned up?); spawn a new worker instead`);
  if ((await herdr.agentList()).some((a) => a.name === name)) {
    throw fail('NAME_TAKEN', `an agent named "${name}" is still running; talk to it with foreman prompt, or close it first`);
  }

  let paneId = null;
  let place = {};
  if (backend === 'app') {
    const here = pane ? await herdr.here(pane) : null;
    if (!newTab && here?.tab) {
      place = { space: here.space, tab: here.tab };
    } else {
      const t = await herdr.tabCreate({ workspaceId: here?.space, cwd: w.worktree, label: `foreman:${run.task}`, focus: false });
      place = { space: t.workspaceId, tab: t.tabId, label: `foreman:${run.task}` };
    }
  } else {
    const panes = herdr.paneList ? await herdr.paneList().catch(() => []) : [];
    const old = panes.find((p) => p.pane_id === w.paneId);
    const cwd = old?.foreground_cwd || old?.cwd;
    if (!newTab && cwd && isInside(cwd, w.worktree)) paneId = w.paneId;
    else if (newTab || !pane) paneId = (await herdr.tabCreate({ cwd: w.worktree, label: `foreman:${run.task}`, focus: false })).paneId;
    else paneId = await herdr.paneSplit({ pane, direction: 'right', ratio: 0.5, cwd: w.worktree });
  }

  const start = agentArgs({ name, kind, model, effort, auto, full, config });
  const res = await herdr.agentStart({
    name, kind, pane: paneId, cwd: w.worktree, space: place.space, tab: place.tab, label: place.label,
    timeoutMs: config.startTimeoutMs, args: start.args,
  });
  const { endedAt, endedPhase, ...rest } = w;
  const worker = {
    ...rest,
    kind,
    model,
    auto: start.auto,
    paneId: res.pane ?? paneId,
    respawns: [...(w.respawns ?? []), { at: new Date(now()).toISOString(), kind: w.kind, model: w.model ?? null }],
  };
  return {
    worker,
    status: res.ok ? 'ready' : 'not_ready',
    error: res.ok ? null : `${res.code}: ${res.message}`,
    warnings: start.warnings,
  };
}
