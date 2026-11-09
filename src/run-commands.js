// Subcommands about runs as a whole: their history (runs, show), their
// changes (diff), and picking them up again (resume, respawn). They live
// here so cli.js only routes to them.
import path from 'node:path';
import { createBackend, callerPane } from './backend.js';
import { loadConfig } from './config.js';
import { EFFORT_LEVELS } from './inventory/kinds.js';
import { INSTRUCTIONS_PATH } from './start.js';
import { resumeNotes, resumeFile, buildResumePrompt, respawnWorker, RESPAWN_SPEC } from './resume.js';
import { listRuns, loadRun } from './runs.js';
import { loadKnowledge } from './knowledge.js';
import { summarizeRuns, describeRun, formatRuns, formatShow, updateRun, phaseOf, readTask } from './history.js';
import { runUsage, usageForEntries } from './usage.js';
import { runDiff, formatDiff } from './diff.js';
import { createGit } from './git.js';
import { fail } from './errors.js';

// Same shape as COMMANDS in cli.js: flags (true = takes a value), required
// flags, valid positionals. --task is required wherever a task sentence
// ("show me the login bug") must still start a leader.
export const RUN_COMMANDS = {
  runs: { flags: { '--json': false }, positionals: (p) => p.length === 0 },
  show: { flags: { '--task': true, '--json': false }, required: ['--task'], positionals: (p) => p.length === 0 },
  diff: { flags: { '--task': true, '--stat': false, '--json': false }, required: ['--task'], positionals: (p) => p.length <= 1 },
  resume: { flags: { '--task': true, '--json': false }, required: ['--task'], positionals: (p) => p.length === 0 },
  respawn: {
    flags: { '--task': true, '--new-tab': false, '--effort': true, '--auto': false, '--full': false, '--json': false },
    required: ['--task'],
    positionals: (p) => p.length === 1 && RESPAWN_SPEC.test(p[0]),
  },
};

const usageSummary = (u) => ({ total: u.total, tokens: u.tokens, costUsd: u.costUsd, costKnown: u.costKnown, unknown: u.unknown });

