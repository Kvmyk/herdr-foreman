// Where foreman keeps its state, and the user's settings.
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  leader: 'claude',
  maxWorkers: 6,
  startTimeoutMs: 90000,
  waitTimeoutMs: 540000,
  lean: true,
  leaderArgs: [],
  // Newer knowledge about agents, fetched at most daily; false turns it off.
  knowledgeUrl: 'https://raw.githubusercontent.com/Kvmyk/herdr-foreman/main/knowledge/agents.json',
  excludeKinds: [],
  // false: foreman never adds or restores its herdr shortcut by itself.
  autoSetup: true,
  // Run in every new worker worktree, e.g. "npm ci"; .foreman.json in a repository wins.
  worktreeSetup: null,
  // Untracked files copied from your checkout into each worktree, e.g. [".env*"].
  copyFiles: [],
  worktreeSetupTimeoutMs: 600000,
  // Worker panes: "auto" (a tab per worker on a narrow screen, else stacked),
  // "stack" (leader on the left, workers stacked on the right), "grid" (equal
  // columns of up to three) or "tabs" (every worker in a tab of its own).
  layout: 'auto',
  // Run when foreman wait returns attention or done: an argv array, no shell,
  // {title} and {body} filled in, e.g. ["curl", "-d", "{body}", "ntfy.sh/mytopic"]. null: off.
  notifyCommand: null,
});

export function paths({ env = process.env, homedir = os.homedir() } = {}) {
  const home = env.FOREMAN_HOME ?? path.join(homedir, '.herdr-foreman');
  return {
    home,
    config: path.join(home, 'config.json'),
    journal: path.join(home, 'journal.jsonl'),
    knowledgeCache: path.join(home, 'knowledge-cache.json'),
    agentsCache: path.join(home, 'agents.json'),
    modelsDevCache: path.join(home, 'models-dev-cache.json'),
    overrides: path.join(home, 'knowledge.override.json'),
    worktrees: path.join(home, 'worktrees'),
    runs: path.join(home, 'runs'),
    startFailures: path.join(home, 'start-failures.json'),
    setupState: path.join(home, 'setup.json'),
  };
}

// readFile(path) -> string; throws when the file is missing.
export function loadConfig({ paths: p, readFile }) {
  let user = {};
  try {
    user = JSON.parse(readFile(p.config));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read ${p.config}: ${err.message}`);
  }
  const config = { ...DEFAULT_CONFIG, ...user };
  // Anything but a non-empty list of strings turns it off.
  if (!Array.isArray(config.notifyCommand) || !config.notifyCommand.length || !config.notifyCommand.every((a) => typeof a === 'string' && a)) config.notifyCommand = null;
  return config;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A JSON value that is not an object or an array.
const PRIMITIVE = /(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\]|\\.)*")/.source;

// Set one top-level key of config.json to a JSON value (a boolean, a number, a
// string, null), keeping the other keys and the way the file is laid out:
// a key that is there gets its value replaced in place, a new one is added
// after the last key with the same indentation. When the text cannot be edited
// like that, the file is written out again with the indentation it had. A
// missing file is created. Throws when the file is not a JSON object.
export function setConfigKey({ file, readFile, writeFile }, key, value) {
  let text = null;
  try {
    text = readFile(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read ${file}: ${err.message}`);
  }
  const literal = JSON.stringify(value);
  if (text === null || !text.trim()) {
    writeFile(file, `{\n  ${JSON.stringify(key)}: ${literal}\n}\n`);
    return;
  }
  let user;
  try {
    user = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); fix it, then try again`);
  }
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error(`${file} does not hold a JSON object; fix it, then try again`);
  const want = { ...user, [key]: value };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const same = (candidate) => {
    try {
      const got = JSON.parse(candidate);
      return JSON.stringify(Object.keys(got).sort().map((k) => [k, got[k]])) === JSON.stringify(Object.keys(want).sort().map((k) => [k, want[k]]));
    } catch {
      return false;
    }
  };
  let next = null;
  const at = new RegExp(`(${escapeRe(JSON.stringify(key))}\\s*:\\s*)${PRIMITIVE}`);
  if (key in user && at.test(text)) {
    next = text.replace(at, (_m, head) => `${head}${literal}`);
  } else if (!(key in user)) {
    const close = text.lastIndexOf('}');
    const before = text.slice(0, close).replace(/\s+$/, '');
    const entry = `${JSON.stringify(key)}: ${literal}`;
    next = before.endsWith('{')
      ? `${before}${eol}${indent}${entry}${eol}}${text.slice(close + 1)}`
      : `${before},${eol}${indent}${entry}${text.slice(before.length, close)}}${text.slice(close + 1)}`;
  }
  if (next === null || !same(next)) next = `${JSON.stringify(want, null, indent)}\n`.replace(/\n/g, eol);
  writeFile(file, next);
}
