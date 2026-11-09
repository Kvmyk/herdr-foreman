// Subcommands about runs as a whole: their history (runs, show). They live
// here so cli.js only routes to them.
import { createBackend } from './backend.js';
import { listRuns, loadRun } from './runs.js';
import { summarizeRuns, describeRun, formatRuns, formatShow, updateRun } from './history.js';
import { fail } from './errors.js';

// Same shape as COMMANDS in cli.js: flags (true = takes a value), required
// flags, valid positionals. --task is required wherever a task sentence
// ("show me the login bug") must still start a leader.
export const RUN_COMMANDS = {
  runs: { flags: { '--json': false }, positionals: (p) => p.length === 0 },
  show: { flags: { '--task': true, '--json': false }, required: ['--task'], positionals: (p) => p.length === 0 },
};

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

  return {
    // History notes from the commands that move a run along.
    noteRun: (task, change) => updateRun(task, change, { ...io, writeFile: deps.writeFile, mkdir: deps.mkdir, now: deps.now }),
    async runs() {
      const runs = listRuns({ ...io, readdir: deps.readdir });
      return summarizeRuns({ runs, exists: deps.exists, agents: await agentsFor(runs) });
    },
    async show({ task }) {
      const run = needRun(task);
      return describeRun(run, { ...io, exists: deps.exists, agents: await agentsFor([run]) });
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
    default:
      throw fail('USAGE', `unknown subcommand ${r.name}`);
  }
}
