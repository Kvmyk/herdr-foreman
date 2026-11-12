import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  ensureLauncher, projectChoices, projectNames, runLauncher, statusSeq, stopLauncher, stripHcLine, stripHcWrapper, titleSeq, LAUNCHER_LABEL,
} from '../src/launcher.js';
import { fakeRun } from './helpers.js';

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const decode = (seq, field) => Buffer.from(new RegExp(`${field}=([A-Za-z0-9+/=]+)`).exec(seq)[1], 'base64').toString('utf8');

test('statusSeq is an OSC 7501 report: state, app, and text as base64', () => {
  assert.equal(statusSeq({ state: 'idle' }), '\x1b]7501;state=idle:app=foreman\x1b\\');
  const working = statusSeq({ state: 'working', msg: 'Starting: fix the login · żółw', progress: 40 });
  assert.match(working, /^\x1b\]7501;state=working:progress=40:app=foreman:msg=[A-Za-z0-9+/=]+\x1b\\$/);
  assert.equal(decode(working, 'msg'), 'Starting: fix the login · żółw');
  assert.equal(decode(statusSeq({ state: 'idle', title: 'New task' }), 'title'), 'New task');
});

test('titleSeq sets the terminal title and keeps control characters out', () => {
  assert.equal(titleSeq('foreman: new task'), '\x1b]2;foreman: new task\x07');
  assert.equal(titleSeq('a\x07b\nc'), '\x1b]2;a b c\x07');
});

test('stripHcWrapper takes a message out of the tag hc puts around it', () => {
  assert.equal(stripHcWrapper('<hc from="t4c lead">fix the login\n\nand the tests</hc>'), 'fix the login\n\nand the tests');
  assert.equal(stripHcWrapper('  fix <b>this</b>  '), 'fix <b>this</b>');
  assert.equal(stripHcWrapper('<hc from="t1">2</hc>'), '2');
});

const home = path.resolve('/h');
const wt = path.resolve('/h/.herdr-foreman/worktrees');
const A = path.resolve('/code/shop');
const B = path.resolve('/code/blog');
const C = path.resolve('/code/api');

test('projectChoices: this folder first, then the latest runs, then the folders of live terminals', async () => {
  const roots = { [path.join(C, 'src')]: C, [home]: home, [path.join(wt, 'x', 'w1')]: path.join(wt, 'x', 'w1') };
  const got = await projectChoices({
    cwd: path.join(C, 'src'),
    runs: [{ repo: A, updatedAt: '2026-11-01T10:00:00Z' }, { repo: B, updatedAt: '2026-11-10T10:00:00Z' }, { repo: path.resolve('/gone'), updatedAt: '2026-11-11T10:00:00Z' }, { repo: B, createdAt: 5 }],
    cwds: [home, path.join(wt, 'x', 'w1'), path.join(C, 'src'), null],
    toplevel: async (dir) => roots[dir] ?? null,
    exists: (p) => p !== path.resolve('/gone'),
    homedir: home,
    worktrees: wt,
  });
  assert.deepEqual(got, [C, B, A]);
});

test('projectChoices keeps at most 6 run repositories and never the home folder or a worktree', async () => {
  const runs = Array.from({ length: 9 }, (_, i) => ({ repo: path.resolve(`/code/p${i}`), updatedAt: 100 - i }));
  const got = await projectChoices({ runs: [{ repo: home, updatedAt: 999 }, { repo: path.join(wt, 'a'), updatedAt: 998 }, ...runs], toplevel: async () => null, exists: () => true, homedir: home, worktrees: wt });
  assert.deepEqual(got, runs.slice(0, 6).map((r) => r.repo));
});

test('projectNames: the folder name, with its parent when two projects share it', () => {
  assert.deepEqual(projectNames([A, path.resolve('/work/shop'), B]), ['code/shop', 'work/shop', 'blog']);
});

