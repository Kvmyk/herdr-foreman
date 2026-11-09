// Command line: `foreman "<task>"` starts a leader; subcommands are the
// mechanics the leader calls from its pane.
import { BACKENDS, checkBackend, detectBackend, callerPane, createBackend, installed } from './backend.js';
import { createGit } from './git.js';
import { loadConfig } from './config.js';
import { inventory, saveAgents } from './inventory/index.js';
import { loadKnowledge, builtinKnowledge } from './knowledge.js';
import { buildBrief } from './brief.js';
import { waitForWorkers } from './wait.js';
import { appendEntries, readEntries, computeStats } from './journal.js';
import { spawnWorkers, SPEC_PATTERN } from './spawn.js';
import { loadRun, listRuns } from './runs.js';
import { workerStatus, mergeWorkers, land, cleanup, findLeftovers } from './collect.js';
import { startForeman } from './start.js';
import { runSetup, formatSetup } from './setup.js';
import { recentStartFailures } from './startfail.js';
import { fail } from './errors.js';
import { createUi } from './ui.js';
import * as fmt from './format.js';
import { commandUsage, nearSubcommand, usageOf, START_USAGE } from './cli-usage.js';
import { VERSION } from './version.js';
import { describeConfig, formatConfig } from './configcmd.js';
import { runWatch } from './watch.js';
import { EXAMPLE } from './task.js';
import { RUN_COMMANDS, runOps, runCommand } from './run-commands.js';
import { setupSettings, prepareWorktrees, formatSetup as formatWorktreeSetup } from './worktree-setup.js';
import { afterWait, afterMerge, afterLand, afterCleanup } from './history.js';
import { takePrefs } from './start-prefs.js';

const HELP = `foreman: describe a task; a lead agent splits it across your coding agents in herdr or the Herdr app.

Usage:
  foreman "<task>"                     start a leader for the task in this git repository
                                       point at files with @name, e.g. @src/login.js; links work too
  foreman -f task.md                   same, with the task written in a file
  ... | foreman                        same, with the task piped in on standard input
  foreman -- <task words...>           same, when the task starts with a subcommand name
  foreman --backend app|herdr ...      start in the Herdr app or in herdr (default: where you run it;
                                       also FOREMAN_BACKEND)
  foreman --leader <kind> --base <branch> "<task>"
                                       this task only: lead with another agent (default: the config
                                       leader), start the run from <branch> and land it there instead
                                       of on the current branch (the Herdr app prompt has these as pills)
  foreman --auto-answer --include-uncommitted "<task>"
                                       answer the leader's two usual questions in advance: workers get
                                       --auto, and a copy of the changes not committed yet
                                       (the Herdr app prompt has these as checkboxes)
  foreman setup                        check herdr, git and your agents, add the herdr shortcut,
                                       and say what to do next (also: foreman doctor, or just foreman)

Subcommands (used by the leader; add --json for machine-readable output):
  agents                               agents installed here: signed in? which models?
  brief                                everything the leader needs to plan, as JSON
  spawn --task <slug> [--new-tab] [--effort low|medium|high|xhigh|max] [--full] [--auto] [--branch <type>/<name>] [--base <branch>] [--include-uncommitted] <name>=<kind>[:<model>]...
                                       open workers in their own worktrees and panes
                                       (claude workers start lean unless --full;
                                       --auto starts workers in their auto-approve mode;
                                       --include-uncommitted starts workers from a copy
                                       that also holds the changes not committed yet;
                                       --base starts the run from that branch and land merges into it)
  wait --task <slug> [--phase investigate|implement] [--only a,b] [--timeout ms]
                                       block until workers finish or one needs attention
  status --task <slug>                 what each worker changed and reported
  watch --task <slug> [--interval seconds]
                                       status, refreshed until you press Ctrl+C
  merge --task <slug> [--only a,b]     collect committed work on the run branch
  land --task <slug> [--title <summary>]
                                       merge the run branch into your current branch (or the run's --base)
  cleanup --task <slug> [--delete-branch]
                                       close worker panes, remove worktrees and worker branches
  cleanup [--all]                      list runs left behind (open workers, worktrees); --all cleans them
  close-leader                         close the calling leader's pane (its last step)
  prompt --task <slug> <name> "<text>" send an agent a message
  read --task <slug> <name> [--lines n]
                                       print what an agent's pane shows (n lines of history too)
  keys --task <slug> <name> <key>...   press keys in an agent's pane: enter, esc, up, down, 1, ...
                                       (prompt, read and keys also take --backend app|herdr)
  journal add <file.json>              record how each worker did
  journal stats                        results per category and agent

Runs (for you):
  runs                                 earlier and current runs: phase, branch, workers, cost
  show --task <slug>                   one run: the task, workers, reports, tokens and estimated cost
  diff --task <slug> [--stat] [<worker>]
                                       what the run (or one worker) changed against its base
  resume --task <slug>                 start a new leader that continues an interrupted run
  respawn --task <slug> <name>[=<kind>[:<model>]]
                                       restart a worker that stopped, in its own worktree
  config                               the settings in use, with defaults, and where foreman keeps its files
  --version                            the installed version

Where to start: Ctrl+B then F in herdr, Ctrl+Shift+Y in the Herdr app, or foreman "<task>" in any terminal.
Examples:
  foreman "fix the login page so it shows an error for a wrong password, see @src/login.js"
  foreman -f task.md                   a longer task written in a file
  foreman agents                       which agents are installed and signed in
  foreman cleanup --all                remove what an interrupted run left behind

Foreman never pushes and creates no pull request. It arms a push guard (a tripwire) on each worker worktree.
More: README.md ("If something does not work", FAQ) and https://github.com/Kvmyk/herdr-foreman
`;

