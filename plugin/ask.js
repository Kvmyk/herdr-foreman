// herdr plugin pane: ask for the task, then start a leader in a new tab of
// this workspace. An empty answer closes the prompt without doing anything.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { main } from '../src/cli.js';
import { realDeps } from '../src/deps.js';
import { repoFromContext } from '../src/plugin.js';
import { HINT, editTask, readTaskLines } from '../src/task.js';
import { waitForKey } from '../src/pause.js';

const { stdin, stdout, env } = process;
const cwd = repoFromContext(env) ?? process.cwd();

stdout.write(`\n  foreman\n  Project: ${cwd}\n\n`);
stdout.write(`${HINT.replace(/^/gm, '  ')}\n\n`);
stdout.write('  Paste or type your task. Finish with an empty line (or Ctrl+D).\n');
stdout.write('  Type e and press Enter to write it in an editor instead. An empty line right away cancels.\n\n  > ');

let task = await readTaskLines(stdin, null, { editKey: 'e' });
if (task === 'e') {
  const text = editTask({
    env, spawnSync, readFile: (f) => readFileSync(f, 'utf8'), writeFile: writeFileSync, removeFile: (f) => rmSync(f, { force: true }), tmpdir: os.tmpdir(),
    report: (m) => stdout.write(`\n  ${m}\n`),
  });
  if (text === null) {
    stdout.write('\n  I could not open an editor. Type your task here instead; finish with an empty line.\n\n  > ');
    task = await readTaskLines(stdin);
  } else {
    task = text;
  }
}

if (task) {
  stdout.write('\n');
  const deps = { ...realDeps(), cwd, progress: true };
  const code = await main(['--', task], deps);
  if (code) {
    // Keep a failure readable; the overlay closes when this process exits.
    await waitForKey({ stdin, stdout, sleep: deps.sleep });
  } else {
    stdout.write('\n  Done. The leader works in the tab "foreman"; switch to it to follow along.\n');
  }
  process.exitCode = code;
}
