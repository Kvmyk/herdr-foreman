// `foreman "<task>"`: open a place for the leader in herdr or the Herdr app,
// start it, hand it the task.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugify, uniqueSlug } from './runs.js';
import { HERDR_KINDS, PROBES } from './inventory/kinds.js';
import { EXAMPLE, resolveMentions } from './task.js';
import { classifyScreen, describeBlocked } from './blocked.js';
import { screenTail } from './wait.js';
import { isInside, taskFile as taskPath } from './history.js';
import { pathKey } from './pathkey.js';
import { prefsText } from './start-prefs.js';
import { layoutHint } from './layout.js';

export const INSTRUCTIONS_PATH = fileURLToPath(new URL('../leader/INSTRUCTIONS.md', import.meta.url));

// The prompt is one line, because a newline would send it early. A task with
// several lines goes in taskFile and the prompt points at it.
export function buildLeaderPrompt({ task, slug, instructionsPath, foremanCmd = 'foreman', files = [], taskFile = null, prefs = {} }) {
  const cmd = foremanCmd === 'foreman' ? '' : ` Run foreman commands as: ${foremanCmd}.`;
  const oneLine = task.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const body = taskFile ? ` is written in ${taskFile}; read it first.` : `: ${oneLine}`;
  const pointed = files.length
    ? ` Files the user pointed to (read them first): ${files.map((f) => (f.dirty ? `${f.path} (has uncommitted changes)` : f.path)).join(', ')}.`
    : '';
  return `You are the foreman leader for task "${slug}". Read ${instructionsPath} and follow it exactly.${cmd} The user's task${body}${pointed}${prefsText(prefs)}`;
}

const samePath = (a, b) => pathKey(a) === pathKey(b);

const failed = (message) => ({ ok: false, message });

// The leader's name in the Herdr app: "<slug>-lead", at most 32 characters
// (hc's limit for a name); n numbers another leader of the same task.
export function leaderName(slug, n = '') {
  const tail = `-lead${n}`;
  return `${slug.slice(0, 32 - tail.length).replace(/-+$/, '')}${tail}`;
}

// One argument the user can paste into their shell. On Windows that is
// PowerShell: single quotes keep $ and backticks literal, ' is doubled.
// Windows PowerShell 5.1 drops double quotes inside native arguments, so they
// become single quotes there.
export function shellQuote(text, platform = process.platform) {
  if (platform === 'win32') return `'${text.replace(/"/g, "'").replace(/'/g, "''")}'`;
  return `"${text.replace(/"/g, '\\"')}"`;
}

async function waitForServer({ herdr, spawnDetached, sleep }) {
  if (await herdr.serverRunning()) return true;
  spawnDetached('herdr', ['server']);
  for (let waited = 0; waited < 10000; waited += 250) {
    await sleep(250);
    if (await herdr.serverRunning()) return true;
  }
  return false;
}

// The Herdr app space whose terminals already work in this repository, so a
// leader started from somewhere without a space (the launcher, a plain
// terminal) joins the project instead of opening a new space each time.
export async function spaceOfRepo({ herdr, repo }) {
  if (!herdr.paneList || !herdr.here) return null;
  const panes = await Promise.resolve().then(() => herdr.paneList()).catch(() => []);
  for (const pane of panes.filter((p) => p.cwd && isInside(p.cwd, repo)).slice(0, 12)) {
    const at = await Promise.resolve().then(() => herdr.here(pane.pane_id)).catch(() => null);
    if (at?.space) return at.space;
  }
  return null;
}

// A leader that stopped on "trust this folder?" is the user's to answer.
// Waits for the answer and for the agent to be ready after it.
// ready: hand it the task; gone: it was closed; timeout: still asking.
export async function waitForTrust({ herdr, name, kind, sleep, waitMs, stepMs = 2000 }) {
  let quiet = 0;
  for (let waited = 0; waited < waitMs; waited += stepMs) {
    await sleep(stepMs);
    const screen = await Promise.resolve().then(() => herdr.agentRead(name)).catch(() => null);
    if (screen === null || classifyScreen(kind, screenTail(screen))) {
      quiet = 0;
      continue;
    }
    const agents = await Promise.resolve().then(() => herdr.agentList()).catch(() => null);
    const agent = agents?.find((a) => a.name === name);
    if (agents && !agent) return 'gone';
    const state = agent?.agent_status;
    if (state === 'idle' || state === 'done') return 'ready';
    // An agent that reports no status is ready once its screen has been free of the question for a while.
    if (state !== 'working' && state !== 'blocked' && ++quiet >= 2) return 'ready';
  }
  return 'timeout';
}