// Each subcommand: flags it accepts (true = takes a value), required flags,
// and which positional arguments are valid.
const COMMANDS = {
  agents: { flags: { '--json': false, '--quick': false }, positionals: (p) => p.length === 0 },
  brief: { flags: { '--json': false }, positionals: (p) => p.length === 0 },
  spawn: { flags: { '--task': true, '--new-tab': false, '--effort': true, '--full': false, '--auto': false, '--include-uncommitted': false, '--branch': true, '--base': true, '--json': false }, required: ['--task'], positionals: (p) => p.length > 0 && p.every((s) => SPEC_PATTERN.test(s)) },
  wait: { flags: { '--task': true, '--phase': true, '--only': true, '--timeout': true, '--json': false }, required: ['--task'], positionals: (p) => p.length === 0 },
  status: { flags: { '--task': true, '--json': false }, required: ['--task'], positionals: (p) => p.length === 0 },
  merge: { flags: { '--task': true, '--only': true, '--json': false }, required: ['--task'], positionals: (p) => p.length === 0 },
  land: { flags: { '--task': true, '--title': true, '--json': false }, required: ['--task'], positionals: (p) => p.length === 0 },
  cleanup: { flags: { '--task': true, '--all': false, '--delete-branch': false, '--json': false }, positionals: (p) => p.length === 0 },
  'close-leader': { flags: { '--json': false }, positionals: (p) => p.length === 0 },
  // --task is required so that a task such as "read the docs" still starts a leader.
  prompt: { flags: { '--task': true, '--backend': true, '--json': false }, required: ['--task'], positionals: (p) => p.length === 2 },
  read: { flags: { '--task': true, '--backend': true, '--lines': true }, required: ['--task'], positionals: (p) => p.length === 1 },
  keys: { flags: { '--task': true, '--backend': true, '--json': false }, required: ['--task'], positionals: (p) => p.length >= 2 },
  journal: { flags: { '--json': false }, positionals: (p) => (p[0] === 'add' && p.length === 2) || (p[0] === 'stats' && p.length === 1) },
  watch: { flags: { '--task': true, '--interval': true }, required: ['--task'], positionals: (p) => p.length === 0 },
  config: { flags: { '--json': false }, positionals: (p) => p.length === 0 },
  help: { flags: {}, positionals: (p) => p.length === 0 },
  setup: { flags: { '--json': false, '--quiet': false, '--postinstall': false }, positionals: (p) => p.length === 0 },
  doctor: { flags: { '--json': false }, positionals: (p) => p.length === 0 },
  ...RUN_COMMANDS,
};

