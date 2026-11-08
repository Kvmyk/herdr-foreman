// herdr runs this at install ([[build]], --quiet), at every server start
// ([[startup]], --quiet) and as the "setup" pane (no flag): add the shortcut,
// pick a lead agent, and in the pane say in plain words what to do next.
import { createInterface } from 'node:readline/promises';
import { main } from '../src/cli.js';
import { realDeps } from '../src/deps.js';

const quiet = process.argv.includes('--quiet');
const code = await main(['setup', ...(quiet ? ['--quiet'] : [])], realDeps());

if (!quiet) {
  // The overlay closes when this process exits; let the user read first.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('\n  Press Enter to close. ');
  rl.close();
}
// A failing build command would abort the install.
process.exitCode = quiet ? 0 : code;
