import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { waitForWorkers, screenTail, notify } from '../src/wait.js';

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

test('a report older than the last brief does not make the worker done', async () => {
  const w = world({ script: [{ w1: 'idle' }, { w1: 'working' }, { w1: 'idle' }], reports: { w1: 0 } });
  const briefed = { ...run, briefedAt: { w1: 5000 } };
  // The old report (mtime 1000) predates the brief; a new one is written from poll 2.
  const mtimeMs = () => (w.polls() >= 2 ? 9000 : 1000);
  const res = await waitForWorkers({ run: briefed, only: ['w1'], ...w, mtimeMs, phase: 'investigate', pollMs: 3000 });
  assert.equal(res.workers.w1, 'done');
  assert.ok(w.polls() >= 2);
});

test('without a recorded brief time a report counts as before', async () => {
  const w = world({ script: [{ w1: 'idle' }], reports: { w1: 0 } });
  const res = await waitForWorkers({ run, only: ['w1'], ...w, mtimeMs: () => 1, phase: 'investigate' });
  assert.equal(res.workers.w1, 'done');
});

const notifyArgs = (cmd, script, extra = {}) => {
  const calls = [];
  const spawnImpl = (c, a, o) => { calls.push({ c, a, o }); return { on() {}, unref() {} }; };
  const w = world({ script, reports: { w1: 1, w2: 1 }, ...extra });
  return { calls, go: () => waitForWorkers({ run, ...w, phase: 'investigate', pollMs: 3000, stableMs: 6000, notifyCommand: cmd, spawnImpl }) };
};

test('notifyCommand runs without a shell with {title} and {body} filled in when wait is done', async () => {
  const n = notifyArgs(['ntfy', 'pub', '-t', '{title}', 'x:{body}'], [{ w1: 'idle', w2: 'idle' }]);
  const res = await n.go();
  assert.equal(res.result, 'done');
  assert.equal(n.calls.length, 1);
  assert.equal(n.calls[0].c, 'ntfy');
  assert.deepEqual(n.calls[0].a, ['pub', '-t', 'foreman: t', 'x:done']);
  assert.equal(n.calls[0].o.shell, false);
});

test('notifyCommand also runs on attention and names the worker', async () => {
  const n = notifyArgs(['n', '{body}'], [{ w1: 'idle', w2: undefined }]);
  const res = await n.go();
  assert.equal(res.result, 'attention');
  assert.deepEqual(n.calls[0].a, ['attention: w2 gone']);
});

test('no notifyCommand, or a timeout, runs nothing', async () => {
  const off = notifyArgs(null, [{ w1: 'idle', w2: 'idle' }]);
  await off.go();
  assert.equal(off.calls.length, 0);
  const timed = notifyArgs(['n'], [{ w1: 'working', w2: 'working' }]);
  assert.equal((await timed.go()).result, 'timeout');
  assert.equal(timed.calls.length, 0);
});

test('a notifyCommand that fails to start never breaks or blocks wait', async () => {
  const w = world({ script: [{ w1: 'idle', w2: 'idle' }], reports: { w1: 0, w2: 0 } });
  const boom = () => { throw new Error('ENOENT'); };
  const res = await waitForWorkers({ run, ...w, phase: 'investigate', pollMs: 3000, notifyCommand: ['nope'], spawnImpl: boom });
  assert.equal(res.result, 'done');
  assert.equal(notify(['nope'], 't', res, boom), false);
  assert.equal(notify(['nope'], 't', { result: 'timeout', workers: {} }, boom), false);
});

// Greedy word wrap, like a pane of that many columns.
const wrapCols = (text, cols) => text.split('\n').flatMap((p) => {
  const out = []; let line = '';
  for (const word of p.split(' ')) {
    if (line && line.length + 1 + word.length > cols) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  out.push(line); return out;
}).join('\n');

test('wrapped dialogs keep their question and are classified at 24, 44 and 200 columns', async () => {
  const body = 'Quick safety check: is this a project you created or one you trust? Do you trust the files in this folder?';
  for (const cols of [24, 44, 200]) {
    const screen = `${wrapCols(body, cols)}\n\n > Yes, I trust this folder\n   No, exit`;
    const w = world({ script: [{ w1: 'blocked', w2: 'working' }], screens: { w1: () => screen } });
    const res = await waitForWorkers({ run, ...w, phase: 'investigate', pollMs: 3000, stableMs: 6000 });
    assert.match(res.workers.w1.hint, /asks to trust this folder; answer it with: foreman keys --task t w1 enter/, `${cols} columns`);
    assert.match(res.workers.w1.screen, /Quick/);
  }
});

// ---- a worker that needs the person is pinned for every Herdr client ----

const pinRun = {
  task: 't',
  workers: [
    { name: 'w1', kind: 'claude', paneId: 't7', reportDir: path.resolve('/wt/w1/.foreman') },
    { name: 'w2', kind: 'agy', reportDir: path.resolve('/wt/w2/.foreman') },
  ],
};

test('wait pins a worker that is blocked, hit an error or stopped without its report; not one that works or is gone', async () => {
  const go = async (script, extra = {}) => {
    const w = world({ script, ...extra });
    const pinned = [];
    w.herdr.needsPerson = async (terminal) => { pinned.push(terminal); return true; };
    const res = await waitForWorkers({ run: pinRun, ...w, phase: 'investigate', pollMs: 3000, stableMs: 6000 });
    return { res, pinned };
  };
  // Blocked on the same screen for stableMs: pinned by its terminal, once.
  const blocked = await go([{ w1: 'blocked', w2: 'working' }], { screens: { w1: () => 'Allow this command? (y/n)' } });
  assert.equal(blocked.res.workers.w1.state, 'blocked');
  assert.deepEqual(blocked.pinned, ['t7']);
  // An error and "finished without its report" need the person too; a worker without a terminal id goes by name.
  const stopped = await go([{ w1: 'error', w2: 'working' }, { w1: 'error', w2: 'idle' }]);
  assert.equal(stopped.res.result, 'attention');
  assert.deepEqual(stopped.pinned, ['t7']);
  const idle = await go([{ w1: 'working', w2: 'working' }, { w1: 'working', w2: 'idle' }]);
  assert.equal(idle.res.workers.w2.state, 'idle');
  assert.deepEqual(idle.pinned, ['w2']);
  // Gone: nothing left to pin. Done: nobody is needed.
  assert.deepEqual((await go([{ w2: 'working' }])).pinned, []);
  assert.deepEqual((await go([{ w1: 'idle', w2: 'idle' }], { reports: { w1: 0, w2: 0 } })).pinned, []);
});

test('wait in herdr (no pins there) and a pin that fails change nothing about the result', async () => {
  const script = [{ w1: 'error', w2: 'working' }];
  const plain = await waitForWorkers({ run: pinRun, ...world({ script }), phase: 'investigate', pollMs: 3000 });
  const w = world({ script });
  w.herdr.needsPerson = async () => { throw new Error('hc is gone'); };
  const failing = await waitForWorkers({ run: pinRun, ...w, phase: 'investigate', pollMs: 3000 });
  assert.equal(plain.result, 'attention');
  assert.deepEqual(failing, plain);
});