const USAGE_CODES = new Set(['USAGE', 'BAD_SPEC', 'TOO_MANY', 'BAD_TASK', 'BAD_EFFORT', 'BAD_BRANCH', 'BAD_BASE', 'BRANCH_REQUIRED', 'UNKNOWN_KIND', 'NAME_TAKEN', 'NO_PANE', 'INVALID_ENTRY', 'NO_RUN']);

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
// `--backend <name>` before or after a task picks where the leader starts.
export function route(argv) {
  const at = argv[0] === '--backend' ? 0 : argv.at(-2) === '--backend' ? argv.length - 2 : -1;
  if (at >= 0 && BACKENDS.includes(argv[at + 1])) {
    const r = route([...argv.slice(0, at), ...argv.slice(at + 2)]);
    if (r.kind === 'start') return { ...r, backend: argv[at + 1] };
    return { kind: 'usage', message: 'foreman --backend goes with a task, e.g. foreman --backend app "fix the login"' };
  }
  if (argv[0] === '--backend') return { kind: 'usage', message: `foreman --backend is ${BACKENDS.join(' or ')}` };
  // --auto-answer and --include-uncommitted in front of a task answer the leader's questions in advance.
  const { prefs, rest, error } = takePrefs(argv);
  if (error) return { kind: 'usage', message: `foreman ${error}, e.g. foreman --leader codex "fix the login"\nUsage: ${START_USAGE}` };
  if (rest.length < argv.length) {
    const r = route(rest);
    return r.kind === 'start' ? { ...r, prefs } : { kind: 'usage', message: `foreman --auto-answer, --include-uncommitted, --leader and --base go in front of a task, e.g. foreman --auto-answer "fix the login"\nUsage: ${START_USAGE}` };
  }
  if (argv.length === 0) return { kind: 'help', code: 2 };
  if (argv[0] === '--') return { kind: 'start', task: argv.slice(1).join(' ') };
  if (['-f', '--file'].includes(argv[0])) {
    return argv.length === 2 ? { kind: 'start', file: argv[1] } : { kind: 'usage', message: `foreman ${argv[0]} needs one file name, e.g. foreman -f task.md` };
  }
  if (argv[0].startsWith('--file=') && argv.length === 1) return { kind: 'start', file: argv[0].slice(7) };
  if (['--help', '-h'].includes(argv[0]) && argv.length === 1) return { kind: 'help', code: 0 };
  if (['--version', '-v'].includes(argv[0]) && argv.length === 1) return { kind: 'version' };
  const name = argv[0];
  if (name in COMMANDS && name !== 'help' && argv.length === 2 && ['--help', '-h'].includes(argv[1])) return { kind: 'help', code: 0, topic: name };
  const spec = COMMANDS[name];
  if (!spec || /\s/.test(name)) {
    const near = /\s/.test(name) ? null : nearSubcommand(name);
    if (near && argv.slice(1).some((a) => a.startsWith('--'))) return { kind: 'usage', message: `foreman: unknown subcommand ${name}. Did you mean "foreman ${near}"?\nTo start a task that begins with "${name}", write: foreman -- ${argv.join(' ')}` };
    return { kind: 'start', task: argv.join(' ') };
  }
  const parsed = parseFlags(argv.slice(1), spec);
  if (!parsed.error) return { kind: 'command', name, ...parsed };
  if (argv.slice(1).some((a) => a.startsWith('--'))) return { kind: 'usage', message: `foreman ${name}: ${parsed.error}\nUsage: ${usageOf(name)}` };
  return { kind: 'start', task: argv.join(' ') };
}

