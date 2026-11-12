// Running external programs (herdr, git, agent CLIs) the same way on Windows,
// macOS and Linux. npm installs CLIs on Windows as .cmd shims, which Node can
// only start through cmd.exe, so those get a shell with strictly checked args.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SHELL_UNSAFE = /["%!^&|<>\r\n]/;

// Each PATH folder is listed once per process instead of checked file by file:
// looking for the 24 agent kinds asked thousands of exists() calls (~0.5 s on Windows).
const listings = new Map();
function listed(file) {
  const dir = path.dirname(file);
  if (!listings.has(dir)) {
    let names = null;
    try {
      names = new Set(readdirSync(dir).map((n) => (process.platform === 'win32' ? n.toLowerCase() : n)));
    } catch {
      // not a readable folder: ask the file itself
    }
    listings.set(dir, names);
  }
  const names = listings.get(dir);
  if (!names) return existsSync(file);
  const base = path.basename(file);
  return names.has(process.platform === 'win32' ? base.toLowerCase() : base);
}

export function which(name, { env = process.env, platform = process.platform, exists = listed } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exts = platform === 'win32'
    ? (env.PATHEXT || env.Pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const hasExt = platform === 'win32' && exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
  const candidates = (base) => (platform !== 'win32' || hasExt ? [base] : exts.map((e) => base + e));

  if (name.includes('/') || name.includes('\\')) {
    return candidates(name).find((c) => exists(c)) ?? null;
  }
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const c of candidates(p.join(dir, name))) {
      if (exists(c)) return c;
    }
  }
  return null;
}

// input: written to the program's standard input, which is then closed; with
// inputOpenUntil(stdoutSoFar), closed only once that says true (a program
// such as `hc connect` stops at the end of its input, answered or not).
export function run(cmd, args = [], { cwd, env, timeoutMs = 30000, input, inputOpenUntil = null } = {}) {
  return new Promise((resolve, reject) => {
    const resolved = which(cmd, { env: env ?? process.env });
    if (!resolved) {
      const err = new Error(`program not found: ${cmd}`);
      err.code = 'ENOENT';
      reject(err);
      return;
    }

    const isShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
    let child;
    const stdio = [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
    if (isShim) {
      const bad = args.find((a) => SHELL_UNSAFE.test(String(a)));
      if (bad !== undefined) {
        const err = new Error(`argument not allowed for ${path.basename(resolved)}: ${bad}`);
        err.code = 'UNSAFE_ARG';
        reject(err);
        return;
      }
      const quote = (a) => (a === '' || /\s/.test(a) ? `"${a}"` : a);
      const line = [`"${resolved}"`, ...args.map((a) => quote(String(a)))].join(' ');
      child = spawn(line, { cwd, env, shell: true, windowsHide: true, stdio });
    } else {
      child = spawn(resolved, args, { cwd, env, windowsHide: true, stdio });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let inputOpen = input !== undefined && Boolean(inputOpenUntil);
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout += d;
      if (inputOpen && inputOpenUntil(stdout)) {
        inputOpen = false;
        child.stdin.end();
      }
    });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        // Kill the whole tree: a shim leaves the real program as a grandchild.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
    });

    if (input !== undefined) {
      // A program that ends before reading all of it is no error here.
      child.stdin.on('error', () => {});
      if (inputOpen) child.stdin.write(input);
      else child.stdin.end(input);
    }
  });
}