export function runOps(deps) {
  const io = { paths: deps.paths, readFile: deps.readFile };
  const needRun = (task) => {
    const run = loadRun(task, io);
    if (!run) throw fail('NO_RUN', `no foreman run named "${task}"; "foreman runs" lists them`);
    return run;
  };
  // Live agents of every backend the runs used; a backend that is not running has none.
  const agentsFor = async (runs) => {
    const out = [];
    for (const name of new Set(runs.map((r) => r.backend ?? 'herdr'))) {
      out.push(...(await createBackend(name, deps).agentList().catch(() => [])));
    }
    return out;
  };
  // Prices from the models.dev copy foreman already has; never the network.
  const usageCtx = async () => {
    let modelsDev = {};
    try {
      modelsDev = (await loadKnowledge({ ...io, writeFile: () => {}, offline: true })).modelsDev;
    } catch {
      // No prices: tokens are still shown.
    }
    return { home: deps.homedir, env: deps.env ?? {}, modelsDev };
  };
  const noteRun = (task, change) => updateRun(task, change, { ...io, writeFile: deps.writeFile, mkdir: deps.mkdir, now: deps.now });

  return {
    // History notes from the commands that move a run along.
    noteRun,
    async runs() {
      const runs = listRuns({ ...io, readdir: deps.readdir });
      const ctx = await usageCtx();
      const withUsage = runs.map((run) => {
        if (run.usage) return run;
        const usage = usageSummary(runUsage(run, ctx));
        // A cleaned-up run does not change any more: keep its usage.
        if (phaseOf(run) === 'cleaned') noteRun(run.task, (r) => ({ usage, updatedAt: r.updatedAt }));
        return { ...run, usage };
      });
      return summarizeRuns({ runs: withUsage, exists: deps.exists, agents: await agentsFor(runs) });
    },
    async show({ task }) {
      const run = needRun(task);
      const d = describeRun(run, { ...io, exists: deps.exists, agents: await agentsFor([run]) });
      const usage = runUsage(run, await usageCtx());
      d.workers.forEach((w) => { w.usage = usage.workers[w.name]; });
      return { ...d, usage: usageSummary(usage) };
    },
    diff: async ({ task, name, stat }) => runDiff({ run: needRun(task), git: createGit({ run: deps.run }), exists: deps.exists, name, stat }),
    // The note and prompt for a new leader of an interrupted run.
    async prepareResume({ task }) {
      const run = needRun(task);
      if (phaseOf(run) === 'cleaned') {
        throw fail('USAGE', `run "${task}" is finished (${run.outcome ?? 'cleaned up'}) and its worktrees are gone; start a new task instead`);
      }
      const foremanCmd = deps.foremanCmd ?? 'foreman';
      const notes = resumeNotes(run, { ...io, exists: deps.exists, agents: await agentsFor([run]), foremanCmd });
      const file = resumeFile(deps.paths, task);
      deps.mkdir(path.dirname(file), { recursive: true });
      deps.writeFile(file, notes);
      return {
        slug: task,
        task: readTask(task, io) ?? `resume foreman run ${task}`,
        repo: run.repo,
        backend: run.backend ?? 'herdr',
        notes: file,
        prompt: buildResumePrompt({ slug: task, instructionsPath: INSTRUCTIONS_PATH, notesPath: file, foremanCmd }),
      };
    },
    async respawn({ task, spec, newTab, effort, auto, full }) {
      if (effort && !EFFORT_LEVELS.includes(effort)) throw fail('BAD_EFFORT', `effort must be one of ${EFFORT_LEVELS.join(', ')}`);
      const run = needRun(task);
      const name = spec.split('=')[0];
      const backend = run.backend ?? 'herdr';
      const res = await respawnWorker({
        run, herdr: createBackend(backend, deps), spec, pane: callerPane(backend, deps.env ?? {}), newTab, effort, full,
        // The user's choice about permission questions holds for the whole task.
        auto: auto || Boolean(run.workers.find((w) => w.name === name)?.auto),
        config: loadConfig(io), exists: deps.exists, now: deps.now,
      });
      noteRun(task, (r) => ({ workers: r.workers.map((w) => (w.name === res.worker.name ? res.worker : w)) }));
      const w = res.worker;
      return { name: w.name, kind: w.kind, model: w.model, auto: w.auto, paneId: w.paneId, worktree: w.worktree, reportDir: w.reportDir, status: res.status, error: res.error, warnings: res.warnings };
    },
    // Journal entries with tokens and cost of the worker they describe.
    async withUsage(entries) {
      try {
        return usageForEntries(entries, { loadRun: (t) => loadRun(t, io), ctx: await usageCtx() });
      } catch {
        return entries;
      }
    },
  };
}

// Runs one of RUN_COMMANDS; returns the exit code.
export async function runCommand(r, { ops, print, stdout }) {
  const task = r.flags['--task'];
  switch (r.name) {
    case 'runs':
      print(await ops.runs(), (v) => stdout.write(formatRuns(v)));
      return 0;
    case 'show':
      print(await ops.show({ task }), (v) => stdout.write(formatShow(v)));
      return 0;
    case 'diff':
      print(await ops.diff({ task, name: r.positionals[0] ?? null, stat: Boolean(r.flags['--stat']) }), (v) => stdout.write(formatDiff(v)));
      return 0;
    case 'resume': {
      const prep = await ops.prepareResume({ task });
      const res = await ops.start({ task: prep.task, backend: prep.backend, cwd: prep.repo, slug: prep.slug, prompt: prep.prompt });
      if (!res.ok) throw fail('RESUME_FAILED', res.message);
      print({ slug: prep.slug, notes: prep.notes, leader: res.leader ?? null, paneId: res.paneId ?? null }, (v) => stdout.write(`The new leader starts from ${v.notes}\n`));
      return 0;
    }
    case 'respawn': {
      const res = await ops.respawn({
        task, spec: r.positionals[0], newTab: Boolean(r.flags['--new-tab']), effort: r.flags['--effort'] ?? null, auto: Boolean(r.flags['--auto']), full: Boolean(r.flags['--full']),
      });
      print(res, (v) => {
        stdout.write(`${v.name.padEnd(12)}${v.kind.padEnd(10)}${String(v.paneId ?? '-').padEnd(10)}${v.status}${v.error ? ` (${v.error})` : ''}\n`);
        for (const warning of v.warnings) stdout.write(`warning: ${warning}\n`);
        stdout.write(`${v.name} starts with no memory of its brief; send it again with foreman prompt\n`);
      });
      return res.status === 'ready' ? 0 : 1;
    }
    default:
      throw fail('USAGE', `unknown subcommand ${r.name}`);
  }
}
