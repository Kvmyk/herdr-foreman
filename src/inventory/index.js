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

export async function inventory({ run, which, env, readJson, exists, home, kinds = HERDR_KINDS, exclude = [], timeoutMs = 20000 }) {
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
    const [ver, result] = await Promise.all([version(run, kind, timeoutMs), probe]);
    // A remembered default (last used model) can disappear, e.g. when a provider's login expires.
    if (spec?.listsModels && result.defaultModel && result.models.length && !result.models.some((m) => m.id === result.defaultModel)) {
      result.reason = `last used model "${result.defaultModel}" is not available now (provider signed out?)`;
      result.defaultModel = null;
    }
    return { kind, path, version: ver, verified: spec?.verified ?? false, ...result };
  }));
}
