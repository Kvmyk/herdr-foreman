// Which agents can work right now: installed, signed in, with which models.
import { HERDR_KINDS, PROBES } from './kinds.js';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unknown', reason: 'probe timed out', models: [], defaultModel: null }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function version(run, kind, timeoutMs) {
  try {
    const res = await run(kind, ['--version'], { timeoutMs });
    return (res.stdout || res.stderr).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

// The last list, for the desktop prompt to show at once while it asks again.
// Only kind and status: what can lead, not what it costs.
export function saveAgents({ writeFile, file }, agents) {
  try {
    writeFile(file, `${JSON.stringify({ at: new Date().toISOString(), agents: agents.map(({ kind, status }) => ({ kind, status })) })}\n`);
  } catch {
    // a list that cannot be saved is still a good answer
  }
  return agents;
}

// versions: false skips each agent's --version, which only the agents table shows.
export async function inventory({ run, which, env, readJson, exists, home, kinds = HERDR_KINDS, exclude = [], timeoutMs = 20000, versions = true }) {
  const installed = kinds
    .filter((kind) => !exclude.includes(kind))
    .map((kind) => ({ kind, path: which(kind) }))
    .filter((a) => a.path);

  return Promise.all(installed.map(async ({ kind, path }) => {
    const spec = PROBES[kind];
    const ctx = { run, env, readJson, exists, home, timeoutMs };
    const probe = spec
      ? withTimeout(spec.probe(ctx).catch((err) => ({ status: 'unknown', reason: err.message, models: [], defaultModel: null })), timeoutMs)
      : Promise.resolve({ status: 'unknown', reason: 'no probe for this kind yet', models: [], defaultModel: null });
    const [ver, result] = await Promise.all([versions ? version(run, kind, timeoutMs) : null, probe]);
    // A remembered default (last used model) can disappear, e.g. when a provider's login expires.
    if (spec?.listsModels && result.defaultModel && result.models.length && !result.models.some((m) => m.id === result.defaultModel)) {
      result.reason = `last used model "${result.defaultModel}" is not available now (provider signed out?)`;
      result.defaultModel = null;
    }
    return { kind, path, version: ver, verified: spec?.verified ?? false, ...result };
  }));
}
