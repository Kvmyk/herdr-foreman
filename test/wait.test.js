import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitForWorkers, screenTail } from '../src/wait.js';

const run = {
  task: 't',
  workers: [
    { name: 'w1', kind: 'claude', reportDir: path.resolve('/wt/w1/.foreman') },
    { name: 'w2', kind: 'agy', reportDir: path.resolve('/wt/w2/.foreman') },
  ],
};

// script: array of polls; each poll maps worker name -> state (or undefined = gone).
// screens: worker -> function(pollIndex) -> screen text.
function world({ script, reports = {}, screens = {} }) {
  let poll = 0;
  let clock = 0;
  const herdr = {
    agentList: async () => {
      const states = script[Math.min(poll, script.length - 1)];
      return Object.entries(states).filter(([, s]) => s).map(([name, s]) => ({ name, agent_status: s }));
    },
    agentRead: async (name) => (screens[name] ? screens[name](poll) : `${name} screen`),
  };
  const exists = (p) => {
    for (const [name, fromPoll] of Object.entries(reports)) {
      if (p.includes(path.join(name, '.foreman'))) return poll >= fromPoll;
    }
    return false;
  };
  const sleep = async (ms) => { clock += ms; poll++; };
  const now = () => clock;
  return { herdr, exists, sleep, now, polls: () => poll };
}

test('returns done when every worker is idle with its report', async () => {
  const w = world({ script: [{ w1: 'working', w2: 'working' }, { w1: 'idle', w2: 'working' }, { w1: 'idle', w2: 'done' }], reports: { w1: 1, w2: 2 } });
  const res = await waitForWorkers({ run, ...w, phase: 'investigate', pollMs: 3000 });
  assert.deepEqual(res, { result: 'done', elapsedS: 6, workers: { w1: 'done', w2: 'done' } });
});

test('a stable blocked screen needs attention and carries the screen tail', async () => {
  const w = world({ script: [{ w1: 'working', w2: 'blocked' }], screens: { w2: () => 'Allow running dir?\n❯ 1. Yes\n  2. No' } });
  const res = await waitForWorkers({ run, ...w, phase: 'investigate', pollMs: 3000, stableMs: 6000 });
  assert.equal(res.result, 'attention');
  assert.equal(res.workers.w1, 'working');
  assert.deepEqual(res.workers.w2, { state: 'blocked', screen: 'Allow running dir?\n❯ 1. Yes\n  2. No', hint: 'agy asks for permission; answer it with: foreman keys --task t w2 enter' });
  assert.equal(w.polls(), 2, 'waits until the screen was stable for stableMs');
});

test('blocked with a changing screen is treated as working', async () => {
  const w = world({
    script: [{ w1: 'blocked', w2: 'blocked' }, { w1: 'blocked', w2: 'blocked' }, { w1: 'blocked', w2: 'blocked' }, { w1: 'idle', w2: 'idle' }],
    screens: { w1: (i) => `reading file ${i}`, w2: (i) => `reading file ${i}` },
    reports: { w1: 3, w2: 3 },
  });
  const res = await waitForWorkers({ run, ...w, phase: 'investigate', pollMs: 3000, stableMs: 6000 });
  assert.equal(res.result, 'done');
});

test('idle without report after working needs attention', async () => {
  const w = world({ script: [{ w1: 'working', w2: 'working' }, { w1: 'idle', w2: 'working' }] });
  const res = await waitForWorkers({ run, ...w, phase: 'implement', pollMs: 3000 });
  assert.equal(res.result, 'attention');
  assert.equal(res.workers.w1.state, 'idle');
  assert.match(res.workers.w1.note, /report\.md/);
});

test('idle right after the brief counts as starting, not finished', async () => {
  const w = world({ script: [{ w1: 'idle', w2: 'idle' }, { w1: 'working', w2: 'working' }, { w1: 'idle', w2: 'idle' }], reports: { w1: 2, w2: 2 } });
  const res = await waitForWorkers({ run, ...w, phase: 'investigate', pollMs: 3000, quietMs: 30000 });
  assert.equal(res.result, 'done');
  assert.equal(w.polls(), 2);
});

test('a worker whose agent exited needs attention', async () => {
  const w = world({ script: [{ w1: 'working', w2: undefined }] });
  const res = await waitForWorkers({ run, ...w, pollMs: 3000 });
  assert.equal(res.result, 'attention');
  assert.deepEqual(res.workers.w2, { state: 'gone' });
});

test('times out while workers keep working', async () => {
  const w = world({ script: [{ w1: 'working', w2: 'working' }] });
  const res = await waitForWorkers({ run, ...w, pollMs: 3000, timeoutMs: 9000 });
  assert.deepEqual(res, { result: 'timeout', elapsedS: 9, workers: { w1: 'working', w2: 'working' } });
});

test('only waits for the named workers', async () => {
  const w = world({ script: [{ w1: 'working', w2: 'working' }, { w1: 'idle', w2: 'working' }], reports: { w1: 1 } });
  const res = await waitForWorkers({ run, ...w, phase: 'investigate', only: ['w1'], pollMs: 3000 });
  assert.deepEqual(res.workers, { w1: 'done' });
});

test('screenTail drops blank and rule lines and keeps the end', () => {
  const text = ['a', '', '────────────', 'b   ', ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n');
  const tail = screenTail(text, 5);
  assert.equal(tail, 'line 25\nline 26\nline 27\nline 28\nline 29');
  assert.equal(screenTail('x\n\n─────\ny', 15), 'x\ny');
});

test('an agent that reports an error needs attention, with its screen', async () => {
  const w = world({ script: [{ w1: 'working', w2: 'error' }] });
  const res = await waitForWorkers({ run, ...w, phase: 'investigate' });
  assert.equal(res.result, 'attention');
  assert.deepEqual(res.workers.w2, { state: 'error', screen: 'w2 screen' });
});
