import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './git-repo.js';
import { setupSettings, expandGlobs, prepareWorktree, prepareWorktrees, runShell, formatSetup } from '../src/worktree-setup.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function tree(files) {
  const dir = makeTempDir('foreman-setup-');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const noFile = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

test('settings come from config.json; .foreman.json in the repo wins', () => {
  const repo = path.resolve('/code/shop');
  const none = setupSettings({ config: DEFAULT_CONFIG, repo, readFile: noFile });
  assert.equal(none.command, null);
  assert.deepEqual(none.copyFiles, []);
  assert.equal(none.timeoutMs, 600000);

  const config = { ...DEFAULT_CONFIG, worktreeSetup: 'npm ci', copyFiles: ['.env'] };
  const global = setupSettings({ config, repo, readFile: noFile });
  assert.equal(global.command, 'npm ci');
  assert.equal(global.commandSource, 'config.json');

  const local = setupSettings({ config, repo, readFile: () => JSON.stringify({ worktreeSetup: 'pnpm i', copyFiles: ['.env*', 'config/local.json'] }) });
  assert.equal(local.command, 'pnpm i');
  assert.equal(local.commandSource, '.foreman.json');
  assert.deepEqual(local.copyFiles, ['.env*', 'config/local.json']);
});

test('a broken .foreman.json or wrong types warn and fall back', () => {
  const repo = path.resolve('/code/shop');
  const bad = setupSettings({ config: { worktreeSetup: 'npm ci' }, repo, readFile: () => '{nope' });
  assert.equal(bad.command, 'npm ci');
  assert.match(bad.warnings[0], /not valid JSON/);
  const types = setupSettings({ config: { copyFiles: '.env' }, repo, readFile: () => JSON.stringify({ worktreeSetup: 3 }) });
  assert.equal(types.command, null);
  assert.deepEqual(types.copyFiles, []);
  assert.equal(types.warnings.length, 2);
});

test('expandGlobs: *, ?, ** and plain paths; no .git, node_modules or ..', () => {
  const dir = tree({
    '.env': 'A=1', '.env.local': 'B=2', 'env.txt': 'x', 'apps/web/.env': 'C=3', 'apps/api/.env': 'D=4',
    'node_modules/pkg/.env': 'no', 'config/local.json': '{}', 'k1.pem': 'k', 'k22.pem': 'k',
  });
  try {
    assert.deepEqual(expandGlobs(dir, ['.env*']), ['.env', '.env.local']);
    assert.deepEqual(expandGlobs(dir, ['**/.env']), ['.env', 'apps/api/.env', 'apps/web/.env']);
    assert.deepEqual(expandGlobs(dir, ['config/local.json', 'missing.json']), ['config/local.json']);
    assert.deepEqual(expandGlobs(dir, ['k?.pem']), ['k1.pem']);
    assert.deepEqual(expandGlobs(dir, ['../outside', path.join(dir, '.env')]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareWorktree copies missing files, keeps tracked ones and runs the command', async () => {
  const repo = tree({ '.env': 'SECRET=1', 'README.md': 'yours, changed' });
  const worktree = tree({ 'README.md': 'committed' });
  const calls = [];
  try {
    const out = await prepareWorktree({
      repo,
      worker: { name: 'w1', worktree },
      settings: { command: 'npm ci', copyFiles: ['.env', 'README.md'], timeoutMs: 1000 },
      shell: async (cmd, o) => { calls.push([cmd, o]); return { code: 0, output: '', ms: 1500 }; },
    });
    assert.deepEqual(out.copied, ['.env']);
    assert.deepEqual(out.skipped, ['README.md']);
    assert.equal(readFileSync(path.join(worktree, '.env'), 'utf8'), 'SECRET=1');
    assert.equal(readFileSync(path.join(worktree, 'README.md'), 'utf8'), 'committed');
    assert.equal(calls[0][0], 'npm ci');
    assert.equal(calls[0][1].cwd, worktree);
    assert.equal(calls[0][1].env.FOREMAN_WORKER, 'w1');
    assert.equal(calls[0][1].env.FOREMAN_REPO, repo);
    assert.equal(out.ok, true);
    assert.equal(formatSetup(out), 'setup w1: copied .env; kept the worktree\'s README.md; "npm ci" ok in 2s');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('prepareWorktrees does nothing without settings and turns failures into warnings', async () => {
  const none = await prepareWorktrees({ repo: '/r', workers: [{ name: 'w1', worktree: '/w' }], settings: { command: null, copyFiles: [], warnings: ['x'] } });
  assert.deepEqual(none, { results: [], warnings: ['x'] });
  const failing = await prepareWorktrees({
    repo: '/r',
    workers: [{ name: 'w1', worktree: '/w1' }, { name: 'w2', worktree: '/w2' }],
    settings: { command: 'make deps', copyFiles: [], timeoutMs: 1000, warnings: [] },
    shell: async (cmd, o) => (o.cwd === '/w2' ? { code: 2, output: 'step 1\nerror: no make\n', ms: 10 } : { code: 0, output: '', ms: 10 }),
  });
  assert.deepEqual(failing.results.map((r) => r.ok), [true, false]);
  assert.deepEqual(failing.warnings, ['w2: setup "make deps" failed (exit 2): error: no make']);
  assert.match(formatSetup(failing.results[1]), /"make deps" FAILED/);
});

test('runShell runs in the folder and reports the exit code', async () => {
  const dir = tree({ 'marker.txt': 'here' });
  try {
    const ok = await runShell('node -e "process.stdout.write(require(\'fs\').readFileSync(\'marker.txt\',\'utf8\'))"', { cwd: dir, timeoutMs: 20000 });
    assert.equal(ok.code, 0);
    assert.equal(ok.output, 'here');
    const bad = await runShell('node -e "process.exit(3)"', { cwd: dir, timeoutMs: 20000 });
    assert.equal(bad.code, 3);
    assert.ok(existsSync(path.join(dir, 'marker.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn runs prepare before agents start and reports its warnings', async () => {
  const { spawnWorkers } = await import('../src/spawn.js');
  const order = [];
  const files = {};
  const res = await spawnWorkers({
    herdr: {
      agentList: async () => [],
      paneSplit: async () => 'p2',
      agentStart: async () => { order.push('start'); return { ok: true }; },
    },
    git: {
      head: async () => 'abc', commonDir: async () => '/r/.git', isDirty: async () => false, addWorktree: async () => {},
      validBranchName: async () => true, branchExists: async () => false, worktreeConfigEnabled: async () => true, armPushGuard: async () => {},
    },
    paths: { runs: '/s/runs', worktrees: '/s/wt' },
    config: DEFAULT_CONFIG, repo: '/r', task: 'fix-login', specs: ['w1=claude'], pane: 'p1', branch: 'fix/login',
    prepare: async (workers) => { order.push(`prepare ${workers.map((w) => w.name)}`); return { results: [{ worker: 'w1', copied: [], skipped: [], ok: true }], warnings: ['w1: setup failed'] }; },
    writeFile: (f, d) => { files[f] = d; },
    readFile: (f) => { if (!(f in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[f]; },
    appendFile: () => {}, mkdir: () => {},
  });
  assert.deepEqual(order, ['prepare w1', 'start']);
  assert.ok(res.warnings.includes('w1: setup failed'));
  assert.equal(res.setup[0].worker, 'w1');
});
