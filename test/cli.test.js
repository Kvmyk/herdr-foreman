import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main, route } from '../src/cli.js';
import { fakeRun } from './helpers.js';

function harness(ops = {}, extra = {}) {
  let out = '';
  let err = '';
  const calls = [];
  const deps = {
    env: {},
    cwd: path.resolve('/code/shop'),
    paths: { runs: '/s/runs', journal: '/s/journal.jsonl', config: '/s/config.json', worktrees: '/s/wt', knowledgeCache: '/s/k', modelsDevCache: '/s/m', overrides: '/s/o' },
    readFile: (f) => {
      if (extra.files && f in extra.files) return extra.files[f];
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    appendFile: () => {},
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    ops: {
      start: async (o) => { calls.push(['start', o.task]); return { ok: true, message: 'started' }; },
      inventory: async () => [{ kind: 'claude', status: 'ready', version: '2', models: [{ id: 'opus', access: 'subscription' }], defaultModel: null, reason: null }],
      ...ops,
    },
    ...extra.deps,
  };
  return { deps, calls, out: () => out, err: () => err };
}

test('quoted task with spaces starts', async () => {
  const h = harness();
  assert.equal(await main(['dodaj logowanie przez Google'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'dodaj logowanie przez Google']]);
});

test('task starting with subcommand word starts', async () => {
  const h = harness();
  assert.equal(await main(['status', 'aplikacji', 'jest', 'zły'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'status aplikacji jest zły']]);
});

test('status with flags is a subcommand', async () => {
  const h = harness({ status: async (o) => { h.calls.push(['status', o.task]); return []; } });
  assert.equal(await main(['status', '--task', 'fix-login', '--json'], h.deps), 0);
  assert.deepEqual(h.calls, [['status', 'fix-login']]);
});

test('misspelled flag on a subcommand is a usage error', async () => {
  const h = harness();
  assert.equal(await main(['status', '--tsk', 'x'], h.deps), 2);
  assert.equal(h.calls.length, 0);
  assert.match(h.err(), /status/);
});

test('double dash forces start', async () => {
  const h = harness();
  assert.equal(await main(['--', 'agents', 'are', 'slow'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'agents are slow']]);
});

const setupResult = (o = {}) => ({
  quiet: false, changes: [], ok: true, node: { ok: true, version: '22.1.0' }, herdr: { ok: true, version: '0.9.5' },
  git: { version: '2.45', name: 'Ada', hasEmail: true }, plugin: 'enabled', key: { status: 'already', key: 'prefix+f', prefix: 'ctrl+b' },
  agents: [{ kind: 'claude', status: 'ready' }], leader: 'claude', ...o,
});

test('no args runs setup and says what to do next', async () => {
  const h = harness({ setup: async (o) => { h.calls.push(['setup', o.quiet]); return setupResult(); } });
  assert.equal(await main([], h.deps), 0);
  assert.deepEqual(h.calls, [['setup', false]]);
  assert.match(h.out(), /What to do next/);
});

test('setup returns 1 while something is missing; doctor is the same', async () => {
  const h = harness({ setup: async () => setupResult({ ok: false }) });
  assert.equal(await main(['doctor'], h.deps), 1);
  assert.match(h.out(), /Fix the lines marked/);
});

test('quiet setup (install and startup hooks) never fails', async () => {
  const h = harness({ setup: async () => { throw new Error('boom'); } });
  assert.equal(await main(['setup', '--quiet'], h.deps), 0);
  assert.match(h.err(), /boom/);
  const off = harness({ setup: async () => { throw new Error('must not run'); } }, { deps: { env: { FOREMAN_NO_SETUP: '1' } } });
  assert.equal(await main(['setup', '--postinstall'], off.deps), 0);
});

test('a task first runs the quiet setup and reports what it changed', async () => {
  const h = harness({ ensureSetup: async () => setupResult({ quiet: true, changes: ['added the shortcut Ctrl+B, then F to herdr'] }) });
  assert.equal(await main(['fix the login'], h.deps), 0);
  assert.match(h.out(), /^foreman added the shortcut Ctrl\+B, then F to herdr\.\n/);
  assert.deepEqual(h.calls, [['start', 'fix the login']]);
});

test('setup is a task when followed by words', async () => {
  const h = harness();
  assert.equal(await main(['setup', 'the', 'database'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'setup the database']]);
});

test('--help prints help', async () => {
  const h = harness();
  assert.equal(await main(['--help'], h.deps), 0);
  assert.match(h.out(), /foreman "<task>"/);
});

test('agents --json prints inventory', async () => {
  const h = harness();
  assert.equal(await main(['agents', '--json'], h.deps), 0);
  assert.equal(JSON.parse(h.out())[0].kind, 'claude');
});

test('agents without --json prints a table', async () => {
  const h = harness();
  assert.equal(await main(['agents'], h.deps), 0);
  assert.match(h.out(), /claude\s+ready/);
});

test('journal add rejects invalid file with exit 2', async () => {
  const h = harness({}, { files: { '/tmp/j.json': JSON.stringify([{ task: 't', category: 'nope' }]) } });
  assert.equal(await main(['journal', 'add', '/tmp/j.json'], h.deps), 2);
  assert.match(h.err(), /invalid journal entry/);
});

test('failed start returns 1 with message', async () => {
  const h = harness({ start: async () => ({ ok: false, message: 'foreman needs a git repository' }) });
  assert.equal(await main(['fix it'], h.deps), 1);
  assert.match(h.err(), /git repository/);
});

test('cleanup without task lists leftovers', async () => {
  const h = harness({ leftovers: async () => [{ task: 'old-run', repo: '/r', worktrees: ['/w/a'], liveWorkers: ['w1'] }] });
  assert.equal(await main(['cleanup'], h.deps), 0);
  assert.match(h.out(), /old-run/);
  assert.match(h.out(), /foreman cleanup --all/);
});

test('cleanup --all cleans every leftover run', async () => {
  const h = harness({ cleanupAll: async (o) => { h.calls.push(['all', o.deleteBranch]); return [{ task: 'old-run', closedPanes: [], removedWorktrees: ['/w/a'], deletedBranches: [], errors: [] }]; } });
  assert.equal(await main(['cleanup', '--all'], h.deps), 0);
  assert.deepEqual(h.calls, [['all', false]]);
});

test('close-leader closes the calling pane', async () => {
  const h = harness({ closeLeader: async () => { h.calls.push(['close']); return { closed: 'w1:p9' }; } });
  assert.equal(await main(['close-leader'], h.deps), 0);
  assert.deepEqual(h.calls, [['close']]);
});

test('cleanup words still start a task', async () => {
  const h = harness();
  assert.equal(await main(['cleanup', 'the', 'old', 'code'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'cleanup the old code']]);
});

test('wait prints compact json', async () => {
  const h = harness({ wait: async (o) => { h.calls.push(['wait', o.task, o.phase, o.only, o.timeoutMs]); return { result: 'done', elapsedS: 3, workers: { w1: 'done' } }; } });
  assert.equal(await main(['wait', '--task', 't', '--phase', 'investigate', '--only', 'w1', '--timeout', '1000'], h.deps), 0);
  assert.deepEqual(h.calls, [['wait', 't', 'investigate', ['w1'], 1000]]);
  assert.equal(h.out(), '{"result":"done","elapsedS":3,"workers":{"w1":"done"}}\n');
});

test('wait rejects an unknown phase', async () => {
  const h = harness({ wait: async () => ({}) });
  assert.equal(await main(['wait', '--task', 't', '--phase', 'later'], h.deps), 2);
});

test('spawn passes effort and full', async () => {
  const h = harness({ spawn: async (o) => { h.calls.push(['spawn', o.effort, o.full, o.specs, o.auto]); return { workers: [], warnings: [] }; } });
  assert.equal(await main(['spawn', '--task', 't', '--effort', 'low', '--full', 'w1=claude', '--json'], h.deps), 0);
  assert.deepEqual(h.calls, [['spawn', 'low', true, ['w1=claude'], false]]);
});

test('spawn --auto is passed through', async () => {
  const h = harness({ spawn: async (o) => { h.calls.push(['spawn', o.auto, o.branch]); return { workers: [], warnings: [] }; } });
  assert.equal(await main(['spawn', '--task', 't', '--auto', '--branch', 'feat/x', 'w1=claude', '--json'], h.deps), 0);
  assert.deepEqual(h.calls, [['spawn', true, 'feat/x']]);
});

test('spawn --include-uncommitted is passed through and mentioned when a snapshot was made', async () => {
  const h = harness({
    spawn: async (o) => { h.calls.push(['spawn', o.includeUncommitted]); return { workers: [], warnings: [], snapshot: 'snap111' }; },
  });
  assert.equal(await main(['spawn', '--task', 't', '--include-uncommitted', 'w1=claude', '--json'], h.deps), 0);
  assert.deepEqual(h.calls, [['spawn', true]]);
  assert.equal(JSON.parse(h.out()).snapshot, 'snap111');

  const h2 = harness({ spawn: async (o) => { h2.calls.push(['spawn', o.includeUncommitted]); return { workers: [], warnings: [], snapshot: 'snap111' }; } });
  await main(['spawn', '--task', 't', 'w1=claude'], h2.deps);
  assert.deepEqual(h2.calls, [['spawn', false]]);
  assert.match(h2.out(), /workers start from a copy that includes your uncommitted changes/);
});

test('land passes --title', async () => {
  const h = harness({ land: async (o) => { h.calls.push(['land', o.task, o.title]); return { ok: true, branch: 'feat/x' }; } });
  assert.equal(await main(['land', '--task', 't', '--title', 'add x', '--json'], h.deps), 0);
  assert.equal(await main(['land', '--task', 't', '--json'], h.deps), 0);
  assert.deepEqual(h.calls, [['land', 't', 'add x'], ['land', 't', null]]);
});

test('spawn without --branch is a usage error when foreman says so', async () => {
  const h = harness({ spawn: async () => { throw Object.assign(new Error('needs --branch'), { code: 'BRANCH_REQUIRED' }); } });
  assert.equal(await main(['spawn', '--task', 't', 'w1=claude'], h.deps), 2);
});

test('-f reads the task from a file', async () => {
  const h = harness({}, { deps: { readFile: (f) => (f === 'task.md' ? 'line one\nline two\n' : '') } });
  assert.equal(await main(['-f', 'task.md'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'line one\nline two']]);
});

test('-f with a missing or empty file explains in plain words', async () => {
  const missing = harness({}, { deps: { readFile: () => { throw new Error('ENOENT'); } } });
  assert.equal(await main(['-f', 'x.md'], missing.deps), 2);
  assert.match(missing.err(), /could not read the file x\.md/);
  const empty = harness({}, { deps: { readFile: () => '  \n' } });
  assert.equal(await main(['--file', 'x.md'], empty.deps), 2);
  assert.match(empty.err(), /is empty/);
  assert.equal(route(['-f']).kind, 'usage');
});

test('a task piped in on stdin starts; a terminal still shows status', async () => {
  const piped = harness({}, { deps: { readStdin: async () => 'fix the thing\nplease\n' } });
  assert.equal(await main([], piped.deps), 0);
  assert.deepEqual(piped.calls, [['start', 'fix the thing\nplease']]);
  const tty = harness({ setup: async () => setupResult() }, { deps: { readStdin: async () => null } });
  assert.equal(await main([], tty.deps), 0);
  assert.deepEqual(tty.calls, []);
});

test('--backend before or after a task picks the backend; with a subcommand it is a usage error', async () => {
  assert.deepEqual(route(['--backend', 'app', 'fix', 'it']), { kind: 'start', task: 'fix it', backend: 'app' });
  assert.deepEqual(route(['fix it', '--backend', 'herdr']), { kind: 'start', task: 'fix it', backend: 'herdr' });
  assert.deepEqual(route(['--backend', 'app', '-f', 'task.md']), { kind: 'start', file: 'task.md', backend: 'app' });
  assert.equal(route(['--backend', 'app', 'status', '--task', 'x']).kind, 'usage');
  assert.equal(route(['--backend', 'tmux', 'fix']).kind, 'usage');
  const h = harness({ start: async (o) => { h.calls.push(['start', o.task, o.backend]); return { ok: true }; } });
  assert.equal(await main(['--backend', 'app', 'fix it'], h.deps), 0);
  assert.deepEqual(h.calls, [['start', 'fix it', 'app']]);
});

test('prompt, read and keys need --task, so task words still start a leader', async () => {
  assert.equal(route(['read', 'the', 'docs']).kind, 'start');
  assert.equal(route(['prompt', 'me', 'for', 'a', 'name']).kind, 'start');
  assert.deepEqual(route(['keys', '--task', 't', 'w1', 'down', 'enter']).positionals, ['w1', 'down', 'enter']);
});

test('prompt, read and keys reach the agent', async () => {
  const h = harness({
    prompt: async (o) => { h.calls.push(['prompt', o]); return { sent: o.name }; },
    read: async (o) => { h.calls.push(['read', o]); return 'screen'; },
    keys: async (o) => { h.calls.push(['keys', o]); return { sent: o.name, keys: o.keys }; },
  });
  assert.equal(await main(['prompt', '--task', 't', 'w1', 'do the thing'], h.deps), 0);
  assert.equal(await main(['read', '--task', 't', '--lines', '40', 'w1'], h.deps), 0);
  assert.equal(await main(['keys', '--task', 't', '--backend', 'app', 'w1', 'down', 'enter'], h.deps), 0);
  assert.deepEqual(h.calls, [
    ['prompt', { task: 't', backend: null, name: 'w1', text: 'do the thing' }],
    ['read', { task: 't', backend: null, name: 'w1', lines: 40 }],
    ['keys', { task: 't', backend: 'app', name: 'w1', keys: ['down', 'enter'] }],
  ]);
  assert.match(h.out(), /sent to w1\nscreen\npressed down enter in w1\n/);
  assert.equal(await main(['read', '--task', 't', '--lines', 'x', 'w1'], h.deps), 2);
});

test('prompt goes through the backend of the run; read and keys follow the terminal foreman runs in', async () => {
  const run = fakeRun([[/^hc send/, { stdout: '{"turn":1}' }], [/^hc keys/, { stdout: '{}' }], [/^herdr agent read/, { stdout: 'herdr screen' }]]);
  const files = { [path.join('/s/runs', 'fix-login.json')]: JSON.stringify({ task: 'fix-login', backend: 'app', workers: [] }) };
  const h = harness({}, { files, deps: { run, which: () => null, exists: () => false, env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' } } });
  assert.equal(await main(['prompt', '--task', 'fix-login', 'w1', 'go'], h.deps), 0);
  assert.equal(await main(['read', '--task', 'other', 'w1'], h.deps), 0);
  assert.equal(await main(['keys', '--task', 'other', '--backend', 'app', 'w1', 'esc'], h.deps), 0);
  assert.deepEqual(run.calls.map((c) => [c.cmd, ...c.args.slice(0, 1)]), [['hc', 'send'], ['herdr', 'agent'], ['hc', 'keys']]);
});

test('close-leader in the Herdr app ends the calling hc terminal', async () => {
  const run = fakeRun([[/^hc kill/, { stdout: '{}' }], [/^hc rm/, { stdout: '{}' }]]);
  const h = harness({}, { deps: { run, which: () => null, exists: () => false, env: { HC_TERMINAL_ID: 't7' } } });
  assert.equal(await main(['close-leader'], h.deps), 0);
  assert.deepEqual(run.calls[0].args, ['kill', '--json', 't7']);
  const outside = harness({}, { deps: { run, which: () => null, exists: () => false, env: {} } });
  assert.equal(await main(['close-leader'], outside.deps), 2);
});

test('--version prints the package version', async () => {
  const h = harness();
  assert.equal(await main(['--version'], h.deps), 0);
  assert.match(h.out(), /^\d+\.\d+\.\d+/);
});

test('<command> --help prints that command usage only', async () => {
  const h = harness();
  assert.equal(await main(['spawn', '--help'], h.deps), 0);
  assert.match(h.out(), /^Usage: foreman spawn --task/);
  assert.equal(h.out().split('\n').length, 2);
});

test('a usage error shows the command usage line', async () => {
  const h = harness();
  assert.equal(await main(['status', '--tsk', 'x'], h.deps), 2);
  assert.match(h.err(), /Usage: foreman status --task <slug>/);
});

test('a near-miss subcommand followed by flags offers the right one; plain words still start', async () => {
  const h = harness();
  assert.equal(await main(['statu', '--task', 'x'], h.deps), 2);
  assert.match(h.err(), /Did you mean "foreman status"\?/);
  assert.deepEqual(h.calls, []);
  assert.equal(route(['statu', 'of', 'the', 'app']).kind, 'start');
  assert.equal(route(['fix', '--the', 'login']).kind, 'start');
});

test('spawn exits 1 when an agent exited at start, and says which pane was left open', async () => {
  const h = harness({
    spawn: async () => ({
      workers: [
        { name: 'w1', kind: 'codex', paneId: 'p9', status: 'not_ready', exited: true, error: 'agent_exited: codex exited (code 2)\nunexpected argument' },
        { name: 'w2', kind: 'agy', paneId: 'p10', status: 'ready', error: null },
      ],
      warnings: [],
    }),
  });
  assert.equal(await main(['spawn', '--task', 't', '--branch', 'feat/x', 'w1=codex', 'w2=agy'], h.deps), 1);
  assert.match(h.out(), /w1: failed to start: agent_exited: codex exited \(code 2\); pane p9 left open/);
  assert.match(h.out(), /WORKER\s+AGENT\s+PANE\s+STATUS/);
});

test('a worker waiting on a dialog is not a failed spawn', async () => {
  const h = harness({ spawn: async () => ({ workers: [{ name: 'w1', kind: 'agy', paneId: 'p9', status: 'not_ready', error: 'agent_not_ready: waiting' }], warnings: [] }) });
  assert.equal(await main(['spawn', '--task', 't', '--branch', 'feat/x', 'w1=agy'], h.deps), 0);
});

test('status shows state, time, files and lines; --json stays plain data', async () => {
  const list = [{ name: 'w1', state: 'working', ageS: 125, dirty: true, changedFiles: ['a', 'b'], added: 10, removed: 3, commitsAhead: 1, report: false, proposals: false, pushGuardArmed: false }];
  const h = harness({ status: async () => list });
  assert.equal(await main(['status', '--task', 't'], h.deps), 0);
  assert.match(h.out(), /w1\s+working\s+2m05s\s+changed\s+2\s+\+10 -3\s+1\s+-\s+MISSING/);
  const j = harness({ status: async () => list });
  await main(['status', '--task', 't', '--json'], j.deps);
  assert.deepEqual(JSON.parse(j.out()), list);
});

test('wait, brief and journal stats are readable on a terminal and JSON otherwise', async () => {
  const wait = { result: 'attention', elapsedS: 12, workers: { w1: { state: 'blocked', screen: 'Trust?', hint: 'agy asks to trust this folder; answer it with: foreman keys --task t w1 enter' }, w2: 'done' } };
  const tty = harness({ wait: async () => wait }, { deps: { stdout: { isTTY: true, write() {} } } });
  const lines = [];
  tty.deps.stdout.write = (s) => lines.push(s);
  await main(['wait', '--task', 't'], tty.deps);
  assert.match(lines.join(''), /attention after 12s/);
  assert.match(lines.join(''), /foreman keys --task t w1 enter/);
  const piped = harness({ wait: async () => wait });
  await main(['wait', '--task', 't'], piped.deps);
  assert.deepEqual(JSON.parse(piped.out()), wait);
  const json = harness({ wait: async () => wait }, { deps: { stdout: { isTTY: true, write() {} } } });
  let got = '';
  json.deps.stdout.write = (s) => { got += s; };
  await main(['wait', '--task', 't', '--json'], json.deps);
  assert.deepEqual(JSON.parse(got), wait);
});

test('config lists settings, and --json is data', async () => {
  const h = harness({}, { files: { '/s/config.json': '{"leader":"codex"}' } });
  assert.equal(await main(['config', '--json'], h.deps), 0);
  const out = JSON.parse(h.out());
  assert.equal(out.config.leader, 'codex');
  assert.deepEqual(out.changed, ['leader']);
});

test('watch needs --task and an interval above zero', async () => {
  const h = harness();
  assert.equal(route(['watch', '--interval', '3']).kind, 'usage');
  assert.equal(await main(['watch', '--task', 't', '--interval', '0'], h.deps), 2);
});

test('NO_COLOR keeps every output plain, FORCE_COLOR colors it', async () => {
  const bad = { workers: [{ name: 'w1', kind: 'codex', paneId: 'p9', status: 'not_ready', exited: true, error: 'agent_exited: x' }], warnings: [] };
  const plain = harness({ spawn: async () => bad }, { deps: { env: { NO_COLOR: '1', FORCE_COLOR: '1' } } });
  await main(['spawn', '--task', 't', '--branch', 'feat/x', 'w1=codex'], plain.deps);
  assert.doesNotMatch(plain.out(), /\x1b\[/);
  const colored = harness({ spawn: async () => bad }, { deps: { env: { FORCE_COLOR: '1' } } });
  await main(['spawn', '--task', 't', '--branch', 'feat/x', 'w1=codex'], colored.deps);
  assert.match(colored.out(), /\x1b\[31m/);
});

test('route: answers given in front of a task go to the leader', () => {
  assert.deepEqual(route(['--backend', 'app', '--auto-answer', '--include-uncommitted', '--', 'fix', 'it']),
    { kind: 'start', task: 'fix it', backend: 'app', prefs: { autoAnswer: true, includeUncommitted: true } });
  assert.deepEqual(route(['--auto-answer', 'fix it']), { kind: 'start', task: 'fix it', prefs: { autoAnswer: true } });
  assert.equal(route(['--auto-answer', 'status', '--task', 'x']).kind, 'usage');
  // spawn keeps its own --include-uncommitted
  assert.equal(route(['spawn', '--task', 'x', '--include-uncommitted', 'a=claude']).name, 'spawn');
});

test('--help lists every subcommand of the README table, the shortcuts and examples', async () => {
  const { readFileSync } = await import('node:fs');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const table = readme.slice(readme.indexOf('## Subcommands'), readme.indexOf('## Choosing agents'));
  const names = [...new Set([...table.matchAll(/^\| `foreman ([a-z-]+)/gm)].map((m) => m[1]))];
  assert.ok(names.length >= 10);
  const h = harness();
  await main(['--help'], h.deps);
  for (const name of names) assert.match(h.out(), new RegExp(`^  ${name}( |$)`, 'm'), `${name} is missing from --help`);
  assert.match(h.out(), /Ctrl\+Shift\+Y/);
  assert.match(h.out(), /^Examples:/m);
  assert.match(h.out(), /--auto-answer/);
});
