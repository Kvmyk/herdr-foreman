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
import { createSteps, header, hints, marker, summary } from '../src/ask-view.js';

const { stdin, stdout, env } = process;
const cwd = repoFromContext(env) ?? process.cwd();
const ui = createUi({ env, stream: stdout });
const columns = stdout.columns || 80;

const git = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', windowsHide: true });
const branch = git.status === 0 ? git.stdout.trim() : null;

// One write per screen part, so nothing flickers.
stdout.write(`${header(ui, { cwd, branch, columns })}\n${hints(ui, columns)}\n${marker(ui)}`);

let task = await readTaskLines(stdin, null, { editKey: 'e', afterLine: () => stdout.write(marker(ui)) });
if (task === 'e') {
  const text = editTask({
    env, spawnSync, readFile: (f) => readFileSync(f, 'utf8'), writeFile: writeFileSync, removeFile: (f) => rmSync(f, { force: true }), tmpdir: os.tmpdir(),
    report: (m) => stdout.write(`\n  ${ui.yellow(m)}\n`),
  });
  if (text === null) {
    stdout.write(`\n  ${ui.yellow('I could not open an editor. Type your task here instead; finish with an empty line.')}\n\n${marker(ui)}`);
    task = await readTaskLines(stdin, null, { afterLine: () => stdout.write(marker(ui)) });
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
  const deps = { ...realDeps(), cwd, progress: (m) => steps.step(m), stdout: out, stderr: err };
  const code = await main(['--', task], deps);
  steps.finish(!code);
  if (code) {
    // Keep a failure readable; the overlay closes when this process exits.
    await waitForKey({ stdin, stdout, sleep: deps.sleep });
  } else {
    stdout.write(`\n  ${ui.green('✓')} ${ui.bold('Done.')} ${ui.dim('The leader works in the tab "foreman"; switch to it to follow along.')}\n`);
  }
  process.exitCode = code;
}
