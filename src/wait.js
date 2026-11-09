// `foreman wait`: one blocking call that returns when the leader has
// something to do: every worker finished, or one needs attention. It replaces
// polling from the leader, where every check is a full model turn.
import path from 'node:path';
import { describeBlocked } from './blocked.js';

const REPORT = { investigate: 'proposals.md', implement: 'report.md' };
const RULE_ONLY = /^[\s─-╿]+$/;

// The end of a pane, without blank lines and box-drawing rules.
export function screenTail(text, lines = 15, maxChars = 1500) {
  const kept = String(text)
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l && !RULE_ONLY.test(l))
    .slice(-lines)
    .join('\n');
  return kept.length > maxChars ? kept.slice(-maxChars) : kept;
}

const hintObj = (hint) => (hint ? { hint } : {});

export async function waitForWorkers({
  run, herdr, foremanCmd = 'foreman', exists, mtimeMs = null, sleep, now, phase = null, only = null,
  timeoutMs = 540000, pollMs = 3000, stableMs = 6000, quietMs = 30000,
}) {
  const report = REPORT[phase] ?? null;
  const workers = run.workers.filter((w) => !only || only.includes(w.name));
  const memo = Object.fromEntries(workers.map((w) => [w.name, { seenWorking: false, idleSince: null, blockedSince: null, screen: null }]));
  const start = now();
  // What a blocked screen asks, with the exact command that answers it.
  const hintFor = (w, screen) => describeBlocked({ kind: w.kind ?? 'agent', screen, task: run.task, name: w.name, foremanCmd });
  // A report left from an earlier round does not count: it must be newer than the last brief.
  const fresh = (w, file) => {
    if (!exists(file)) return false;
    const briefed = run.briefedAt?.[w.name];
    const modified = briefed && mtimeMs ? mtimeMs(file) : null;
    return modified == null || modified >= briefed;
  };
  const read = async (name) => screenTail(await herdr.agentRead(name).catch(() => ''));

  for (;;) {
    const agents = await herdr.agentList();
    const out = {};
    let attention = false;
    let allDone = true;

    for (const w of workers) {
      const m = memo[w.name];
      const agent = agents.find((a) => a.name === w.name);
      if (!agent) {
        out[w.name] = { state: 'gone' };
        attention = true;
        continue;
      }
      const state = agent.agent_status;

      if (state === 'working') {
        Object.assign(m, { seenWorking: true, idleSince: null, blockedSince: null, screen: null });
        out[w.name] = 'working';
        allDone = false;
        continue;
      }

      if (state === 'blocked') {
        allDone = false;
        // herdr can report an agent as blocked while it works (seen with agy):
        // only a screen that stays the same for stableMs counts as a question.
        const screen = await read(w.name);
        if (screen !== m.screen) {
          Object.assign(m, { screen, blockedSince: now() });
          out[w.name] = 'working';
        } else if (now() - m.blockedSince >= stableMs) {
          out[w.name] = { state: 'blocked', screen, ...hintObj(hintFor(w, screen)) };
          attention = true;
        } else {
          out[w.name] = 'working';
        }
        continue;
      }

      // The Herdr app reports an agent that hit an error (an API failure, for example).
      if (state === 'error') {
        const screen = await read(w.name);
        out[w.name] = { state: 'error', screen, ...hintObj(hintFor(w, screen)) };
        attention = true;
        allDone = false;
        continue;
      }

      // idle, done or unknown: the agent is not doing anything right now.
      Object.assign(m, { blockedSince: null, screen: null });
      m.idleSince ??= now();
      const hasReport = report ? fresh(w, path.join(w.reportDir, report)) : false;
      const settled = m.seenWorking || now() - m.idleSince >= quietMs;
      if (hasReport || (!report && settled)) {
        out[w.name] = 'done';
      } else if (settled) {
        out[w.name] = { state: 'idle', note: `finished without ${report}`, screen: await read(w.name) };
        attention = true;
        allDone = false;
      } else {
        out[w.name] = 'starting';
        allDone = false;
      }
    }

    const elapsedS = Math.round((now() - start) / 1000);
    if (attention) return { result: 'attention', elapsedS, workers: out };
    if (allDone) return { result: 'done', elapsedS, workers: out };
    if (now() - start >= timeoutMs) return { result: 'timeout', elapsedS, workers: out };
    await sleep(pollMs);
  }
}