function defaultOps(deps) {
  // A run keeps the backend its workers were started in; everything else
  // goes where foreman runs now.
  const here = (flag = null) => detectBackend({ env: deps.env, flag, installed: (name) => installed(name, deps) });
  const backend = (name) => createBackend(name, deps);
  const backendOf = (run) => backend(run.backend ?? 'herdr');
  const git = () => createGit({ run: deps.run });
  const config = () => loadConfig({ paths: deps.paths, readFile: deps.readFile });
  const needRun = (task) => {
    const run = loadRun(task, { paths: deps.paths, readFile: deps.readFile });
    if (!run) throw fail('NO_RUN', `no foreman run named "${task}"`);
    return run;
  };
  const agentBackend = (task, flag) => {
    if (flag) return backend(checkBackend(flag));
    return backend(loadRun(task, { paths: deps.paths, readFile: deps.readFile })?.backend ?? here());
  };
  const note = (task, change) => runOps(deps).noteRun(task, change);
  // Every full look at the agents is kept for the desktop prompt.
  const inv = async ({ versions = true } = {}) => saveAgents({ writeFile: deps.writeFile, file: deps.paths.agentsCache }, await inventory({
    run: deps.run, which: deps.which, env: deps.env, readJson: deps.readJson, exists: deps.exists,
    home: deps.homedir, exclude: config().excludeKinds, versions,
  }));

  const setupDeps = () => ({
    run: deps.run, which: deps.which, env: deps.env, cwd: deps.cwd, homedir: deps.homedir, platform: deps.platform, paths: deps.paths,
    readFile: deps.readFile, writeFile: deps.writeFile, removeFile: deps.removeFile, exists: deps.exists, tmpdir: deps.tmpdir,
    nodeVersion: deps.nodeVersion, inventory: inv,
  });

  return {
    inventory: inv,
    setup: (opts) => runSetup(setupDeps(), opts),
    autoSetupOff: () => Boolean(deps.env?.FOREMAN_NO_SETUP) || config().autoSetup === false,
    // First run of a task: set up quietly once, unless the user turned it off.
    async ensureSetup() {
      try {
        if (this.autoSetupOff() || deps.exists(deps.paths.setupState)) return null;
        return await runSetup(setupDeps(), { quiet: true });
      } catch {
        return null;
      }
    },
    async brief() {
      const cfg = config();
      const g = git();
      const repo = await g.toplevel(deps.cwd);
      const repoDirty = repo ? await g.isDirty(repo) : null;
      const [agents, know] = await Promise.all([
        inv(),
        loadKnowledge({ paths: deps.paths, fetchImpl: deps.fetchImpl, readFile: deps.readFile, writeFile: deps.writeFile, now: deps.now(), knowledgeUrl: cfg.knowledgeUrl }),
      ]);
      return buildBrief({
        agents,
        knowledge: know.knowledge,
        modelsDev: know.modelsDev,
        stats: computeStats(readEntries({ path: deps.paths.journal, readFile: deps.readFile })),
        config: cfg,
        warnings: know.warnings,
        repoDirty,
        startFailures: recentStartFailures({ paths: deps.paths, readFile: deps.readFile, now: deps.now }),
      });
    },
    async wait({ task, phase, only, timeoutMs }) {
      const run = needRun(task);
      const result = await waitForWorkers({
        run, herdr: backendOf(run), foremanCmd: deps.foremanCmd, exists: deps.exists, mtimeMs: deps.mtimeMs, sleep: deps.sleep, now: deps.now,
        phase, only, timeoutMs: timeoutMs ?? config().waitTimeoutMs,
      });
      note(task, (r) => afterWait(r, { phase, result, now: deps.now }));
      return result;
    },
    async spawn({ task, specs, newTab, effort, full, auto, includeUncommitted, branch, baseBranch = null }) {
      const g = git();
      const repo = await g.toplevel(deps.cwd);
      if (!repo) throw fail('USAGE', 'run foreman spawn inside the git repository');
      const name = here();
      const cfg = config();
      const prepare = (workers) => prepareWorktrees({ repo, workers, settings: setupSettings({ config: cfg, repo, readFile: deps.readFile }) });
      return spawnWorkers({
        herdr: backend(name), git: g, paths: deps.paths, config: cfg, prepare, repo, task, specs, newTab, effort, full, auto, includeUncommitted, branch, baseBranch, run: deps.run, sleep: deps.sleep, now: deps.now, foremanCmd: deps.foremanCmd,
        pane: callerPane(name, deps.env), writeFile: deps.writeFile, readFile: deps.readFile, appendFile: deps.appendFile, mkdir: deps.mkdir,
      });
    },
    status: async ({ task }) => {
      const run = needRun(task);
      return workerStatus({ run, git: git(), exists: deps.exists, herdr: backendOf(run), now: deps.now });
    },
    async merge({ task, only }) {
      const result = await mergeWorkers({ run: needRun(task), git: git(), paths: deps.paths, exists: deps.exists, only });
      note(task, (r) => afterMerge(r, { result, now: deps.now }));
      return result;
    },
    async land({ task, title }) {
      const result = await land({ run: needRun(task), git: git(), title, tmpdir: deps.tmpdir });
      note(task, (r) => afterLand(r, { result, now: deps.now }));
      return result;
    },
    async leftovers() {
      const runs = listRuns({ paths: deps.paths, readdir: deps.readdir, readFile: deps.readFile });
      const out = [];
      for (const name of new Set(runs.map((r) => r.backend ?? 'herdr'))) {
        const agents = await backend(name).agentList().catch(() => []);
        out.push(...findLeftovers({ runs: runs.filter((r) => (r.backend ?? 'herdr') === name), paths: deps.paths, exists: deps.exists, agents }));
      }
      return out;
    },
    async cleanupAll({ deleteBranch }) {
      const results = [];
      for (const left of await this.leftovers()) {
        results.push({ task: left.task, ...(await this.cleanup({ task: left.task, deleteBranch })) });
      }
      return results;
    },
    async closeLeader() {
      const name = here();
      const pane = callerPane(name, deps.env);
      if (!pane || (name === 'herdr' && deps.env.HERDR_ENV !== '1')) throw fail('USAGE', 'close-leader runs inside a herdr pane or a Herdr app terminal');
      await backend(name).paneClose(pane);
      return { closed: pane };
    },
    // How the leader talks to agents, wherever they run: --backend, else the
    // run's backend, else where foreman runs now.
    async prompt({ task, backend: flag, name, text }) {
      await agentBackend(task, flag).agentPrompt(name, text);
      // Remember when this worker was briefed: wait ignores reports older than that.
      note(task, (r) => ({ briefedAt: { ...r.briefedAt, [name]: deps.now() } }));
      return { sent: name };
    },
    read: async ({ task, backend: flag, name, lines }) => agentBackend(task, flag).agentRead(name, { lines }),
    async keys({ task, backend: flag, name, keys }) {
      await agentBackend(task, flag).agentKeys(name, keys);
      return { sent: name, keys };
    },
    async cleanup({ task, deleteBranch }) {
      const result = await cleanup({
        run: needRun(task), git: git(), herdr: backendOf(needRun(task)), paths: deps.paths, exists: deps.exists, deleteBranch, sleep: deps.sleep, removeDir: deps.removeDir,
      });
      note(task, (r) => afterCleanup(r, { deleteBranch, now: deps.now }));
      return result;
    },
    // cwd, slug and prompt are set by `foreman resume` for a run that already exists.
    start: async ({ task, backend: flag, cwd = deps.cwd, slug = null, prompt = null, prefs }) => startForeman({
      task, cwd, slug, prompt, env: deps.env, herdr: backend(here(flag)), git: git(), which: deps.which, config: config(), paths: deps.paths,
      homedir: deps.homedir, exists: deps.exists, spawnDetached: deps.spawnDetached, attach: deps.attach, sleep: deps.sleep,
      foremanCmd: deps.foremanCmd, writeFile: deps.writeFile, mkdir: deps.mkdir, report: (m) => deps.stdout.write(`${m}\n`),
      progress: typeof deps.progress === 'function' ? deps.progress : deps.progress ? (m) => deps.stdout.write(`  ${m}\n`) : undefined,
      platform: deps.platform, prefs,
    }),
  };
}