function hcWorld({ live = [], serverUp = true, nameTaken = false } = {}) {
  return fakeRun([
    ['hc server status --json', serverUp ? { stdout: '{"running":true}' } : { code: 1, stderr: '{"error":{"kind":"unavailable","message":"no core"}}' }],
    [`hc ls --json --label ${LAUNCHER_LABEL}`, { stdout: JSON.stringify({ terminals: live }) }],
    [/^hc run .* --name foreman --label /, nameTaken ? { code: 1, stderr: '{"error":{"kind":"name_taken","message":"name foreman is in use"}}' } : { stdout: '{"address":"t9"}' }],
    [/^hc run .* --name foreman-launcher --label /, { stdout: '{"address":"t10"}' }],
  ]);
}

test('ensureLauncher does nothing unless config.json asks for a launcher', async () => {
  const run = hcWorld();
  assert.deepEqual(await ensureLauncher({ config: {}, run, hc: 'hc', homedir: home }), { status: 'off' });
  assert.deepEqual(await ensureLauncher({ config: { launcher: 'yes' }, run, hc: 'hc', homedir: home }), { status: 'off' });
  assert.equal(run.calls.length, 0);
});

test('ensureLauncher starts one launcher: named, labelled, without a parent or a space', async () => {
  const run = hcWorld();
  const res = await ensureLauncher({ config: { launcher: true }, run, hc: 'hc', homedir: home, node: 'C:\\n\\node.exe', bin: 'C:\\f\\bin\\foreman.js' });
  assert.deepEqual(res, { status: 'started', terminal: 't9' });
  const start = run.calls.find((c) => c.args[0] === 'run');
  assert.deepEqual(start.args, ['run', '--json', '--bg', '--no-parent', '--no-notify', '--name', 'foreman', '--label', LAUNCHER_LABEL, '--cwd', home, '--', 'C:/n/node.exe', 'C:/f/bin/foreman.js', 'launcher']);
  assert.ok(!start.line.includes('herdr.space'));
});

test('ensureLauncher leaves a live launcher alone, and takes another name when "foreman" is taken', async () => {
  const live = hcWorld({ live: [{ address: 't3', name: 'foreman' }] });
  assert.deepEqual(await ensureLauncher({ config: { launcher: true }, run: live, hc: 'hc', homedir: home }), { status: 'already', terminal: 't3' });
  assert.ok(!live.calls.some((c) => c.args[0] === 'run'));
  const taken = hcWorld({ nameTaken: true });
  assert.deepEqual(await ensureLauncher({ config: { launcher: true }, run: taken, hc: 'hc', homedir: home }), { status: 'started', terminal: 't10' });
});

test('ensureLauncher without herdr-core says so and starts nothing', async () => {
  assert.equal((await ensureLauncher({ config: { launcher: true }, run: hcWorld(), hc: null, homedir: home })).status, 'no-core');
  const down = hcWorld({ serverUp: false });
  assert.equal((await ensureLauncher({ config: { launcher: true }, run: down, hc: 'hc', homedir: home })).status, 'no-core');
  assert.equal(down.calls.length, 1);
});

