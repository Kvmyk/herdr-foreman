// `foreman launcher`: a terminal that stays open and takes one task after
// another. It is made for the Herdr phone app, which has no shortcut and no
// prompt window: the launcher reports a status like an agent does (OSC 7501),
// so it has a row in the phone's Inbox, and a task pasted or dictated into it
// starts a leader. Settings are numbers, because flags are awkward on a
// touch keyboard.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskReader } from './task.js';
import { createUi } from './ui.js';
import { loadConfig } from './config.js';
import { listRuns } from './runs.js';
import { createGit } from './git.js';
import { isInside } from './history.js';
import { createBackend, detectBackend, findTool, installed } from './backend.js';
import { applySetting, choiceLines, initialSettings, isSettingCommand, menuKey, menuLines, pickChoice, settingsArgs } from './start-settings.js';
import { loadRemembered, saveRemembered } from './start-prefs.js';
import { listLeaders } from './ask.js';
import { statusSeq, titleSeq } from './status.js';

export const LAUNCHER_NAME = 'foreman';
export const LAUNCHER_LABEL = 'foreman.launcher=1';
export const LAUNCHER_TITLE = 'foreman: new task';
const BIN = fileURLToPath(new URL('../bin/foreman.js', import.meta.url));

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const firstLine = (text) => String(text ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
const forward = (p) => p.replace(/\\/g, '/');

// The status reports and the title are in status.js, shared with `foreman watch`.
export { statusSeq, titleSeq };

// A message sent from another hc terminal arrives as <hc from="t4 lead">text</hc>.
export function stripHcWrapper(text) {
  const m = /^\s*<hc\b[^>]*>([\s\S]*)<\/hc>\s*$/.exec(text);
  return (m ? m[1] : text).trim();
}

const stamp = (run) => {
  const t = run.updatedAt ?? run.createdAt ?? 0;
  return typeof t === 'number' ? t : Date.parse(t) || 0;
};

// The projects a task can start in, most likely first: the folder the
// launcher runs in, the repositories of the latest runs (up to 6 that still
// exist), then those the live terminals work in. Never the home folder or a
// worker's worktree.
export async function projectChoices({ cwd = null, runs = [], cwds = [], toplevel, exists, homedir = null, worktrees = null, limit = 9, platform = process.platform }) {
  const out = [];
  const seen = new Set();
  const key = (p) => {
    const n = path.resolve(p).replace(/[\\/]+$/, '');
    return platform === 'win32' ? n.toLowerCase() : n;
  };
  const add = (repo) => {
    if (!repo || out.length >= limit) return false;
    const k = key(repo);
    if (seen.has(k) || (homedir && k === key(homedir)) || (worktrees && isInside(repo, worktrees)) || !exists(repo)) return false;
    seen.add(k);
    out.push(repo);
    return true;
  };
  const root = async (dir) => {
    try {
      return await toplevel(dir);
    } catch {
      return null;
    }
  };
  if (cwd) add(await root(cwd));
  let fromRuns = 0;
  for (const run of [...runs].sort((a, b) => stamp(b) - stamp(a))) {
    if (fromRuns >= 6) break;
    if (add(run.repo)) fromRuns++;
  }
  for (const dir of [...new Set(cwds.filter(Boolean))].slice(0, 12)) {
    if (worktrees && isInside(dir, worktrees)) continue;
    add(await root(dir));
  }
  return out;
}

// A short name for each project: its folder, with the parent when two share a name.
export function projectNames(repos) {
  const base = repos.map((r) => path.basename(r) || r);
  return repos.map((r, i) => (base.indexOf(base[i]) === base.lastIndexOf(base[i]) ? base[i] : `${path.basename(path.dirname(r))}/${base[i]}`));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Keep one launcher open on this machine, when the user asked for it with
// "launcher": true in config.json. It gets no herdr.space / herdr.tab labels,
// so the desktop window stays as it is. Never throws.
// status: off | no-core | already | started | failed
export async function ensureLauncher({ config, run, hc, homedir, node = process.execPath, bin = BIN, name = LAUNCHER_NAME, label = LAUNCHER_LABEL }) {
  if (config?.launcher !== true) return { status: 'off' };
  if (!hc) return { status: 'no-core', reason: 'herdr-core (hc) is not installed' };
  const call = async (args, timeoutMs = 15000) => {
    try {
      const res = await run(hc, args, { timeoutMs });
      const body = parseJson(res.stdout) ?? parseJson(res.stderr) ?? {};
      return { ok: res.code === 0, body, reason: body.error?.message ?? firstLine(res.stderr || res.stdout) };
    } catch (err) {
      return { ok: false, body: {}, reason: err.message };
    }
  };
  if (!(await call(['server', 'status', '--json'], 10000)).ok) return { status: 'no-core', reason: 'herdr-core is not running' };
  const live = await call(['ls', '--json', '--label', label]);
  if (!live.ok) return { status: 'failed', reason: live.reason };
  if (live.body.terminals?.length) return { status: 'already', terminal: live.body.terminals[0].address ?? null };
  const start = (as) => call(['run', '--json', '--bg', '--no-parent', '--no-notify', '--name', as, '--label', label, '--cwd', homedir, '--', forward(node), forward(bin), 'launcher']);
  let res = await start(name);
  // The name is taken by a terminal that is not a launcher.
  if (!res.ok) res = await start(`${name}-launcher`);
  return res.ok ? { status: 'started', terminal: res.body.address ?? null } : { status: 'failed', reason: res.reason };
}

// deps: what main() takes. main: the command line itself, which starts each task.
// maxTasks: stop after that many tasks were handed over (tests).
// Returns the exit code.
export async function runLauncher({ deps, main, stdin = process.stdin, stdout = deps.stdout, maxTasks = Infinity, now = Date.now }) {
  const { env, paths } = deps;
  const tty = Boolean(stdout.isTTY);
  const ui = createUi({ env, stream: stdout });
  const columns = () => Math.max(24, stdout.columns || 80);
  const say = (text = '') => stdout.write(`${text}\n`);
  const fit = (text) => clip(text, columns() - 1);
  const osc = (seq) => { if (tty) stdout.write(seq); };
  const status = (state, msg = '', extra = {}) => osc(statusSeq({ state, msg: clip(msg, 120), ...extra }));
  const mark = `${ui.cyan(ui.bold('❯'))} `;
  const git = createGit({ run: deps.run });

  let config = { leader: 'claude' };
  try {
    config = loadConfig({ paths, readFile: deps.readFile });
  } catch {
    // the defaults do
  }
  const file = path.join(paths.home ?? path.dirname(paths.runs), 'launcher.json');
  const kept = loadRemembered({ file, readFile: deps.readFile });
  let settings = { ...initialSettings(config), leader: kept.leader ?? config.leader, auto: kept.auto, uncommitted: kept.uncommitted };
  let repo = null;
  let branch = null; // the branch checked out in repo
  let menu = null; // an open list of choices: { key, items }
  let pending = null; // a task that waits for a project
  let failed = false;
  let quit = false;
  let lastInterrupt = -Infinity;

  let leaders = null;
  // Asked when the leader is about to be chosen: asking every agent takes seconds.
  let asked = null;
  const loadLeaders = () => (asked ??= Promise.resolve().then(() => listLeaders(deps, config)).then((kinds) => { leaders = kinds; }, () => {}));

  async function projects() {
    let runs = [];
    try {
      runs = listRuns({ paths, readdir: deps.readdir, readFile: deps.readFile });
    } catch {
      // no run records: the folders of the terminals may still do
    }
    let cwds = [];
    try {
      const backend = createBackend(detectBackend({ env, installed: (name) => installed(name, deps) }), deps);
      cwds = (await backend.paneList()).map((p) => p.cwd);
    } catch {
      // nothing to ask for terminals
    }
    return projectChoices({ cwd: deps.cwd, runs, cwds, toplevel: (dir) => git.toplevel(dir), exists: deps.exists, homedir: deps.homedir, worktrees: paths.worktrees, platform: deps.platform });
  }

  async function setRepo(next) {
    repo = next;
    settings = { ...settings, base: null };
    branch = repo ? await git.currentBranch(repo).catch(() => null) : null;
  }

  const remember = () => saveRemembered({ file, writeFile: deps.writeFile }, { repo, leader: settings.leader, auto: settings.auto, uncommitted: settings.uncommitted });

  function draw() {
    say('');
    say(ui.bold(ui.cyan('foreman · new task')));
    for (const line of menuLines(settings, { project: repo ? path.basename(repo) : null, branch, columns: columns(), ui })) say(line);
    say(ui.dim(fit('Paste or type the task, then Enter.')));
    say(ui.dim(fit('A number changes a setting.')));
  }

  async function openMenu(key) {
    if (key === 'auto' || key === 'uncommitted') {
      settings = { ...settings, [key]: !settings[key] };
      remember();
      return draw();
    }
    let items = [];
    let names = null;
    if (key === 'project') {
      items = await projects();
      names = projectNames(items);
      if (!items.length) say(ui.yellow(fit('No project found yet.')));
      say(ui.dim(fit(items.length ? 'Project: a number, or a folder path.' : 'Type the path of a project folder.')));
    } else if (key === 'leader') {
      await loadLeaders();
      items = leaders ?? [config.leader];
      say(ui.dim(fit('Which agent leads: a number.')));
    } else {
      if (!repo) return say(ui.yellow(fit('Choose a project first: send 1.')));
      items = await git.localBranches(repo).catch(() => []);
      say(ui.dim(fit('Start from and land on: a number.')));
    }
    const current = key === 'project' ? (repo ? names[items.indexOf(repo)] ?? null : null) : key === 'leader' ? settings.leader : settings.base ?? branch;
    for (const line of choiceLines(names ?? items, { current, columns: columns() })) say(line);
    menu = { key, items };
    return undefined;
  }

  // An answer to the open list. False: it was not an answer, so it is ordinary input.
  async function choose(text) {
    const { key, items } = menu;
    let picked = pickChoice(text, items);
    if (picked === null && key === 'project' && !/\n/.test(text) && deps.exists(text)) {
      picked = await git.toplevel(text).catch(() => null);
      if (!picked) {
        say(ui.yellow(fit('That folder does not use git.')));
        return true;
      }
    }
    if (picked === null) {
      if (!/^\s*\d+\s*$/.test(text)) return false;
      say(ui.yellow(fit(items.length ? `Send a number from 1 to ${Math.min(items.length, 9)}.` : 'Nothing to choose from.')));
      return true;
    }
    menu = null;
    if (key === 'project') await setRepo(picked);
    else if (key === 'leader') settings = { ...settings, leader: picked };
    else settings = { ...settings, base: picked === branch ? null : picked };
    remember();
    if (key === 'project' && pending) {
      const task = pending;
      pending = null;
      await start(task);
    } else {
      draw();
    }
    return true;
  }

  let startedTasks = 0;
  async function start(task) {
    if (!repo) {
      pending = task;
      say(ui.yellow(fit('First choose the project for this task.')));
      return openMenu('project');
    }
    const title = clip(firstLine(task), 80);
    status('working', `Starting: ${title}`);
    let problem = '';
    const out = { isTTY: stdout.isTTY, columns: stdout.columns, write: (s) => stdout.write(s) };
    const err = { isTTY: stdout.isTTY, write: (s) => { problem += s; return stdout.write(s); } };
    let code;
    try {
      code = await main([...settingsArgs(settings, { config, branch }), '--', task], { ...deps, cwd: repo, stdout: out, stderr: err, progress: (m) => say(ui.dim(m)) });
    } catch (e) {
      code = 1;
      problem += e.message;
      say(e.message);
    }
    startedTasks++;
    if (code === 0) {
      // Working to idle ends a turn: the row shows as done until someone looks.
      status('idle', `Started: ${title}`);
      say(`${ui.green('✓')} ${fit('Started. The leader has its own row.')}`);
      settings = { ...settings, base: null };
    } else {
      failed = true;
      status('error', firstLine(problem) || 'The task did not start.');
      say(ui.yellow(fit('Not started: see above, then resend.')));
    }
    remember();
    return draw();
  }

  async function handle(raw) {
    const text = stripHcWrapper(raw);
    if (failed) {
      failed = false;
      status('idle');
    }
    if (menu) {
      if (await choose(text)) return;
      menu = null;
    }
    const key = menuKey(text);
    if (key) return openMenu(key);
    if (/^\s*\d+\s*$/.test(text)) return say(ui.yellow(fit('Send 1 to 5 to change a setting.')));
    if (isSettingCommand(text)) {
      if (/^\/leader\b/i.test(text)) await loadLeaders();
      const res = applySetting(text, settings, { leaders, branches: repo ? await git.localBranches(repo).catch(() => null) : null, branch });
      settings = res.settings;
      if (res.error) return say(ui.yellow(`! ${res.error}`));
      remember();
      return draw();
    }
    return start(text);
  }

  // Ctrl+C closes the launcher only when pressed twice: one press is easy on a key bar.
  const interrupt = () => {
    const t = now();
    if (t - lastInterrupt < 5000) {
      quit = true;
      return false;
    }
    lastInterrupt = t;
    stdout.write(`\n${ui.yellow(fit('Press Ctrl+C again to close this.'))}\n`);
    return true;
  };

  // One reader from the first task to the last, opened before anything slow:
  // the terminal is in one mode all the time, and a task sent while the
  // launcher is busy (looking for projects, starting a leader) waits its turn
  // instead of being lost.
  const read = () => createTaskReader(stdin, stdout, { prompt: mark, single: true, escape: true, interrupt, now });
  let reader = read();

  // A launcher started by hand is found by `foreman launcher --ensure` too.
  if (env.HC_TERMINAL_ID) {
    const hc = findTool('hc', deps) ?? 'hc';
    await Promise.resolve().then(() => deps.run(hc, ['label', '--json', env.HC_TERMINAL_ID, LAUNCHER_LABEL], { timeoutMs: 10000 })).catch(() => {});
  }
  const found = await projects();
  await setRepo(found[0] && deps.cwd && isInside(deps.cwd, found[0]) ? found[0] : kept.repo && deps.exists(kept.repo) ? kept.repo : found[0] ?? null);

  osc(titleSeq(LAUNCHER_TITLE));
  status('idle', '', { title: 'New task' });
  draw();
  while (!quit && startedTasks < maxTasks) {
    stdout.write(mark);
    const text = await reader.next();
    if (quit) break;
    if (!text) {
      if (!reader.ended) continue;
      // Ctrl+D or the end of the input: a terminal reads on, a closed input ends the launcher.
      if (!stdin.isTTY || stdin.readableEnded || stdin.destroyed) break;
      reader.close();
      reader = read();
      continue;
    }
    await handle(text);
  }
  reader.close();
  status('clear');
  say(ui.dim('The launcher is closed.'));
  return 0;
}
