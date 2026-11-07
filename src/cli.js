// Command line: `foreman "<task>"` starts a leader; subcommands are the
// mechanics the leader calls from its pane.
import { createHerdr } from './herdr.js';
import { createGit } from './git.js';
import { loadConfig } from './config.js';
import { inventory } from './inventory/index.js';
import { loadKnowledge, lookupModel, familyFor, builtinKnowledge } from './knowledge.js';
import { appendEntries, readEntries, computeStats } from './journal.js';
import { spawnWorkers, SPEC_PATTERN } from './spawn.js';
import { loadRun } from './runs.js';
import { workerStatus, mergeWorkers, land, cleanup } from './collect.js';
import { startForeman } from './start.js';
import { fail } from './errors.js';

const HELP = `foreman: describe a task; a lead agent splits it across your coding agents in herdr.

Usage:
  foreman "<task>"                     start a leader for the task in this git repository
  foreman -- <task words...>           same, when the task starts with a subcommand name

Subcommands (used by the leader; add --json for machine-readable output):
  agents                               agents installed here: signed in? which models?
  brief                                everything the leader needs to plan, as JSON
  spawn --task <slug> [--new-tab] <name>=<kind>[:<model>]...
                                       open workers in their own worktrees and panes
  status --task <slug>                 what each worker changed and reported
  merge --task <slug> [--only a,b]     collect committed work on foreman/<slug>
  land --task <slug>                   merge foreman/<slug> into your current branch
  cleanup --task <slug> [--delete-branch]
                                       close worker panes, remove worktrees and worker branches
  journal add <file.json>              record how each worker did
  journal stats                        results per category and agent

Nothing is pushed and no pull request is created.
`;

// Each subcommand: flags it accepts (true = takes a value), required flags,
// and which positional arguments are valid.
const COMMANDS = {
  agents: { flags: { '--json': false }, positionals: (p) => p.length === 0 },
  brief: { flags: { '--json': false }, positionals: (p) => p.length === 0 },
  spawn: { flags: { '--task': true, '--new-tab': false, '--json': false }, required: ['--task'], positionals: (p) => p.length > 0 && p.every((s) => SPEC_PATTERN.test(s)) },
  status: { flags: { '--task': true, '--json': false }, required: ['--task'], positionals: (p) => p.length === 0 },
  merge: { flags: { '--task': true, '--only': true, '--json': false }, required: ['--task'], positionals: (p) => p.length === 0 },
  land: { flags: { '--task': true, '--json': false }, required: ['--task'], positionals: (p) => p.length === 0 },
  cleanup: { flags: { '--task': true, '--delete-branch': false, '--json': false }, required: ['--task'], positionals: (p) => p.length === 0 },
  journal: { flags: { '--json': false }, positionals: (p) => (p[0] === 'add' && p.length === 2) || (p[0] === 'stats' && p.length === 1) },
  help: { flags: {}, positionals: (p) => p.length === 0 },
};

const USAGE_CODES = new Set(['USAGE', 'BAD_SPEC', 'TOO_MANY', 'BAD_TASK', 'UNKNOWN_KIND', 'NAME_TAKEN', 'NO_PANE', 'INVALID_ENTRY', 'NO_RUN']);

function parseFlags(args, spec) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    if (!(a in spec.flags)) return { error: `unknown option ${a}` };
    if (spec.flags[a]) {
      if (i + 1 >= args.length) return { error: `${a} needs a value` };
      flags[a] = args[++i];
    } else {
      flags[a] = true;
    }
  }
  const missing = (spec.required ?? []).find((f) => !(f in flags));
  if (missing) return { error: `missing ${missing}` };
  if (!spec.positionals(positionals)) return { error: 'unexpected arguments' };
  return { flags, positionals };
}

// Decide between starting a leader and running a subcommand. A task may
// begin with a subcommand word ("status of the app is wrong"), so a
// subcommand is chosen only when the rest of the line fits it.
export function route(argv) {
  if (argv.length === 0) return { kind: 'help', code: 2 };
  if (argv[0] === '--') return { kind: 'start', task: argv.slice(1).join(' ') };
  if (['--help', '-h'].includes(argv[0]) && argv.length === 1) return { kind: 'help', code: 0 };
  const name = argv[0];
  const spec = COMMANDS[name];
  if (!spec || /\s/.test(name)) return { kind: 'start', task: argv.join(' ') };
  const parsed = parseFlags(argv.slice(1), spec);
  if (!parsed.error) return { kind: 'command', name, ...parsed };
  if (argv.slice(1).some((a) => a.startsWith('--'))) return { kind: 'usage', message: `foreman ${name}: ${parsed.error}` };
  return { kind: 'start', task: argv.join(' ') };
}

