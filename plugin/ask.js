// herdr plugin pane: ask for the task, then start a leader in a new tab of
// this workspace. An empty answer closes the prompt without doing anything.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { main } from '../src/cli.js';
import { realDeps } from '../src/deps.js';
import { repoFromContext } from '../src/plugin.js';
import { HINT, editTask, readTaskLines } from '../src/task.js';

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
  });
  if (text === null) {
    stdout.write('\n  I could not open an editor. Type your task here instead; finish with an empty line.\n\n  > ');
    task = await readTaskLines(stdin);
  } else {
    task = text;
  }
}

if (task) {
  const code = await main(['--', task], { ...realDeps(), cwd });
  if (code) {
    // Keep a failure readable; the overlay closes when this process exits.
    if (stdin.readableEnded) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    } else {
      const again = createInterface({ input: stdin, output: stdout });
      await again.question('\n  Press Enter to close. ');
      again.close();
    }
  }
  process.exitCode = code;
}