// The launcher with a typed-in stdin, a recording stdout and a fake `main`.
function launcherWorld({ runs = [{ repo: A, updatedAt: 2 }, { repo: B, updatedAt: 1 }], files = {}, cwd = home, codes = [] } = {}) {
  const fs = { ...files };
  const started = [];
  const stdin = new PassThrough();
  let out = '';
  const stdout = { columns: 40, write: (s) => { out += s; return true; } };
  const run = fakeRun([
    [/^git -C .* rev-parse --show-toplevel$/, (cmd, args) => ([A, B, C].includes(path.resolve(args[1])) ? { stdout: `${args[1]}\n` } : { code: 128 })],
    [/^git -C .* rev-parse --abbrev-ref HEAD$/, { stdout: 'main\n' }],
    [/^git -C .* branch --format/, { stdout: 'main\ndevelop\n' }],
  ]);
  const deps = {
    run, env: {}, cwd, homedir: home, platform: process.platform, stdout,
    paths: { home: path.resolve('/s'), runs: path.resolve('/s/runs'), worktrees: wt, config: path.resolve('/s/config.json'), agentsCache: path.resolve('/s/agents.json') },
    readFile: (f) => {
      if (f in fs) return fs[f];
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    writeFile: (f, data) => { fs[f] = data; },
    readdir: () => runs.map((_, i) => `r${i}.json`),
    exists: (p) => [A, B, C].includes(path.resolve(p)),
    which: () => null,
    readJson: () => null,
  };
  for (const [i, r] of runs.entries()) fs[path.join(deps.paths.runs, `r${i}.json`)] = JSON.stringify(r);
  const main = async (argv, d) => {
    started.push({ argv, cwd: d.cwd });
    const code = codes.shift() ?? 0;
    if (code) d.stderr.write('claude is not installed on this computer\n');
    else d.stdout.write('Leader "lead" (claude) started.\n');
    return code;
  };
  const done = runLauncher({ deps, main, stdin });
  const send = async (text) => { stdin.write(`${text}\n`); await tick(); };
  const close = async () => { stdin.end(); return done; };
  return { send, close, started, fs, out: () => out, saved: () => JSON.parse(fs[path.join(deps.paths.home, 'launcher.json')]) };
}

test('launcher: a line is a task; it starts in the project of the latest run and the launcher waits again', async () => {
  const w = launcherWorld();
  await tick();
  assert.match(w.out(), /foreman · new task/);
  assert.match(w.out(), /1 project {6}shop/);
  await w.send('fix the login');
  await w.send('<hc from="t4b lead">add tests\n\nfor the cart</hc>'.replace(/\n/g, ' '));
  assert.equal(await w.close(), 0);
  assert.deepEqual(w.started, [{ argv: ['--', 'fix the login'], cwd: A }, { argv: ['--', 'add tests  for the cart'], cwd: A }]);
  assert.match(w.out(), /Started\. The leader has its own row\./);
  assert.ok(w.out().split('\n').every((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length <= 40), 'every line fits 40 columns');
});

test('launcher: numbers change the settings, and they are remembered for the next start', async () => {
  const w = launcherWorld();
  await tick();
  await w.send('1');
  assert.match(w.out(), /1 shop \(now\)\n2 blog/);
  await w.send('2');
  await w.send('3');
  await w.send('5');
  assert.match(w.out(), /1 main \(now\)\n2 develop/);
  await w.send('2');
  await w.send('second task');
  await w.close();
  assert.deepEqual(w.started, [{ argv: ['--base', 'develop', '--auto-answer', '--', 'second task'], cwd: B }]);
  assert.deepEqual(w.saved(), { repo: B, leader: 'claude', auto: true, uncommitted: false });

  const again = launcherWorld({ files: { [path.resolve('/s/launcher.json')]: JSON.stringify(w.saved()) } });
  await tick();
  assert.match(again.out(), /1 project {6}blog/);
  assert.match(again.out(), /3 auto-answer {2}on/);
  await again.send('7');
  assert.match(again.out(), /Send 1 to 5 to change a setting\./);
  await again.send('third');
  await again.close();
  assert.deepEqual(again.started, [{ argv: ['--auto-answer', '--', 'third'], cwd: B }]);
});

test('launcher: without a project the task waits for the choice, and a typed folder works too', async () => {
  const w = launcherWorld({ runs: [] });
  await tick();
  assert.match(w.out(), /1 project {6}not chosen yet/);
  await w.send('fix the login');
  assert.match(w.out(), /First choose the project for this task\./);
  assert.deepEqual(w.started, []);
  await w.send(C);
  await w.close();
  assert.deepEqual(w.started, [{ argv: ['--', 'fix the login'], cwd: C }]);
});

test('launcher: a task that did not start is reported and the launcher goes on', async () => {
  const w = launcherWorld({ codes: [1] });
  await tick();
  await w.send('fix the login');
  assert.match(w.out(), /claude is not installed on this computer/);
  assert.match(w.out(), /Not started: see above, then resend./);
  await w.send('fix the login');
  await w.close();
  assert.equal(w.started.length, 2);
});

test('launcher on a terminal reports its status and title: idle, working, then idle with the task', async () => {
  const fs = {};
  const stdin = new PassThrough();
  let out = '';
  const stdout = { isTTY: true, columns: 40, write: (s) => { out += s; return true; } };
  const deps = {
    run: fakeRun([[/^git -C .* rev-parse --show-toplevel$/, { stdout: `${A}\n` }], [/^git -C .* rev-parse --abbrev-ref HEAD$/, { stdout: 'main\n' }]]),
    env: { NO_COLOR: '1' }, cwd: A, homedir: home, platform: process.platform, stdout,
    paths: { home: path.resolve('/s'), runs: path.resolve('/s/runs'), worktrees: wt, config: path.resolve('/s/config.json'), agentsCache: path.resolve('/s/agents.json') },
    readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    writeFile: (f, data) => { fs[f] = data; },
    readdir: () => [],
    exists: () => true,
    which: () => null,
    readJson: () => null,
  };
  const done = runLauncher({ deps, main: async () => 0, stdin, maxTasks: 1 });
  await tick();
  stdin.write('fix the login\n');
  assert.equal(await done, 0);
  const states = [...out.matchAll(/\x1b\]7501;state=([a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(states, ['idle', 'working', 'idle', 'clear']);
  assert.ok(out.includes('\x1b]2;foreman: new task\x07'));
  const reports = out.split('\x1b]7501;').slice(1);
  assert.equal(decode(reports[1], 'msg'), 'Starting: fix the login');
  assert.equal(decode(reports[2], 'msg'), 'Started: fix the login');
});

test('projectChoices adds the repositories of the Herdr app spaces after the runs: at most 6, without repeats', async () => {
  const space = (i) => path.resolve(`/code/s${i}`);
  const roots = { [path.join(A, 'web')]: A, [path.join(C, 'src')]: C };
  for (let i = 0; i < 8; i++) roots[space(i)] = space(i);
  const got = await projectChoices({
    runs: [{ repo: B, updatedAt: 1 }],
    spaces: [path.join(C, 'src'), home, path.join(A, 'web'), path.join(C, 'src'), null, path.join(wt, 'x', 'w1'), ...Array.from({ length: 8 }, (_, i) => space(i))],
    cwds: [path.resolve('/code/late')],
    toplevel: async (dir) => roots[dir] ?? (dir === path.resolve('/code/late') ? dir : null),
    exists: () => true,
    homedir: home,
    worktrees: wt,
    limit: 20,
  });
  assert.deepEqual(got, [B, C, A, space(0), space(1), space(2), space(3), path.resolve('/code/late')]);
});

test('ensureLauncher puts the launcher in the Herdr app space used last, and in none without spaces', async () => {
  const run = hcWorld();
  const res = await ensureLauncher({ config: { launcher: true }, run, hc: 'hc', homedir: home, spaces: async () => [{ id: 'spNew', folder: B }, { id: 'spOld', folder: A }] });
  assert.equal(res.status, 'started');
  const start = run.calls.find((c) => c.args[0] === 'run');
  assert.deepEqual(start.args.slice(5, 11), ['--name', 'foreman', '--label', LAUNCHER_LABEL, '--label', 'herdr.space=spNew']);
  assert.ok(!start.line.includes('herdr.tab'));
  for (const spaces of [async () => [], async () => { throw new Error('no core'); }]) {
    const none = hcWorld();
    await ensureLauncher({ config: { launcher: true }, run: none, hc: 'hc', homedir: home, spaces });
    assert.ok(!none.calls.find((c) => c.args[0] === 'run').line.includes('herdr.space'));
  }
});

test('stopLauncher ends only the launcher terminals --ensure started, never a shell someone runs it in', async () => {
  const terminals = [
    { address: 't9', name: 'foreman' },
    { address: 't10', name: 'foreman-launcher' },
    { address: 't11', name: 'my-shell' },
    { address: 't12', name: 'foreman' },
  ];
  const argv = {
    t9: ['C:/n/node.exe', 'C:/f/bin/foreman.js', 'launcher'],
    t10: ['/usr/bin/node', '/f/bin/foreman.js', 'launcher'],
    t11: ['/usr/bin/node', '/f/bin/foreman.js', 'launcher'],
    t12: ['bash'],
  };
  const run = fakeRun([
    [`hc ls --json --label ${LAUNCHER_LABEL}`, { stdout: JSON.stringify({ terminals }) }],
    [/^hc get --json /, (cmd, args) => ({ stdout: JSON.stringify({ address: args[2], argv: argv[args[2]] }) })],
    ['hc kill --json t9', { stdout: '{}' }],
    ['hc kill --json t10', { code: 1, stderr: '{"error":{"kind":"denied","message":"not yours"}}' }],
    [/^hc rm --json /, { stdout: '{}' }],
  ]);
  assert.deepEqual(await stopLauncher({ run, hc: 'hc' }), { stopped: ['t9'], failed: [{ terminal: 't10', reason: 'not yours' }] });
  assert.ok(!run.calls.some((c) => /(kill|rm) --json t1[12]/.test(c.line)));
  assert.deepEqual(await stopLauncher({ run: fakeRun([]), hc: null }), { stopped: [], failed: [] });
});

test('stripHcLine takes the tag off the lines of a message as the screen shows them', () => {
  assert.equal(stripHcLine('<hc from="t4b lead">1</hc>'), '1');
  assert.equal(stripHcLine('<hc from="t4b lead">fix the login'), 'fix the login');
  assert.equal(stripHcLine('and the tests</hc>'), 'and the tests');
  assert.equal(stripHcLine('a <b>tag</b> stays'), 'a <b>tag</b> stays');
  // Passed on by another terminal: a tag for each.
  assert.equal(stripHcLine('<hc from="t5f ph1"><hc from="t4b lead">4</hc></hc>'), '4');
  assert.equal(stripHcWrapper('<hc from="t5f ph1"><hc from="t4b lead">4</hc></hc>'), '4');
});

test('launcher on a terminal shows a message sent with hc send without its tag', async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  let out = '';
  const stdout = { isTTY: true, columns: 40, write: (s) => { out += s; return true; }, on() {}, off() {}, removeListener() {} };
  const started = [];
  const deps = {
    run: fakeRun([[/^git -C .* rev-parse --show-toplevel$/, { stdout: `${A}\n` }], [/^git -C .* rev-parse --abbrev-ref HEAD$/, { stdout: 'main\n' }]]),
    env: { NO_COLOR: '1' }, cwd: A, homedir: home, platform: process.platform, stdout,
    paths: { home: path.resolve('/s'), runs: path.resolve('/s/runs'), worktrees: wt, config: path.resolve('/s/config.json'), agentsCache: path.resolve('/s/agents.json') },
    readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    writeFile: () => {},
    readdir: () => [],
    exists: () => true,
    which: () => null,
    readJson: () => null,
  };
  const done = runLauncher({ deps, main: async (argv) => { started.push(argv); return 0; }, stdin, maxTasks: 1 });
  await tick();
  stdin.write('<hc from="t4b lead">fix the login</hc>\r');
  assert.equal(await done, 0);
  assert.deepEqual(started, [['--', 'fix the login']]);
  // The echo is taken back (one row: prompt and line fit 40 columns) and written again without the tag.
  assert.ok(out.includes('\x1b[1A\r\x1b[J❯ fix the login\r\n'), JSON.stringify(out.slice(-300)));
});
