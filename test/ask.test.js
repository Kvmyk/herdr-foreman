import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { currentBranch, listLeaders, localBranches, runAsk } from '../src/ask.js';

const cwd = path.resolve('/code/shop');
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

// The prompt with what the person types on `stdin`, a recording stdout and a
// fake `main` that would start the task. git is answered by `spawnSync`.
function world({ columns = 80, code = 0, config = null, env = { NO_COLOR: '1' }, platform = 'linux', branches = ['main', 'develop'] } = {}) {
  const files = config ? { [path.resolve('/s/config.json')]: JSON.stringify(config) } : {};
  const started = [];
  const edited = [];
  let out = '';
  const stdout = { columns, write: (s) => { out += s; return true; } };
  const stderr = { write: (s) => { out += s; return true; } };
  const deps = {
    env, platform, cwd: path.resolve('/elsewhere'), homedir: path.resolve('/h'), tmpdir: path.resolve('/tmp'), stdout, stderr,
    paths: { config: path.resolve('/s/config.json'), agentsCache: path.resolve('/s/agents.json') },
    run: async () => { throw Object.assign(new Error('no program'), { code: 'ENOENT' }); },
    which: (k) => (k === 'codex' ? '/bin/codex' : null),
    readJson: () => null,
    readFile: (f) => {
      if (f in files) return files[f];
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    writeFile: (f, data) => { files[f] = data; },
    removeFile: (f) => { delete files[f]; },
    exists: (f) => f.endsWith('login.js'),
    sleep: async () => {},
  };
  const spawnSync = (cmd, args) => {
    if (cmd !== 'git') {
      edited.push(cmd);
      return { status: 1 };
    }
    if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'main\n' };
    if (args[2] === 'branch') return { status: 0, stdout: `${branches.join('\n')}\n(HEAD detached at 1a2b3c)\n` };
    return { status: 128, stdout: '' };
  };
  const main = async (argv, d) => {
    started.push({ argv, cwd: d.cwd });
    d.progress('Checking the project...');
    if (code) d.stderr.write('claude is not installed on this computer\n');
    else d.stdout.write('Leader "lead" (claude) started.\n');
    return code;
  };
  const stdin = new PassThrough();
  const ask = (text, opts = {}) => {
    stdin.end(text);
    return runAsk({ deps, main, cwd, stdin, spawnSync, ...opts });
  };
  return { ask, deps, started, edited, files, out: () => strip(out) };
}

test('runAsk shows the prompt, takes the task and starts it in the folder it was opened for', async () => {
  const w = world();
  assert.equal(await w.ask('fix the login, see @src/login.js\nand add a test\n\n'), 0);
  assert.deepEqual(w.started, [{ argv: ['--', 'fix the login, see @src/login.js\nand add a test'], cwd }]);
  const out = w.out();
  assert.match(out, /foreman · new task/);
  assert.match(out, /shop {2}⎇ main/);
  assert.match(out, /leader claude · branch ⎇ main · auto-answer off · uncommitted off/);
  assert.match(out, /Enter ×2 +an empty line starts the task/);
  assert.match(out, /fix the login, see @src\/login\.js {2}\(\+1 more lines\)/);
  assert.match(out, /files {2}src\/login\.js/);
  assert.match(out, /✓ Checking the project\n/);
  assert.match(out, /Done\. The leader works in the tab "foreman"/);
  // The marker comes back after each line that continues, not after the last.
  assert.equal(out.split('❯ ').length - 1, 3);
});

test('runAsk: settings typed first become the start flags, and a wrong one is explained', async () => {
  const w = world({ config: { leader: 'claude' } });
  // codex is installed here but not signed in, so only the configured leader can lead.
  assert.equal(await w.ask('/auto\n/uncommitted\n/branch develop\n/leader nobody\n/leader codex\nfix it\n\n'), 0);
  assert.deepEqual(w.started[0].argv, ['--base', 'develop', '--auto-answer', '--include-uncommitted', '--', 'fix it']);
  assert.match(w.out(), /! nobody cannot lead here\. Ready agents: claude/);
  assert.match(w.out(), /! codex cannot lead here\. Ready agents: claude/);
  assert.match(w.out(), /leader claude · branch ⎇ develop · auto-answer on · uncommitted on/);
});

