// Creates throwaway git repositories for tests. Not a test file itself.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A fresh temp dir in its long, canonical form: on Windows os.tmpdir() can be an 8.3 short path
// (RUNNER~1) while git reports the long one, and only the native realpath expands it.
export function makeTempDir(prefix) {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function makeRepo(files = { 'a.txt': 'one\n' }) {
  const dir = makeTempDir('foreman-git-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function commitFile(dir, name, text, message = `edit ${name}`) {
  writeFileSync(path.join(dir, name), text);
  git(dir, 'add', name);
  git(dir, 'commit', '-q', '-m', message);
}
