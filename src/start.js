// `foreman "<task>"`: open a place for the leader in herdr, start it, hand it the task.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugify, uniqueSlug } from './runs.js';
import { PROBES } from './inventory/kinds.js';

export const INSTRUCTIONS_PATH = fileURLToPath(new URL('../leader/INSTRUCTIONS.md', import.meta.url));

export function buildLeaderPrompt({ task, slug, instructionsPath, foremanCmd = 'foreman' }) {
  const oneLine = task.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const cmd = foremanCmd === 'foreman' ? '' : ` Run foreman commands as: ${foremanCmd}.`;
  return `You are the foreman leader for task "${slug}". Read ${instructionsPath} and follow it exactly.${cmd} The user's task: ${oneLine}`;
}

const samePath = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

const failed = (message) => ({ ok: false, message });

async function waitForServer({ herdr, spawnDetached, sleep }) {
  if (await herdr.serverRunning()) return true;
  spawnDetached('herdr', ['server']);
  for (let waited = 0; waited < 10000; waited += 250) {
    await sleep(250);
    if (await herdr.serverRunning()) return true;
  }
  return false;
}

export async function startForeman({
  task, cwd, env, herdr, git, which, config, paths, homedir, exists, spawnDetached, attach, sleep,
  foremanCmd = 'foreman', instructionsPath = INSTRUCTIONS_PATH, report = () => {},
}) {
  if (!task?.trim()) return failed('Describe the task, e.g. foreman "fix the login bug"');

  const repo = await git.toplevel(cwd);
  if (!repo) return failed('foreman needs a git repository; run it inside one');
  if (samePath(repo, homedir)) {
    return failed(`refusing to use your home directory (${repo}) as the repository; run foreman inside a project repository`);
  }
  try {
    await git.head(repo);
  } catch {
    return failed(`the repository ${repo} has no commits yet; make a first commit so workers have something to branch from`);
  }
  if (!which(config.leader)) return failed(`leader agent "${config.leader}" is not installed (not found on PATH)`);

  const slug = uniqueSlug(slugify(task), (s) => exists(path.join(paths.runs, `${s}.json`)));
  const inside = env.HERDR_ENV === '1';

  let paneId;
  if (inside) {
    ({ paneId } = await herdr.tabCreate({ workspaceId: env.HERDR_WORKSPACE_ID, cwd: repo, label: 'foreman', focus: true }));
  } else {
    if (!(await waitForServer({ herdr, spawnDetached, sleep }))) return failed('herdr server did not start within 10 s; start herdr and try again');
    ({ paneId } = await herdr.workspaceCreate({ cwd: repo, label: 'foreman', focus: true }));
  }

  const live = new Set((await herdr.agentList()).map((a) => a.name).filter(Boolean));
  let leader = 'lead';
  for (let n = 2; live.has(leader); n++) leader = `lead${n}`;

  const prompt = buildLeaderPrompt({ task, slug, instructionsPath, foremanCmd });
  const lean = config.lean !== false ? PROBES[config.leader]?.leanArgs?.leader ?? [] : [];
  const args = [...lean, ...(config.leaderArgs ?? [])];
  const started = await herdr.agentStart({ name: leader, kind: config.leader, pane: paneId, timeoutMs: config.startTimeoutMs, args });
  let message;
  if (started.ok) {
    await herdr.agentPrompt(leader, prompt);
    message = `Leader "${leader}" (${config.leader}) started in pane ${paneId} for task "${slug}".`;
  } else {
    message = `Leader is waiting in pane ${paneId} (${started.code}: ${started.message}). Answer it there, then run: herdr agent prompt ${leader} "${prompt.replace(/"/g, '\\"')}"`;
  }

  report(message);
  if (!inside) attach();
  return { ok: true, slug, leader, paneId, message };
}
