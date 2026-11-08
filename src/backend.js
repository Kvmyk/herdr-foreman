// Where foreman runs agents: the herdr terminal app (herdr server, herdr CLI)
// or the Herdr desktop app (herdr-core's hc and herdr-app). Both clients
// offer the same methods; `kind` tells them apart.
import path from 'node:path';
import { createHerdr } from './herdr.js';
import { createHerdrApp } from './herdr-app.js';
import { fail } from './errors.js';

export const BACKENDS = Object.freeze(['herdr', 'app']);

export function checkBackend(name) {
  if (!BACKENDS.includes(name)) throw fail('USAGE', `--backend is herdr or app (got "${name}")`);
  return name;
}

// A choice (--backend, then FOREMAN_BACKEND) wins. Otherwise the terminal
// foreman runs in decides: herdr panes have HERDR_ENV=1, hc terminals have
// HC_TERMINAL_ID (and no HERDR_* or label variables). One nested in the other
// inherits both, and the inner one set TERM_PROGRAM last.
// Outside both, an installed herdr wins, as before the desktop app existed.
export function detectBackend({ env = {}, flag = null, installed = () => false } = {}) {
  const chosen = flag ?? env.FOREMAN_BACKEND;
  if (chosen) return checkBackend(chosen);
  const inHerdr = env.HERDR_ENV === '1';
  const inApp = Boolean(env.HC_TERMINAL_ID);
  if (inHerdr && inApp) return env.TERM_PROGRAM === 'herdr' ? 'herdr' : 'app';
  if (inApp) return 'app';
  if (inHerdr) return 'herdr';
  return installed('herdr') || !installed('hc') ? 'herdr' : 'app';
}

// The pane or terminal foreman was called from, if any.
export function callerPane(backend, env = {}) {
  return (backend === 'app' ? env.HC_TERMINAL_ID : env.HERDR_PANE_ID) || null;
}

// hc and herdr-app are often not on PATH: look where their installers put them.
export function findTool(name, { which, env = {}, platform = process.platform, homedir = '', exists = () => false }) {
  const found = which(name);
  if (found) return found;
  const dirs = { hc: 'herdr-core', 'herdr-app': 'herdr-app' };
  const candidates = platform === 'win32'
    ? [path.win32.join(env.LOCALAPPDATA ?? path.win32.join(homedir, 'AppData', 'Local'), 'Programs', dirs[name], `${name}.exe`)]
    : [path.posix.join(homedir, '.local', 'bin', name)];
  return candidates.find((c) => exists(c)) ?? null;
}

export function installed(name, deps) {
  return Boolean(name === 'herdr' ? deps.which(name) : findTool(name, deps));
}

export function createBackend(name, deps) {
  if (name !== 'app') return createHerdr({ run: deps.run });
  return createHerdrApp({ run: deps.run, hc: findTool('hc', deps) ?? 'hc', app: findTool('herdr-app', deps) ?? 'herdr-app' });
}
