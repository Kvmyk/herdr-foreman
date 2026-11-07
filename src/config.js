// Where foreman keeps its state, and the user's settings.
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  leader: 'claude',
  maxWorkers: 6,
  startTimeoutMs: 90000,
  knowledgeUrl: null,
  excludeKinds: [],
});

export function paths({ env = process.env, homedir = os.homedir() } = {}) {
  const home = env.FOREMAN_HOME ?? path.join(homedir, '.herdr-foreman');
  return {
    home,
    config: path.join(home, 'config.json'),
    journal: path.join(home, 'journal.jsonl'),
    knowledgeCache: path.join(home, 'knowledge-cache.json'),
    modelsDevCache: path.join(home, 'models-dev-cache.json'),
    overrides: path.join(home, 'knowledge.override.json'),
    worktrees: path.join(home, 'worktrees'),
    runs: path.join(home, 'runs'),
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
  return { ...DEFAULT_CONFIG, ...user };
}