export async function main(argv, deps) {
  const { stdout, stderr } = deps;
  // Plain `foreman` is where a newcomer starts: show what works and what to do.
  let r = argv.length ? route(argv) : { kind: 'command', name: 'setup', flags: {}, positionals: [] };
  if (argv.length === 0 && deps.readStdin) {
    const piped = await deps.readStdin();
    if (piped?.trim()) r = { kind: 'start', task: piped.trim() };
  }
  if (r.kind === 'version') {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (r.kind === 'help') {
    stdout.write(r.topic ? commandUsage(r.topic) : HELP);
    return r.code;
  }
  if (r.kind === 'usage') {
    stderr.write(`${r.message}\nRun "foreman --help" for usage.\n`);
    return 2;
  }

  const ops = { ...defaultOps(deps), ...runOps(deps), ...deps.ops };
  const ui = createUi({ env: deps.env, stream: stdout });
  // Plain text for a person at a terminal; scripts and the leader get JSON.
  const forPerson = (human) => (stdout.isTTY ? human : null);
  const print = (value, human) => {
    // Compact JSON: the leader reads it, and whitespace is tokens too.
    if (r.flags?.['--json'] || !human) stdout.write(`${JSON.stringify(value)}\n`);
    else human(value);
  };

  try {
    if (r.kind === 'start') {
      let task = r.task;
      if (r.file) {
        try {
          task = deps.readFile(r.file).trim();
        } catch {
          throw fail('USAGE', `I could not read the file ${r.file}. Check the name and try again.`);
        }
        if (!task) throw fail('USAGE', `The file ${r.file} is empty. Write what you want done in it, for example: ${EXAMPLE}`);
      }
      const setup = await ops.ensureSetup?.();
      if (setup?.changes.length) stdout.write(`${formatSetup(setup, createUi({ env: deps.env, stream: stdout }))}
`);
      const res = await ops.start({ task, ...(r.backend ? { backend: r.backend } : {}), ...(r.prefs ? { prefs: r.prefs } : {}) });
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
      case 'setup':
      case 'doctor': {
        const quiet = Boolean(r.flags['--quiet'] || r.flags['--postinstall']);
        let res;
        try {
          if (quiet && ops.autoSetupOff()) return 0;
          res = await ops.setup({ quiet, postinstall: Boolean(r.flags['--postinstall']) });
        } catch (err) {
          // Install and startup hooks must never fail because of setup.
          if (!quiet) throw err;
          stderr.write(`foreman setup: ${err.message}\n`);
          return 0;
        }
        print(res, (v) => {
          const text = formatSetup(v, ui);
          if (text) stdout.write(`${text}\n`);
        });
        return res.ok || quiet ? 0 : 1;
      }
      case 'agents':
        print(await ops.inventory({ versions: !r.flags['--quick'] }), (v) => stdout.write(`${fmt.formatAgents(v, ui)}\n`));
        return 0;
      case 'brief':
        print(await ops.brief(), forPerson((v) => stdout.write(`${fmt.formatBrief(v, ui)}\n`)));
        return 0;
      case 'spawn': {
        const res = await ops.spawn({
          task, specs: r.positionals, newTab: Boolean(r.flags['--new-tab']), effort: r.flags['--effort'] ?? null, full: Boolean(r.flags['--full']), auto: Boolean(r.flags['--auto']), includeUncommitted: Boolean(r.flags['--include-uncommitted']), branch: r.flags['--branch'] ?? null, baseBranch: r.flags['--base'] ?? null,
        });
        print(res, (v) => {
          stdout.write(`${fmt.formatSpawn(v, ui)}\n`);
          for (const s of v.setup ?? []) stdout.write(`${formatWorktreeSetup(s)}\n`);
        });
        // An agent that exited at start is a failure; one waiting for an answer is not.
        return res.workers.some((w) => w.exited) ? 1 : 0;
      }
      case 'status':
        print(await ops.status({ task }), (v) => stdout.write(`${fmt.formatStatus(v, ui)}\n`));
        return 0;
      case 'merge': {
        const res = await ops.merge({ task, only: r.flags['--only']?.split(',').map((s) => s.trim()).filter(Boolean) ?? null });
        print(res, (v) => {
          stdout.write(`merged into ${v.branch}: ${v.merged.join(', ') || 'nothing'}\n`);
          for (const s of v.skipped) stdout.write(`skipped ${s.worker}: ${s.reason}\n`);
          for (const s of v.refused) stdout.write(`refused ${s.worker}: ${s.reason}\n`);
          for (const x of v.warnings ?? []) stdout.write(`warning: ${x}\n`);
          if (v.conflict) stdout.write(`conflict with ${v.conflict.worker}: ${v.conflict.files.join(', ')}\n`);
        });
        return res.conflict || res.refused.length ? 1 : 0;
      }
      case 'land': {
        const res = await ops.land({ task, title: r.flags['--title'] ?? null });
        print(res, (v) => stdout.write(v.ok ? `merged ${v.branch} into ${v.into ? `${v.into} (your checkout was not touched unless it is on ${v.into})` : 'your current branch'}\n` : `not merged: ${v.reason}${v.files ? ` (${v.files.join(', ')})` : ''}\n`));
        return res.ok ? 0 : 1;
      }
      case 'wait': {
        const phase = r.flags['--phase'] ?? null;
        if (phase && !['investigate', 'implement'].includes(phase)) throw fail('USAGE', '--phase is investigate or implement');
        const timeout = r.flags['--timeout'] ? Number(r.flags['--timeout']) : undefined;
        if (timeout !== undefined && !(timeout > 0)) throw fail('USAGE', '--timeout is a number of milliseconds');
        const only = r.flags['--only']?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
        print(await ops.wait({ task, phase, only, timeoutMs: timeout }), forPerson((v) => stdout.write(`${fmt.formatWait(v, ui)}\n`)));
        return 0;
      }
      case 'prompt': {
        const [name, text] = r.positionals;
        print(await ops.prompt({ task, backend: r.flags['--backend'] ?? null, name, text }), (v) => stdout.write(`sent to ${v.sent}\n`));
        return 0;
      }
      case 'read': {
        const lines = r.flags['--lines'] === undefined ? null : Number(r.flags['--lines']);
        if (lines !== null && !(Number.isInteger(lines) && lines >= 0)) throw fail('USAGE', '--lines is a whole number');
        const text = await ops.read({ task, backend: r.flags['--backend'] ?? null, name: r.positionals[0], lines });
        stdout.write(text.endsWith('\n') ? text : `${text}\n`);
        return 0;
      }
      case 'keys': {
        const [name, ...keys] = r.positionals;
        print(await ops.keys({ task, backend: r.flags['--backend'] ?? null, name, keys }), (v) => stdout.write(`pressed ${v.keys.join(' ')} in ${v.sent}\n`));
        return 0;
      }
      case 'config':
        print(describeConfig({ paths: deps.paths, readFile: deps.readFile, env: deps.env }), (v) => stdout.write(`${formatConfig(v, ui)}\n`));
        return 0;
      case 'watch': {
        const interval = r.flags['--interval'] === undefined ? 5 : Number(r.flags['--interval']);
        if (!(interval > 0)) throw fail('USAGE', '--interval is a number of seconds');
        return runWatch({
          status: () => ops.status({ task }), render: (v) => fmt.formatStatus(v, ui), stdout, sleep: deps.sleep, intervalS: interval, tty: Boolean(stdout.isTTY),
        });
      }
      case 'close-leader':
        print(await ops.closeLeader(), (v) => stdout.write(`closed ${v.closed}\n`));
        return 0;
      case 'cleanup': {
        const deleteBranch = Boolean(r.flags['--delete-branch']);
        if (!task && r.flags['--all']) {
          const all = await ops.cleanupAll({ deleteBranch });
          print(all, (v) => {
            if (!v.length) stdout.write('nothing to clean up\n');
            for (const x of v) stdout.write(`${x.task}: closed ${x.closedPanes.length} panes, removed ${x.removedWorktrees.length} worktrees${x.errors.length ? `, ${x.errors.length} errors` : ''}\n`);
          });
          return all.some((x) => x.errors.length) ? 1 : 0;
        }
        if (!task) {
          const left = await ops.leftovers();
          print(left, (v) => {
            if (!v.length) {
              stdout.write('nothing left behind\n');
              return;
            }
            for (const x of v) stdout.write(`${x.task}  (${x.repo})  worktrees: ${x.worktrees.length}  live workers: ${x.liveWorkers.join(', ') || 'none'}\n`);
            stdout.write('Clean one with "foreman cleanup --task <slug>", or all with "foreman cleanup --all".\n');
          });
          return 0;
        }
        const res = await ops.cleanup({ task, deleteBranch });
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
          const n = appendEntries(await ops.withUsage?.(entries) ?? entries, { path: deps.paths.journal, appendFile: deps.appendFile, categories: builtinKnowledge().categories, now: deps.now?.() });
          print({ added: n }, (v) => stdout.write(`added ${v.added} journal entries\n`));
          return 0;
        }
        print(computeStats(readEntries({ path: deps.paths.journal, readFile: deps.readFile })), forPerson((v) => stdout.write(`${fmt.formatStats(v, ui)}\n`)));
        return 0;
      }
      default:
        if (r.name in RUN_COMMANDS) return await runCommand(r, { ops, print, stdout, ui });
        throw fail('USAGE', `unknown subcommand ${r.name}`);
    }
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return USAGE_CODES.has(err.code) ? 2 : 1;
  }
}
