// herdr plugin pane: ask for the task, then start a leader in a new tab of
// this workspace. An empty answer closes the prompt without doing anything.
import { createInterface } from 'node:readline/promises';
import { main } from '../src/cli.js';
import { realDeps } from '../src/deps.js';
import { repoFromContext } from '../src/plugin.js';

const { stdin, stdout } = process;
const cwd = repoFromContext(process.env) ?? process.cwd();

stdout.write(`\n  foreman\n  Repository: ${cwd}\n  Describe the task; an empty line cancels.\n\n`);
const rl = createInterface({ input: stdin, output: stdout });
let task = '';
try {
  task = (await rl.question('  Task: ')).trim();
} finally {
  rl.close();
}

if (task) {
  const code = await main(['--', task], { ...realDeps(), cwd });
  if (code) {
    // Keep a failure readable; the overlay closes when this process exits.
    const again = createInterface({ input: stdin, output: stdout });
    await again.question('\n  Press Enter to close. ');
    again.close();
  }
  process.exitCode = code;
}
