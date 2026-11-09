import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearSubcommand, usageOf, commandUsage } from '../src/cli-usage.js';
import { describeConfig, formatConfig } from '../src/configcmd.js';
import { allSettled, runWatch } from '../src/watch.js';
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
