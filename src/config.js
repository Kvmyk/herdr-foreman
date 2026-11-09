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
  knowledgeUrl: null,
  excludeKinds: [],
  // false: foreman never adds or restores its herdr shortcut by itself.
  autoSetup: true,
  // Run in every new worker worktree, e.g. "npm ci"; .foreman.json in a repository wins.
  worktreeSetup: null,
  // Untracked files copied from your checkout into each worktree, e.g. [".env*"].
  copyFiles: [],
  worktreeSetupTimeoutMs: 600000,
  // Worker panes: "stack" (leader on the left, workers stacked on the right)
  // or "grid" (equal columns of up to three).
  layout: 'stack',
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
  return { ...DEFAULT_CONFIG, ...user };
}
