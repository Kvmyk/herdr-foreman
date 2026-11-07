// herdr plugin action: open the task prompt (pane "ask") over the focused pane.
import { spawnSync } from 'node:child_process';
import { paneOpenArgs } from '../src/plugin.js';

const herdr = process.env.HERDR_BIN_PATH || 'herdr';
const r = spawnSync(herdr, paneOpenArgs(process.env), { encoding: 'utf8', windowsHide: true });
if (r.error) process.stderr.write(`${r.error.message}\n`);
process.stderr.write(r.stderr ?? '');
process.exitCode = r.status ?? 1;