const ACCESS_ORDER = { subscription: 0, free: 1, local: 2, api: 3, unknown: 4 };

export function summarizeModels(agent, limit = 40) {
  const total = agent.models.length;
  const sorted = [...agent.models].sort((a, b) => {
    if (a.id === agent.defaultModel) return -1;
    if (b.id === agent.defaultModel) return 1;
    return (ACCESS_ORDER[a.access] ?? 9) - (ACCESS_ORDER[b.access] ?? 9);
  });
  const models = sorted.slice(0, limit);
  return { models, modelsTotal: total, modelsOmitted: total - models.length };
}

function defaultOps(deps) {
  const herdr = () => createHerdr({ run: deps.run });
  const git = () => createGit({ run: deps.run });
  const config = () => loadConfig({ paths: deps.paths, readFile: deps.readFile });
  const needRun = (task) => {
    const run = loadRun(task, { paths: deps.paths, readFile: deps.readFile });
    if (!run) throw fail('NO_RUN', `no foreman run named "${task}"`);
    return run;
  };
  const inv = () => inventory({
    run: deps.run, which: deps.which, env: deps.env, readJson: deps.readJson, exists: deps.exists,
    home: deps.homedir, exclude: config().excludeKinds,
  });

  return {
    inventory: inv,
    async brief() {
      const cfg = config();
      const [agents, know] = await Promise.all([
        inv(),
        loadKnowledge({ paths: deps.paths, fetchImpl: deps.fetchImpl, readFile: deps.readFile, writeFile: deps.writeFile, now: deps.now(), knowledgeUrl: cfg.knowledgeUrl }),
      ]);
      const modelsDev = {};
      const inventoryOut = agents.map((a) => {
        const s = summarizeModels(a);
        const models = s.models.map((m) => {
          const fam = familyFor(know.knowledge, m.id);
          const facts = lookupModel(know.modelsDev, m.id);
          if (facts) modelsDev[m.id] = facts;
          return { ...m, family: fam?.id ?? null };
        });
        return { ...a, ...s, models };
      });
      const kinds = new Set(agents.map((a) => a.kind));
      const harnesses = Object.fromEntries(Object.entries(know.knowledge.harnesses ?? {}).filter(([k]) => kinds.has(k)));
      return {
        inventory: inventoryOut,
        knowledge: { ...know.knowledge, harnesses, source: know.source },
        modelsDev,
        stats: computeStats(readEntries({ path: deps.paths.journal, readFile: deps.readFile })),
        config: { maxWorkers: cfg.maxWorkers, leader: cfg.leader },
        warnings: know.warnings,
      };
    },
    async spawn({ task, specs, newTab }) {
      const g = git();
      const repo = await g.toplevel(deps.cwd);
      if (!repo) throw fail('USAGE', 'run foreman spawn inside the git repository');
      return spawnWorkers({
        herdr: herdr(), git: g, paths: deps.paths, config: config(), repo, task, specs, newTab,
        pane: deps.env.HERDR_PANE_ID, writeFile: deps.writeFile, readFile: deps.readFile, mkdir: deps.mkdir,
      });
    },
    status: async ({ task }) => workerStatus({ run: needRun(task), git: git(), exists: deps.exists }),
    merge: async ({ task, only }) => mergeWorkers({ run: needRun(task), git: git(), paths: deps.paths, exists: deps.exists, only }),
    land: async ({ task }) => land({ run: needRun(task), git: git() }),
    cleanup: async ({ task, deleteBranch }) => cleanup({
      run: needRun(task), git: git(), herdr: herdr(), paths: deps.paths, exists: deps.exists, deleteBranch, sleep: deps.sleep, removeDir: deps.removeDir,
    }),
    start: async ({ task }) => startForeman({
      task, cwd: deps.cwd, env: deps.env, herdr: herdr(), git: git(), which: deps.which, config: config(), paths: deps.paths,
      homedir: deps.homedir, exists: deps.exists, spawnDetached: deps.spawnDetached, attach: deps.attach, sleep: deps.sleep,
      foremanCmd: deps.foremanCmd, report: (m) => deps.stdout.write(`${m}\n`),
    }),
  };
}

