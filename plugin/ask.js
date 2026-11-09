// herdr plugin pane: ask for the task, then start a leader in a new tab of
// this workspace. An empty answer closes the prompt without doing anything.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { main } from '../src/cli.js';
import { realDeps } from '../src/deps.js';
import { repoFromContext } from '../src/plugin.js';
import { editTask, readTaskLines } from '../src/task.js';
import { waitForKey } from '../src/pause.js';
import { createUi } from '../src/ui.js';
import { createSteps, header, hints, marker, settingsLine, summary } from '../src/ask-view.js';
import { loadConfig } from '../src/config.js';
import { inventory } from '../src/inventory/index.js';
import { applySetting, initialSettings, isSettingCommand, leaderKinds, settingsArgs } from '../src/start-settings.js';

const { stdin, stdout, env } = process;
const cwd = repoFromContext(env) ?? process.cwd();
const ui = createUi({ env, stream: stdout });
const columns = stdout.columns || 80;

const git = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', windowsHide: true });
const branch = git.status === 0 ? git.stdout.trim() : null;

const base = realDeps();
let config = { leader: 'claude' };
try {
  config = loadConfig({ paths: base.paths, readFile: base.readFile });
} catch {
  // the defaults do
}
let settings = initialSettings(config);

// Local branches and the agents that can lead; either may be missing, then the
// value is passed on and foreman checks it when the task starts.
function listBranches() {
  const res = spawnSync('git', ['-C', cwd, 'branch', '--format=%(refname:short)'], { encoding: 'utf8', windowsHide: true });
  return res.status === 0 ? res.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('(')) : null;
}
let leaders = null;
const leadersLoaded = inventory({
  run: base.run, which: base.which, env, readJson: base.readJson, exists: base.exists, home: base.homedir, exclude: config.excludeKinds,
}).then((agents) => { leaders = leaderKinds(agents, config.leader); }, () => {});

const settingsText = () => settingsLine(ui, settings, { branch, columns });

// One write per screen part, so nothing flickers.
stdout.write(`${header(ui, { cwd, branch, columns })}\n${hints(ui, columns)}\n${settingsText()}\n\n${marker(ui)}`);

// A setting on a line of its own: change it, say what happened, show the settings again.
async function command(line) {
  if (!isSettingCommand(line)) return false;
  if (/^\/leader\b/i.test(line.trim())) await leadersLoaded;
  const res = applySetting(line, settings, { leaders, branches: listBranches(), branch });
  settings = res.settings;
  stdout.write(res.error ? `  ${ui.yellow(`! ${res.error}`)}\n` : `${settingsText()}\n`);
  stdout.write(marker(ui));
  return true;
}

let task = await readTaskLines(stdin, null, { editKey: 'e', afterLine: () => stdout.write(marker(ui)), command });
if (task === 'e') {
  const text = editTask({
    env, spawnSync, readFile: (f) => readFileSync(f, 'utf8'), writeFile: writeFileSync, removeFile: (f) => rmSync(f, { force: true }), tmpdir: os.tmpdir(),
    report: (m) => stdout.write(`\n  ${ui.yellow(m)}\n`),
  });
  if (text === null) {
    stdout.write(`\n  ${ui.yellow('I could not open an editor. Type your task here instead; finish with an empty line.')}\n\n${marker(ui)}`);
    task = await readTaskLines(stdin, null, { afterLine: () => stdout.write(marker(ui)), command });
  } else {
    task = text;
  }
}

if (task) {
  stdout.write(`${summary(ui, { task, cwd, exists: existsSync, columns })}\n`);
  const steps = createSteps(ui, stdout);
  // Anything main prints ends the running step: its result is known by then.
  const out = { isTTY: stdout.isTTY, write: (s) => { steps.finish(true); return stdout.write(s); } };
  const err = { isTTY: process.stderr.isTTY, write: (s) => { steps.finish(false); return process.stderr.write(s); } };
  const deps = { ...base, cwd, progress: (m) => steps.step(m), stdout: out, stderr: err };
  const code = await main([...settingsArgs(settings, { config, branch }), '--', task], deps);
  steps.finish(!code);
  if (code) {
    // Keep a failure readable; the overlay closes when this process exits.
    await waitForKey({ stdin, stdout, sleep: deps.sleep });
  } else {
    stdout.write(`\n  ${ui.green('✓')} ${ui.bold('Done.')} ${ui.dim('The leader works in the tab "foreman"; switch to it to follow along.')}\n`);
  }
  process.exitCode = code;
}
