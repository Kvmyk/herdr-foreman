// herdr plugin pane: ask for the task, then start a leader in a new tab of
// this workspace. The prompt itself is src/ask.js, the one `foreman new` opens.
import { main } from '../src/cli.js';
import { realDeps } from '../src/deps.js';
import { repoFromContext } from '../src/plugin.js';
import { runAsk } from '../src/ask.js';

const deps = realDeps();
process.exitCode = await runAsk({ deps, main, cwd: repoFromContext(process.env) ?? process.cwd(), overlay: true });
