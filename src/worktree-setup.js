// Getting a fresh worker worktree ready to build and test: copy files git
// does not track (.env, local settings) from your checkout, then run a setup
// command such as "npm ci". Both come from ~/.herdr-foreman/config.json
// (worktreeSetup, copyFiles) or from .foreman.json at the root of the
// repository, which wins for that repository.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const REPO_SETTINGS = '.foreman.json';
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const KEEP_OUTPUT = 4000;

const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());

// { command, copyFiles, timeoutMs, source, warnings }; command null and
// copyFiles empty when nothing is set.
export function setupSettings({ config = {}, repo, readFile }) {
  const warnings = [];
  let local = {};
  try {
    local = JSON.parse(readFile(path.join(repo, REPO_SETTINGS)));
  } catch (err) {
    if (err.code !== 'ENOENT') warnings.push(`${REPO_SETTINGS} in ${repo} is not valid JSON (${err.message}); using config.json only`);
  }
  const pick = (key, valid) => {
    if (local?.[key] !== undefined) {
      if (valid(local[key])) return { value: local[key], source: REPO_SETTINGS };
      warnings.push(`${REPO_SETTINGS}: ${key} has the wrong type and is ignored`);
    }
    if (config[key] !== undefined && config[key] !== null) {
      if (valid(config[key])) return { value: config[key], source: 'config.json' };
      warnings.push(`config.json: ${key} has the wrong type and is ignored`);
    }
    return { value: null, source: null };
  };
  const command = pick('worktreeSetup', (v) => typeof v === 'string' && v.trim() !== '');
  const copy = pick('copyFiles', isStringList);
  return {
    command: command.value?.trim() ?? null,
    commandSource: command.source,
    copyFiles: copy.value ?? [],
    timeoutMs: Number(config.worktreeSetupTimeoutMs) > 0 ? Number(config.worktreeSetupTimeoutMs) : 600000,
    warnings,
  };
}

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
const segmentRe = (seg) => new RegExp(`^${seg.split('').map((c) => (c === '*' ? '[^/\\\\]*' : c === '?' ? '[^/\\\\]' : escapeRe(c))).join('')}$`);
const hasWildcard = (seg) => /[*?]/.test(seg);

// Paths (relative, with /) under root that match the patterns: * and ? within
// one folder, ** across folders. .git and node_modules are not searched, and
// a pattern cannot leave root.
export function expandGlobs(root, patterns, fsx = fs) {
  const found = new Set();
  const entries = (dir) => {
    try {
      return fsx.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const walk = (dir, rel, segs) => {
    const [seg, ...rest] = segs;
    if (seg === '**') {
      walk(dir, rel, rest);
      for (const e of entries(dir)) {
        if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), [...rel, e.name], segs);
      }
      return;
    }
    if (seg === undefined) return;
    const names = hasWildcard(seg)
      ? entries(dir).filter((e) => segmentRe(seg).test(e.name) && !SKIP_DIRS.has(e.name)).map((e) => e.name)
      : fsx.existsSync(path.join(dir, seg)) ? [seg] : [];
    for (const name of names) {
      const full = path.join(dir, name);
      if (rest.length) walk(full, [...rel, name], rest);
      else found.add([...rel, name].join('/'));
    }
  };
  for (const pattern of patterns) {
    const segs = pattern.split(/[\\/]+/).filter((s) => s && s !== '.');
    if (!segs.length || path.isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || segs.includes('..')) continue;
    walk(root, [], segs);
  }
  return [...found].sort();
}

// A shell command in the worktree, with the end of its output kept.
export function runShell(command, { cwd, env = process.env, timeoutMs = 600000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(command, { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, output: err.message, timedOut: false, ms: 0 });
      return;
    }
    const keep = (d) => { output = (output + d).slice(-KEEP_OUTPUT); };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: err.message, timedOut, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, output, timedOut, ms: Date.now() - started });
    });
  });
}

// Copies first (setup may need .env), then the command. A file already in
// the worktree (tracked by git) is never overwritten.
export async function prepareWorktree({ repo, worker, settings, fsx = fs, shell = runShell, env = process.env }) {
  const out = { worker: worker.name, copied: [], skipped: [], command: settings.command, ok: true };
  for (const rel of expandGlobs(repo, settings.copyFiles, fsx)) {
    const to = path.join(worker.worktree, rel);
    if (fsx.existsSync(to)) {
      out.skipped.push(rel);
      continue;
    }
    try {
      fsx.mkdirSync(path.dirname(to), { recursive: true });
      fsx.cpSync(path.join(repo, rel), to, { recursive: true });
      out.copied.push(rel);
    } catch (err) {
      out.ok = false;
      out.error = `copy ${rel}: ${err.message}`;
    }
  }
  if (settings.command) {
    const res = await shell(settings.command, {
      cwd: worker.worktree,
      env: { ...env, FOREMAN_WORKER: worker.name, FOREMAN_REPO: repo },
      timeoutMs: settings.timeoutMs,
    });
    Object.assign(out, { code: res.code, ms: res.ms, timedOut: res.timedOut });
    if (res.code !== 0) {
      out.ok = false;
      out.output = res.output.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-5).join('\n');
    }
  }
  return out;
}

// All workers at once; nothing happens when nothing is configured.
export async function prepareWorktrees({ repo, workers, settings, ...rest }) {
  const warnings = [...settings.warnings];
  if (!settings.command && !settings.copyFiles.length) return { results: [], warnings };
  const results = await Promise.all(workers.map((worker) => prepareWorktree({ repo, worker, settings, ...rest })));
  for (const r of results) {
    if (r.error) warnings.push(`${r.worker}: ${r.error}`);
    if (r.command && r.code !== 0) {
      const why = r.timedOut ? `did not finish in ${Math.round(settings.timeoutMs / 1000)}s` : `failed (exit ${r.code})`;
      warnings.push(`${r.worker}: setup "${r.command}" ${why}${r.output ? `: ${r.output.split('\n').at(-1)}` : ''}`);
    }
  }
  return { results, warnings };
}

// One line per worker for the spawn output.
export function formatSetup(r) {
  const parts = [];
  if (r.copied.length) parts.push(`copied ${r.copied.join(', ')}`);
  if (r.skipped.length) parts.push(`kept the worktree's ${r.skipped.join(', ')}`);
  if (r.command) parts.push(`"${r.command}" ${r.code === 0 ? `ok in ${Math.round(r.ms / 1000)}s` : 'FAILED'}`);
  return `setup ${r.worker}: ${parts.join('; ') || 'nothing to do'}`;
}
