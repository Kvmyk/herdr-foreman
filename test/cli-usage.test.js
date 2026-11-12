import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearSubcommand, usageOf, commandUsage } from '../src/cli-usage.js';
import { describeConfig, formatConfig } from '../src/configcmd.js';
import { allSettled, runWatch } from '../src/watch.js';
import { statusSeq } from '../src/status.js';
import { createUi } from '../src/ui.js';

test('near-miss subcommands are found; real words and tasks are left alone', () => {
  assert.equal(nearSubcommand('statu'), 'status');
  assert.equal(nearSubcommand('spwan'), 'spawn');
  assert.equal(nearSubcommand('clenaup'), 'cleanup');
  assert.equal(nearSubcommand('status'), null);
  assert.equal(nearSubcommand('fix'), null);
  assert.equal(nearSubcommand('login'), null);
});

test('every usage line starts with foreman and the command name', () => {
  assert.match(usageOf('spawn'), /^foreman spawn --task/);
  assert.equal(commandUsage('status'), 'Usage: foreman status --task <slug> [--json]\n');
});

test('config shows what differs from the default', () => {
  const read = (f) => { if (f.endsWith('config.json')) return '{"leader":"codex"}'; throw new Error('x'); };
  const c = describeConfig({ paths: { config: '/h/config.json' }, readFile: read });
  assert.deepEqual(c.changed, ['leader']);
  assert.equal(c.exists, true);
  assert.match(formatConfig(c, createUi()), /\* leader\s+"codex"/);
  const none = describeConfig({ paths: { config: '/h/config.json' }, readFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  assert.equal(none.exists, false);
  assert.deepEqual(none.changed, []);
});

test('watch refreshes until every worker finished', async () => {
  const states = [[{ name: 'a', state: 'working', report: false }], [{ name: 'a', state: 'idle', report: true }]];
  let n = 0;
  let out = '';
  const slept = [];
  const code = await runWatch({
    status: async () => states[n++], render: (l) => l.map((s) => s.name).join(','), stdout: { write: (s) => { out += s; } },
    sleep: async (ms) => { slept.push(ms); }, intervalS: 2, tty: true,
  });
  assert.equal(code, 0);
  assert.deepEqual(slept, [2000]);
  assert.ok(out.includes('\x1b[2J'));
  assert.match(out, /every worker has finished/);
  assert.equal(allSettled([]), false);
});

test('the run subcommands have usage lines and are offered for near misses', () => {
  for (const name of ['runs', 'show', 'diff', 'resume', 'respawn']) assert.match(usageOf(name), new RegExp('^foreman ' + name));
  assert.equal(nearSubcommand('respwan'), 'respawn');
  assert.equal(nearSubcommand('resum'), 'resume');
  assert.match(usageOf('diff'), /--stat/);
});

test('config shows the value the environment decides', () => {
  const read = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  const c = describeConfig({ paths: { config: '/h/config.json' }, readFile: read, env: { FOREMAN_NO_SETUP: '1' } });
  assert.equal(c.config.autoSetup, false);
  assert.match(formatConfig(c, createUi()), /autoSetup\s+false\s+\(set by the environment: FOREMAN_NO_SETUP\)/);
});

test('watch reports its status as OSC 7501 (the launcher\'s format): working, then done, only in a Herdr app terminal', async () => {
  const states = [[{ name: 'a', state: 'working', report: false }, { name: 'b', state: 'idle', report: true }], [{ name: 'a', state: 'idle', report: true }, { name: 'b', state: 'idle', report: true }]];
  const go = async (tty, env, task = 'fix-login') => {
    let n = 0; let out = '';
    await runWatch({ status: async () => states[n++], render: () => 'x', stdout: { write: (s) => { out += s; } }, sleep: async () => {}, tty, env, task });
    return out;
  };
  const on = await go(true, { HC_TERMINAL_ID: 't1' });
  // One implementation: every report is exactly what statusSeq makes.
  const reports = on.match(/\x1b\]7501;[^\x1b]*\x1b\\/g);
  assert.deepEqual(reports, [
    statusSeq({ state: 'working', msg: 'Watching fix-login' }),
    statusSeq({ state: 'working', msg: 'Watching fix-login: 1 of 2 finished', progress: 50 }),
    statusSeq({ state: 'done', msg: 'Every worker of fix-login has finished' }),
  ]);
  assert.match(reports[0], /^\x1b\]7501;state=working:app=foreman:msg=[A-Za-z0-9+/=]+\x1b\\$/);
  assert.match(reports[2], /^\x1b\]7501;state=done:app=foreman:msg=/);
  assert.equal(Buffer.from(/msg=([A-Za-z0-9+/=]+)/.exec(reports[1])[1], 'base64').toString(), 'Watching fix-login: 1 of 2 finished');
  // The old made-up payload is gone, and so is BEL as the terminator.
  assert.ok(!on.includes('\x1b]7501;working') && !/\x1b\]7501;[^\x1b]*\x07/.test(on));
  assert.ok(!(await go(true, {})).includes('7501'));
  assert.ok(!(await go(false, { HC_TERMINAL_ID: 't1' })).includes('7501'));
  assert.match(await go(true, { HC_TERMINAL_ID: 't1' }, null), /7501;state=working:app=foreman:msg=/);
});

test('foreman watch passes the task and the environment on, so the report names the run', async () => {
  const { main } = await import('../src/cli.js');
  let out = '';
  const code = await main(['watch', '--task', 'fix-login'], {
    env: { HC_TERMINAL_ID: 't1' }, paths: {}, readFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
    stdout: { isTTY: true, write: (s) => { out += s; } }, stderr: { write() {} }, sleep: async () => {},
    ops: { status: async () => [{ name: 'a', state: 'idle', report: true }] },
  });
  assert.equal(code, 0);
  assert.ok(out.includes(statusSeq({ state: 'done', msg: 'Every worker of fix-login has finished' })));
});
