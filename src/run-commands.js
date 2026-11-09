// Subcommands about runs as a whole: their history (runs, show) and their
// changes (diff). They live
// here so cli.js only routes to them.
import { createBackend } from './backend.js';
import { listRuns, loadRun } from './runs.js';
import { loadKnowledge } from './knowledge.js';
import { summarizeRuns, describeRun, formatRuns, formatShow, updateRun, phaseOf } from './history.js';
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
    default:
      throw fail('USAGE', `unknown subcommand ${r.name}`);
  }
}
