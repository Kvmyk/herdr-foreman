// `foreman watch --task <slug>`: the status table, refreshed until every worker
// is finished or you press Ctrl+C.
import { statusSeq } from './status.js';

// Done: no agent is working and every worker wrote its report (or is gone).
export const allSettled = (list) => list.length > 0 && list.every((s) => s.missing || s.state === 'gone' || ((s.report || s.proposals) && s.state !== 'working'));

// How many of the workers are through, for the status line of the Herdr clients.
const settledCount = (list) => list.filter((s) => allSettled([s])).length;

export async function runWatch({ status, render, stdout, sleep, intervalS = 5, tty = false, maxRounds = Infinity, env = process.env, task = null }) {
  // In a Herdr app terminal (HC_TERMINAL_ID) the watch reports what it sees
  // through OSC 7501, like the launcher: working while workers run, done when
  // all of them have finished, so the terminal shows up as done on every client.
  const report = (state, msg = '', progress = null) => {
    if (tty && env.HC_TERMINAL_ID) stdout.write(statusSeq({ state, msg, progress }));
  };
  const what = task ? `Watching ${task}` : 'Watching the workers';
  report('working', what);
  for (let round = 1; round <= maxRounds; round++) {
    const list = await status();
    if (tty) stdout.write('\x1b[2J\x1b[H');
    stdout.write(`${render(list)}\n`);
    if (allSettled(list)) {
      stdout.write('every worker has finished\n');
      report('done', task ? `Every worker of ${task} has finished` : 'Every worker has finished');
      return 0;
    }
    if (list.length) report('working', `${what}: ${settledCount(list)} of ${list.length} finished`, (100 * settledCount(list)) / list.length);
    stdout.write(`refreshing every ${intervalS}s; press Ctrl+C to stop\n`);
    await sleep(intervalS * 1000);
  }
  return 0;
}
