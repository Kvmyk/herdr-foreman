// `foreman watch --task <slug>`: the status table, refreshed until every worker
// is finished or you press Ctrl+C.

// Done: no agent is working and every worker wrote its report (or is gone).
export const allSettled = (list) => list.length > 0 && list.every((s) => s.missing || s.state === 'gone' || ((s.report || s.proposals) && s.state !== 'working'));

export async function runWatch({ status, render, stdout, sleep, intervalS = 5, tty = false, maxRounds = Infinity }) {
  for (let round = 1; round <= maxRounds; round++) {
    const list = await status();
    if (tty) stdout.write('\x1b[2J\x1b[H');
    stdout.write(`${render(list)}\n`);
    if (allSettled(list)) {
      stdout.write('every worker has finished\n');
      return 0;
    }
    stdout.write(`refreshing every ${intervalS}s; press Ctrl+C to stop\n`);
    await sleep(intervalS * 1000);
  }
  return 0;
}
