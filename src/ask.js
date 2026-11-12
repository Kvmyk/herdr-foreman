// The task prompt in a terminal: ask what should be done, then start a leader.
// It is what `foreman new` (and plain `foreman`) opens, and the herdr plugin
// pane (plugin/ask.js). An empty answer ends it without doing anything.
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { editTask, editorOpensWindow, readTaskLines } from './task.js';
import { waitForKey } from './pause.js';
import { createUi } from './ui.js';
import { createSteps, header, hints, marker, settingsLine, summary } from './ask-view.js';
import { loadConfig } from './config.js';
import { inventory, saveAgents } from './inventory/index.js';
import { applySetting, initialSettings, isSettingCommand, leaderKinds, settingsArgs } from './start-settings.js';

// The agents that can lead. The list is kept for the desktop prompt too;
// versions are not needed here.
export async function listLeaders(deps, config) {
  const agents = await inventory({
    run: deps.run, which: deps.which, env: deps.env, readJson: deps.readJson, exists: deps.exists, home: deps.homedir, exclude: config.excludeKinds, versions: false,
  });
  return leaderKinds(saveAgents({ writeFile: deps.writeFile, file: deps.paths.agentsCache }, agents), config.leader);
}

function gitLines(spawnSync, cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  return res.status === 0 ? res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : null;
}

export const currentBranch = (spawnSync, cwd) => gitLines(spawnSync, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])?.[0] ?? null;
export const localBranches = (spawnSync, cwd) => gitLines(spawnSync, cwd, ['branch', '--format=%(refname:short)'])?.filter((l) => !l.startsWith('(')) ?? null;

// deps: what main() takes. main: the command line itself, which starts the task.
// overlay: the prompt is a window that closes when this returns, so a failure
// stays on screen until a key is pressed.
// Returns the exit code.
export async function runAsk({ deps, main, cwd = deps.cwd, stdin = process.stdin, stdout = deps.stdout, stderr = deps.stderr, overlay = false, spawnSync = nodeSpawnSync }) {
  const { env } = deps;
  const ui = createUi({ env, stream: stdout });
  const columns = stdout.columns || 80;
  const branch = currentBranch(spawnSync, cwd);

  let config = { leader: 'claude' };
  try {
    config = loadConfig({ paths: deps.paths, readFile: deps.readFile });
  } catch {
    // the defaults do
  }
  let settings = initialSettings(config);

  // The agents that can lead; when they cannot be listed the value is passed
  // on and foreman checks it when the task starts.
  let leaders = null;
  const leadersLoaded = listLeaders(deps, config).then((kinds) => { leaders = kinds; }, () => {});

  const settingsText = () => settingsLine(ui, settings, { branch, columns });
  const mark = marker(ui);

  // One write per screen part, so nothing flickers.
  stdout.write(`${header(ui, { cwd, branch, columns })}\n${hints(ui, columns, { editor: !editorOpensWindow(env, deps.platform) })}\n${settingsText()}\n\n${mark}`);

  // A setting on a line of its own: change it, say what happened, show the settings again.
  async function command(line) {
    if (!isSettingCommand(line)) return false;
    if (/^\/leader\b/i.test(line.trim())) await leadersLoaded;
    const res = applySetting(line, settings, { leaders, branches: localBranches(spawnSync, cwd), branch });
    settings = res.settings;
    stdout.write(res.error ? `  ${ui.yellow(`! ${res.error}`)}\n` : `${settingsText()}\n`);
    return true;
  }

  const read = (opts) => readTaskLines(stdin, stdout, { prompt: mark, command, ...opts });
  let task = await read({ editKey: 'e' });
  if (task === 'e') {
    const text = editTask({
      env, platform: deps.platform, spawnSync, readFile: deps.readFile, writeFile: deps.writeFile, removeFile: deps.removeFile, tmpdir: deps.tmpdir,
      report: (m) => stdout.write(`\n  ${ui.yellow(m)}\n`),
    });
    if (text === null) {
      stdout.write(`\n  ${ui.yellow('I could not open an editor. Type your task here instead; finish with an empty line.')}\n\n${mark}`);
      task = await read();
    } else {
      task = text;
    }
  }
  if (!task) return 0;

  stdout.write(`${summary(ui, { task, cwd, exists: deps.exists, columns })}\n`);
  const steps = createSteps(ui, stdout);
  // Anything main prints ends the running step: its result is known by then.
  const out = { isTTY: stdout.isTTY, columns: stdout.columns, write: (s) => { steps.finish(true); return stdout.write(s); } };
  const err = { isTTY: stderr.isTTY, write: (s) => { steps.finish(false); return stderr.write(s); } };
  const code = await main([...settingsArgs(settings, { config, branch }), '--', task], { ...deps, cwd, progress: (m) => steps.step(m), stdout: out, stderr: err });
  steps.finish(!code);
  if (!code) {
    stdout.write(`\n  ${ui.green('✓')} ${ui.bold('Done.')} ${ui.dim('The leader works in the tab "foreman"; switch to it to follow along.')}\n`);
  } else if (overlay) {
    await waitForKey({ stdin, stdout, sleep: deps.sleep });
  }
  return code;
}
