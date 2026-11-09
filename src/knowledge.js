// What foreman knows about harnesses and model families, and facts about
// models from models.dev. Built-in data ships with foreman; a newer copy can
// come from knowledgeUrl (refreshed weekly upstream), fetched at most daily.
import { readFileSync } from 'node:fs';

const DAY = 24 * 3600 * 1000;
const STALE_AFTER = 90 * DAY;
export const MODELS_DEV_URL = 'https://models.dev/api.json';

const BUILTIN = JSON.parse(readFileSync(new URL('../knowledge/agents.json', import.meta.url), 'utf8'));

function tryReadJson(readFile, file) {
  try {
    return JSON.parse(readFile(file));
  } catch {
    return null;
  }
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, extra) {
  if (!isObject(base) || !isObject(extra)) return extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

async function fetchJson(fetchImpl, url) {
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

const normalizeKey = (id) => id.toLowerCase().split('/').pop().replace(/[\s_.]+/g, '-');

export function indexModelsDev(api) {
  const index = {};
  for (const provider of Object.values(api ?? {})) {
    for (const [id, m] of Object.entries(provider?.models ?? {})) {
      const key = normalizeKey(id);
      const entry = {
        name: m.name ?? id,
        context: m.limit?.context ?? null,
        output: m.limit?.output ?? null,
        costIn: m.cost?.input ?? null,
        costOut: m.cost?.output ?? null,
        costCacheRead: m.cost?.cache_read ?? null,
        costCacheWrite: m.cost?.cache_write ?? null,
        reasoning: Boolean(m.reasoning),
        releaseDate: m.release_date ?? null,
        knowledge: m.knowledge ?? null,
        lastUpdated: m.last_updated ?? '',
      };
      if (!index[key] || entry.lastUpdated > index[key].lastUpdated) index[key] = entry;
    }
  }
  return index;
}

export function lookupModel(index, id) {
  return index[normalizeKey(id)] ?? null;
}

export function familyFor(knowledge, modelId) {
  const full = modelId.toLowerCase().replace(/[\s_]+/g, '-');
  const last = full.split('/').pop();
  return knowledge.families.find((f) => {
    const re = new RegExp(f.match, 'i');
    return re.test(full) || re.test(last);
  }) ?? null;
}

async function refreshed({ file, key, readFile, writeFile, now, offline, load, warnings, label }) {
  const cache = tryReadJson(readFile, file);
  if (cache && now - cache.fetchedAt < DAY) return { value: cache[key], from: 'cache' };
  if (!offline) {
    try {
      const value = await load();
      writeFile(file, JSON.stringify({ fetchedAt: now, [key]: value }));
      return { value, from: 'remote' };
    } catch (err) {
      warnings.push(`${label} refresh failed: ${err.message}`);
    }
  }
  return cache ? { value: cache[key], from: 'cache' } : { value: null, from: null };
}

export async function loadKnowledge({ paths, fetchImpl = fetch, readFile, writeFile, now = Date.now(), knowledgeUrl = null, offline = false }) {
  const warnings = [];
  let knowledge = BUILTIN;
  let source = 'builtin';

  if (knowledgeUrl) {
    const remote = await refreshed({
      file: paths.knowledgeCache, key: 'data', readFile, writeFile, now, offline, warnings, label: 'knowledge',
      load: () => fetchJson(fetchImpl, knowledgeUrl),
    });
    if (remote.value?.updated && remote.value.updated > BUILTIN.updated) {
      knowledge = remote.value;
      source = remote.from;
    }
  }

  const overrides = tryReadJson(readFile, paths.overrides);
  if (overrides) knowledge = deepMerge(knowledge, overrides);

  knowledge = {
    ...knowledge,
    families: (knowledge.families ?? []).map((f) => ({ ...f, stale: now - Date.parse(f.updated) > STALE_AFTER })),
  };

  const dev = await refreshed({
    file: paths.modelsDevCache, key: 'index', readFile, writeFile, now, offline, warnings, label: 'models.dev',
    load: async () => indexModelsDev(await fetchJson(fetchImpl, MODELS_DEV_URL)),
  });

  return { knowledge, source, modelsDev: dev.value ?? {}, warnings };
}

export function builtinKnowledge() {
  return BUILTIN;
}