function printAgents(out, agents) {
  if (!agents.length) {
    out.write('No agent kinds known to herdr were found on PATH.\n');
    return;
  }
  for (const a of agents) {
    const models = a.models.length ? `${a.models.length} models` : '';
    const def = a.defaultModel ? `default ${a.defaultModel}` : '';
    out.write(`${a.kind.padEnd(10)}${a.status.padEnd(13)}${String(a.version ?? '').slice(0, 24).padEnd(26)}${[models, def, a.reason].filter(Boolean).join('; ')}\n`);
  }
}

export async function main(argv, deps) {
  const r = route(argv);
  const { stdout, stderr } = deps;
  if (r.kind === 'help') {
    stdout.write(HELP);
    return r.code;
  }
  if (r.kind === 'usage') {
    stderr.write(`${r.message}\nRun "foreman --help" for usage.\n`);
    return 2;
  }

  const ops = { ...defaultOps(deps), ...deps.ops };
  const print = (value, human) => {
    if (r.flags?.['--json'] || !human) stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else human(value);
  };

  try {
    if (r.kind === 'start') {
      const res = await ops.start({ task: r.task });
      if (!res.ok) {
        stderr.write(`${res.message}\n`);
        return 1;
      }
      return 0;
    }

    const task = r.flags['--task'];
    switch (r.name) {
      case 'help':
        stdout.write(HELP);
        return 0;
      case 'agents':
        print(await ops.inventory(), (v) => printAgents(stdout, v));
        return 0;
      case 'brief':
        print(await ops.brief());
        return 0;
      case 'spawn': {
        const res = await ops.spawn({ task, specs: r.positionals, newTab: Boolean(r.flags['--new-tab']) });
        print(res, (v) => {
          for (const w of v.workers) stdout.write(`${w.name.padEnd(12)}${w.kind.padEnd(10)}${w.paneId.padEnd(10)}${w.status}${w.error ? ` (${w.error})` : ''}\n`);
          for (const warning of v.warnings) stdout.write(`warning: ${warning}\n`);
        });
        return 0;
      }
      case 'status':
        print(await ops.status({ task }), (v) => v.forEach((s) => stdout.write(`${s.name.padEnd(12)}${s.dirty ? 'changed' : 'clean'}  commits ahead: ${s.commitsAhead}  proposals: ${s.proposals ? 'yes' : 'no'}  report: ${s.report ? 'yes' : 'no'}\n`)));
        return 0;
      case 'merge': {
        const res = await ops.merge({ task, only: r.flags['--only']?.split(',').map((s) => s.trim()).filter(Boolean) ?? null });
        print(res, (v) => {
          stdout.write(`merged into ${v.branch}: ${v.merged.join(', ') || 'nothing'}\n`);
          for (const s of v.skipped) stdout.write(`skipped ${s.worker}: ${s.reason}\n`);
          for (const s of v.refused) stdout.write(`refused ${s.worker}: ${s.reason}\n`);
          if (v.conflict) stdout.write(`conflict with ${v.conflict.worker}: ${v.conflict.files.join(', ')}\n`);
        });
        return res.conflict || res.refused.length ? 1 : 0;
      }
      case 'land': {
        const res = await ops.land({ task });
        print(res, (v) => stdout.write(v.ok ? `merged ${v.branch} into your current branch\n` : `not merged: ${v.reason}${v.files ? ` (${v.files.join(', ')})` : ''}\n`));
        return res.ok ? 0 : 1;
      }
      case 'cleanup': {
        const res = await ops.cleanup({ task, deleteBranch: Boolean(r.flags['--delete-branch']) });
        print(res, (v) => {
          stdout.write(`closed ${v.closedPanes.length} panes, removed ${v.removedWorktrees.length} worktrees, deleted ${v.deletedBranches.length} branches\n`);
          for (const e of v.errors) stdout.write(`error: ${e}\n`);
        });
        return res.errors.length ? 1 : 0;
      }
      case 'journal': {
        if (r.positionals[0] === 'add') {
          let entries;
          try {
            entries = JSON.parse(deps.readFile(r.positionals[1]));
          } catch (err) {
            throw fail('USAGE', `cannot read ${r.positionals[1]}: ${err.message}`);
          }
          const n = appendEntries(entries, { path: deps.paths.journal, appendFile: deps.appendFile, categories: builtinKnowledge().categories, now: deps.now?.() });
          print({ added: n }, (v) => stdout.write(`added ${v.added} journal entries\n`));
          return 0;
        }
        print(computeStats(readEntries({ path: deps.paths.journal, readFile: deps.readFile })));
        return 0;
      }
      default:
        throw fail('USAGE', `unknown subcommand ${r.name}`);
    }
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return USAGE_CODES.has(err.code) ? 2 : 1;
  }
}