export async function startForeman({
  task, cwd, env, herdr, git, which, config, paths, homedir, exists, spawnDetached, attach, sleep, writeFile, mkdir,
  foremanCmd = 'foreman', instructionsPath = INSTRUCTIONS_PATH, report = () => {}, progress = () => {}, platform = process.platform, prefs = {},
  slug: fixedSlug = null, prompt: fixedPrompt = null, trustWaitMs = 180000,
}) {
  if (!task?.trim()) return failed(`Tell me what you want done, for example:
  foreman "${EXAMPLE}"`);

  progress('Checking the project...');
  const repo = await git.toplevel(cwd);
  if (!repo) return failed('foreman works inside a project folder that uses git, and this folder is not one. Open your project folder and try again.');
  if (samePath(repo, homedir)) {
    return failed(`This looks like your home folder (${repo}), not a project. Open the folder of the project you want to work on and try again.`);
  }
  try {
    await git.head(repo);
  } catch {
    return failed(`The project in ${repo} has no saved version yet. Save a first commit (git add -A, then git commit -m "first version"), then run foreman again.`);
  }
  // --leader and --base apply to this task only.
  if (prefs.leader && prefs.leader !== config.leader) {
    if (!HERDR_KINDS.includes(prefs.leader)) return failed(`"${prefs.leader}" is not an agent foreman can start. Choose one of: ${HERDR_KINDS.join(', ')}.`);
    config = { ...config, leader: prefs.leader };
  }
  if (prefs.base && !(await git.branchExists(repo, prefs.base))) return failed(`The branch "${prefs.base}" does not exist in ${repo}. Check the name (git branch lists them) and try again.`);
  if (!which(config.leader)) return failed(`${config.leader} is not installed on this computer, so foreman cannot start. Install it and sign in, then try again.`);

  // A resumed run brings its own slug and prompt; its files were checked when it started.
  const { files, missing } = fixedPrompt ? { files: [], missing: [] } : await resolveMentions({ task, cwd, repo, exists, git });
  if (missing.length) {
    return failed(`I could not find ${missing.length > 1 ? 'these files' : 'this file'}: ${missing.join(', ')}. Check the name (it is relative to ${cwd}), or remove the @ if it is not a file.`);
  }

  const slug = fixedSlug ?? uniqueSlug(slugify(task), (s) => exists(path.join(paths.runs, `${s}.json`)) || exists(taskPath(paths, s)));
  // In the Herdr app the leader gets a new tab next to the caller's, or a new
  // space when foreman was started outside the app (for example by a mod).
  const app = herdr.kind === 'app';
  const inside = app ? Boolean(env.HC_TERMINAL_ID) : env.HERDR_ENV === '1';

  progress('Opening a tab for the leader...');
  let place;
  // In the app, a caller without a space of its own joins the space of the repository.
  const appSpace = app ? (inside ? (await herdr.here(env.HC_TERMINAL_ID))?.space : null) ?? await spaceOfRepo({ herdr, repo }) : null;
  if (inside || appSpace) {
    const workspaceId = app ? appSpace : env.HERDR_WORKSPACE_ID;
    place = { workspaceId, ...(await herdr.tabCreate({ workspaceId, cwd: repo, label: 'foreman', focus: true })) };
  } else {
    if (!app && !(await waitForServer({ herdr, spawnDetached, sleep }))) return failed('herdr did not start in time. Open herdr once, then try again.');
    place = await herdr.workspaceCreate({ cwd: repo, label: 'foreman', focus: true });
  }

  const live = new Set((await herdr.agentList()).map((a) => a.name).filter(Boolean));
  // In the Herdr app the name carries the task, so a list of every machine's
  // agents shows which run a leader belongs to; herdr keeps the short name.
  let leader = app ? leaderName(slug) : 'lead';
  for (let n = 2; live.has(leader); n++) leader = app ? leaderName(slug, n) : `lead${n}`;

  // Every task is kept for `foreman show` and `foreman resume`; the prompt
  // points at the file only when the task has several lines.
  let taskFile = null;
  const multiline = /[\r\n]/.test(task.trim());
  if (writeFile && !fixedPrompt) {
    const file = taskPath(paths, slug);
    try {
      mkdir?.(path.dirname(file), { recursive: true });
      writeFile(file, `${task.trim()}\n`);
      if (multiline) taskFile = file;
    } catch (err) {
      if (multiline) throw err;
    }
  }
  const prompt = fixedPrompt ?? buildLeaderPrompt({ task, slug, instructionsPath, foremanCmd, files, taskFile, prefs });
  const lean = config.lean !== false ? PROBES[config.leader]?.leanArgs?.leader ?? [] : [];
  const args = [...lean, ...(config.leaderArgs ?? [])];
  progress(`Starting ${config.leader}, the lead agent (up to ${Math.round((config.startTimeoutMs ?? 0) / 1000)}s)...`);
  // How wide the terminal the task was typed in is: spawn reads the hint from
  // the leader's labels and gives workers tabs of their own on a narrow screen.
  const hint = layoutHint(app && inside ? (await herdr.terminalInfo?.(env.HC_TERMINAL_ID))?.cols : null);
  const started = await herdr.agentStart({
    name: leader, kind: config.leader, pane: place.paneId, cwd: repo, space: place.workspaceId, tab: place.tabId,
    label: app ? `foreman · ${slug}` : 'foreman', focus: true, timeoutMs: config.startTimeoutMs, args,
    labels: { 'foreman.task': slug, 'foreman.role': 'leader', ...(hint ? { 'foreman.layout': hint } : {}) },
    where: `${path.basename(repo)} / ${slug}`,
  });
  const paneId = started.pane ?? place.paneId;
  if (!paneId) return failed(`The leader could not start: ${started.message}`);
  let message;
  let ready = started.ok;
  const readScreen = async () => screenTail(await Promise.resolve().then(() => herdr.agentRead(leader)).catch(() => ''));
  // The leader runs in the user's own project, so a trust question is theirs
  // to answer. foreman waits for that answer and then hands over the task; the
  // command to do it by hand is shown only when the wait runs out.
  if (!ready && started.code !== 'agent_exited' && trustWaitMs > 0 && classifyScreen(config.leader, await readScreen())?.type === 'trust') {
    progress(`${config.leader} asks whether to trust this folder. Answer it in the leader's tab; foreman waits up to ${Math.round(trustWaitMs / 60000) || 1} min and then gives it the task...`);
    const answer = await waitForTrust({ herdr, name: leader, kind: config.leader, sleep, waitMs: trustWaitMs });
    if (answer === 'gone') return failed(`The leader was closed before it got the task (was the answer to "trust this folder?" no?). Run foreman again when you want to start it.`);
    ready = answer === 'ready';
  }
  if (ready) {
    await herdr.agentPrompt(leader, prompt);
    message = `Leader "${leader}" (${config.leader}) started in pane ${paneId} for task "${slug}".`;
  } else {
    const backendFlag = app && !inside ? ' --backend app' : '';
    const screen = await readScreen();
    const asks = describeBlocked({ kind: config.leader, screen, task: slug, name: leader, foremanCmd });
    const answer = asks ? ` The leader ${asks}. Then run:` : ' Answer it there, then run:';
    message = `The leader is waiting for an answer in pane ${paneId} (${started.message}).${answer} ${foremanCmd} prompt --task ${slug}${backendFlag} ${leader} ${shellQuote(prompt, platform)}`;
  }

  report(message);
  const dirty = files.filter((f) => f.dirty).map((f) => f.path);
  if (dirty.length) report(`Note: ${dirty.join(', ')} ${dirty.length > 1 ? 'have' : 'has'} changes you have not committed. Workers start from your last commit, so they will not see those changes.`);
  // The Herdr app is a window, not a terminal to attach to: open it if it is closed.
  if (!inside && !app) attach();
  if (!inside && app && !(await herdr.appRunning())) spawnDetached(herdr.appBin, []);
  return { ok: true, slug, leader, paneId, message, tab: 'foreman' };
}
