// The last time an agent kind failed to start (its program exited), kept under
// FOREMAN_HOME so the next brief can tell the leader not to plan with it.

const MAX_AGE_MS = 24 * 3600 * 1000;

function read({ paths, readFile }) {
  if (!paths.startFailures) return {};
  try {
    return JSON.parse(readFile(paths.startFailures)) ?? {};
  } catch {
    return {};
  }
}

function write(data, { paths, writeFile, mkdir }) {
  if (!paths.startFailures) return;
  try {
    mkdir?.(paths.home, { recursive: true });
    writeFile(paths.startFailures, JSON.stringify(data, null, 2));
  } catch {
    /* a note about failures must never break a spawn */
  }
}

// The sign-in of some kinds can run out while their login status still looks fine.
const SIGN_IN_HINTS = [[/access token could not be refreshed|log out and sign in again/i, 'codex', 'run "codex login"']];

export function startFailureHint(kind, message) {
  const found = SIGN_IN_HINTS.find(([re, k]) => k === kind && re.test(message));
  return found ? `${message}; ${found[2]}` : message;
}

export function recordStartResults({ paths, readFile, writeFile, mkdir, now = Date.now, failed = [], worked = [] }) {
  const data = read({ paths, readFile });
  let changed = false;
  for (const { kind, message } of failed) {
    data[kind] = { at: new Date(now()).toISOString(), message: startFailureHint(kind, message) };
    changed = true;
  }
  for (const kind of worked) {
    if (kind in data && !failed.some((f) => f.kind === kind)) {
      delete data[kind];
      changed = true;
    }
  }
  if (changed) write(data, { paths, writeFile, mkdir });
}

// Failures still fresh enough to matter: { kind: { at, message } }.
export function recentStartFailures({ paths, readFile, now = Date.now }) {
  const data = read({ paths, readFile });
  return Object.fromEntries(Object.entries(data).filter(([, v]) => now() - Date.parse(v.at) < MAX_AGE_MS));
}
