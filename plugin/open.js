// herdr plugin action: open the task prompt (pane "ask") over the focused pane.
import { spawnSync } from 'node:child_process';
import { paneOpenArgs } from '../src/plugin.js';
import { main } from '../src/cli.js';
import { realDeps } from '../src/deps.js';

const herdr = process.env.HERDR_BIN_PATH || 'herdr';
const r = spawnSync(herdr, paneOpenArgs(process.env), { encoding: 'utf8', windowsHide: true });
if (r.error) process.stderr.write(`${r.error.message}\n`);
process.stderr.write(r.stderr ?? '');
process.exitCode = r.status ?? 1;

if (process.exitCode) {
  // Action output only reaches herdr's plugin log; tell the user on screen.
  const reason = (r.error?.message || r.stderr || r.stdout || '').trim().split(/\r?\n/)[0] || 'herdr did not open the task prompt';
  spawnSync(herdr, ['notification', 'show', 'foreman could not start', '--body', reason], { windowsHide: true });
} else {
  // Started some other way than the shortcut (e.g. "herdr plugin action
  // invoke") with no key bound: add the shortcut for next time.
  await main(['setup', '--quiet'], { ...realDeps(), stdout: { write() {} } });
}
