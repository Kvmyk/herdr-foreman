// Real implementations of everything main() needs; tests pass their own.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, which } from './run.js';
import { paths } from './config.js';

const BIN = fileURLToPath(new URL('../bin/foreman.js', import.meta.url));

function writeFile(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function appendFile(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, data);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function realDeps() {
  return {
    run,
    which: (name) => which(name),
    env: process.env,
    cwd: process.cwd(),
    homedir: os.homedir(),
    paths: paths(),
    readFile: (file) => readFileSync(file, 'utf8'),
    readJson,
    writeFile,
    appendFile,
    mkdir: (dir, opts) => mkdirSync(dir, opts),
    exists: existsSync,
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 }),
    fetchImpl: fetch,
    now: Date.now,
    stdout: process.stdout,
    stderr: process.stderr,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    spawnDetached(cmd, args) {
      const child = spawn(which(cmd) ?? cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    },
    attach() {
      spawnSync(which('herdr') ?? 'herdr', [], { stdio: 'inherit' });
    },
    foremanCmd: which('foreman') ? 'foreman' : `node "${BIN}"`,
  };
}
