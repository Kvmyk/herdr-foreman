// Real implementations of everything main() needs; tests pass their own.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, which } from './run.js';
import { paths } from './config.js';

const BIN = fileURLToPath(new URL('../bin/foreman.js', import.meta.url));

// How the leader runs foreman. A Windows path gets forward slashes: node takes
// them, and they survive bash, cmd, PowerShell and an agent re-quoting them.
export function foremanCommand(found, bin = BIN) {
  return found ? 'foreman' : `node "${bin.replace(/\\/g, '/')}"`;
}

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
    platform: process.platform,
    tmpdir: os.tmpdir(),
    nodeVersion: process.versions.node,
    paths: paths(),
    readFile: (file) => readFileSync(file, 'utf8'),
    readJson,
    writeFile,
    appendFile,
    mkdir: (dir, opts) => mkdirSync(dir, opts),
    exists: existsSync,
    readdir: (dir) => readdirSync(dir),
    removeFile: (file) => rmSync(file, { force: true }),
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
    // The task piped in on standard input; null when stdin is a terminal.
    async readStdin() {
      if (process.stdin.isTTY !== false) return null;
      let text = '';
      for await (const chunk of process.stdin) text += chunk;
      return text;
    },
    foremanCmd: foremanCommand(Boolean(which('foreman'))),
  };
}