test('runAsk: an empty first line ends the prompt and starts nothing', async () => {
  const w = world();
  assert.equal(await w.ask('\n'), 0);
  assert.deepEqual(w.started, []);
  assert.doesNotMatch(w.out(), /Done\./);
});

test('runAsk: a task that does not start returns its code; only the overlay waits for a key', async () => {
  const w = world({ code: 1 });
  assert.equal(await w.ask('fix it\n\n'), 1);
  assert.match(w.out(), /✗ Checking the project\nclaude is not installed on this computer/);
  assert.doesNotMatch(w.out(), /Press any key|Done\./);
  const overlay = world({ code: 1 });
  assert.equal(await overlay.ask('fix it\n\n', { overlay: true }), 1);
  assert.match(overlay.out(), /Press any key to close\./);
});

test('runAsk at 40 columns: short hints, settings one per line, nothing wider than the screen before the task', async () => {
  const w = world({ columns: 40 });
  assert.equal(await w.ask('fix it\n\n'), 0);
  const before = w.out().slice(0, w.out().indexOf('❯ '));
  assert.ok(before.split('\n').every((l) => l.length <= 40), before.split('\n').find((l) => l.length > 40));
  assert.match(before, /Paste or type the task\./);
  assert.match(before, /a pasted task starts with one Enter\./);
  assert.match(before, /\n {2}leader claude\n {2}branch ⎇ main\n {2}auto-answer off\n {2}uncommitted off\n/);
  assert.doesNotMatch(before, /Ctrl\+D|e \+ Enter/);
});

test('runAsk leaves the editor hint out where the editor is a window on the computer; "e" still opens it', async () => {
  assert.doesNotMatch((await (async () => { const w = world({ platform: 'win32' }); await w.ask('\n'); return w; })()).out(), /e \+ Enter/);
  const vim = world({ env: { NO_COLOR: '1', EDITOR: 'vim' }, platform: 'win32' });
  await vim.ask('\n');
  assert.match(vim.out(), /e \+ Enter/);
  // The editor could not be opened: the prompt says so and reads the task itself.
  const w = world();
  assert.equal(await w.ask('e\n'), 0);
  assert.equal(w.edited.length, 1);
  assert.match(w.out(), /I could not open an editor\. Type your task here instead/);
  assert.deepEqual(w.started, []);
});

test('listLeaders, currentBranch and localBranches', async () => {
  const w = world();
  const deps = { run: async () => { throw new Error('x'); }, which: () => null, env: {}, readJson: () => null, exists: () => false, homedir: '/h', paths: { agentsCache: '/s/agents.json' }, writeFile: (f, d) => { w.files[f] = d; } };
  assert.deepEqual(await listLeaders(deps, { leader: 'codex', excludeKinds: [] }), ['codex']);
  assert.deepEqual(JSON.parse(w.files['/s/agents.json']).agents, []);
  const git = (lines, status = 0) => () => ({ status, stdout: lines });
  assert.equal(currentBranch(git('feat/x\n'), cwd), 'feat/x');
  assert.equal(currentBranch(git('', 128), cwd), null);
  assert.deepEqual(localBranches(git('main\n  develop\n(HEAD detached at 1a2b3c)\n'), cwd), ['main', 'develop']);
  assert.equal(localBranches(git('', 128), cwd), null);
});

test('runAsk asks the agents who can lead only when /leader is used, so a cancelled prompt ends at once', async () => {
  const probes = (w) => { let n = 0; const which = w.deps.which; w.deps.which = (k) => { n++; return which(k); }; return () => n; };
  const cancelled = world();
  const none = probes(cancelled);
  await cancelled.ask('\n');
  assert.equal(none(), 0);
  const plain = world();
  const still = probes(plain);
  await plain.ask('/auto\nfix it\n\n');
  assert.equal(still(), 0);
  const leader = world();
  const some = probes(leader);
  await leader.ask('/leader claude\nfix it\n\n');
  assert.ok(some() > 0);
});
