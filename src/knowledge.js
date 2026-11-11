// What foreman knows about harnesses and model families, and facts about
// models from models.dev. Built-in data ships with foreman; a newer copy comes
// from knowledgeUrl (by default the repository's knowledge/agents.json, which a
// weekly workflow refreshes), fetched at most daily.
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

// A missing file is null; a file that cannot be read or parsed is a warning.
function readOptionalJson(readFile, file, warnings, label) {
  let text;
  try {
    text = readFile(file);
  } catch (err) {
    if (err.code !== 'ENOENT') warnings.push(`${label} ${file} cannot be read: ${err.message}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    warnings.push(`${label} ${file} is not valid JSON, ignored: ${err.message}`);
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

// Families merge by id, so a change to one family keeps the others; rules are
// appended unless appendRules is false; everything else deep-merges, with
// other arrays replaced.
export function mergeKnowledge(base, extra, { appendRules = true } = {}) {
  if (!isObject(base) || !isObject(extra)) return extra;
  const { families, rules, ...rest } = extra;
  const out = deepMerge(base, rest);
  if (appendRules && Array.isArray(rules)) out.rules = [...new Set([...(Array.isArray(base.rules) ? base.rules : []), ...rules])];
  else if (rules !== undefined) out.rules = rules;
  if (Array.isArray(families) && Array.isArray(base.families)) {
    const merged = [...base.families];
    for (const f of families) {
      const at = isObject(f) ? merged.findIndex((b) => isObject(b) && b.id === f.id) : -1;
      if (at >= 0) merged[at] = deepMerge(merged[at], f);
      else merged.push(f);
    }
    out.families = merged;
  } else if (families !== undefined) {
    out.families = families;
  }
  return out;
}

const isIsoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// Problems with knowledge data, one sentence each; empty when it is usable.
export function validateKnowledge(k) {
  if (!isObject(k)) return ['knowledge is not a JSON object'];
  const errors = [];
  if (!isIsoDate(k.updated)) errors.push('updated is not a YYYY-MM-DD date');
  if (!isStringList(k.categories) || !k.categories.length || k.categories.some((c) => !c)) errors.push('categories is not a list of names');
  if (!isStringList(k.rules)) errors.push('rules is not a list of strings');
  if (k.sources !== undefined && (!isObject(k.sources) || Object.values(k.sources).some((u) => typeof u !== 'string'))) errors.push('sources is not an object of URLs');
  const sources = isObject(k.sources) ? k.sources : {};
  const checkSources = (list, where) => {
    if (list === undefined) return;
    if (!isStringList(list)) errors.push(`${where}: sources is not a list of source ids`);
    else for (const id of list) if (!(id in sources)) errors.push(`${where}: source ${id} is not in sources`);
  };
  if (!isObject(k.harnesses)) {
    errors.push('harnesses is not an object');
  } else {
    for (const [name, h] of Object.entries(k.harnesses)) {
      if (!isObject(h)) {
        errors.push(`harness ${name} is not an object`);
        continue;
      }
      for (const f of ['strengths', 'weaknesses']) if (h[f] !== undefined && !isStringList(h[f])) errors.push(`harness ${name}: ${f} is not a list of strings`);
      checkSources(h.sources, `harness ${name}`);
    }
  }
  if (!Array.isArray(k.families)) {
    errors.push('families is not a list');
    return errors;
  }
  const seen = new Set();
  k.families.forEach((f, i) => {
    if (!isObject(f)) {
      errors.push(`family #${i + 1} is not an object`);
      return;
    }
    const where = `family ${typeof f.id === 'string' && f.id ? f.id : `#${i + 1}`}`;
    if (typeof f.id !== 'string' || !f.id) errors.push(`${where}: id is missing`);
    else if (seen.has(f.id)) errors.push(`${where}: id is used twice`);
    else seen.add(f.id);
    if (typeof f.match !== 'string' || !f.match) {
      errors.push(`${where}: match is missing`);
    } else {
      try {
        new RegExp(f.match, 'i');
      } catch (err) {
        errors.push(`${where}: match is not a valid regular expression (${err.message})`);
      }
    }
    if (!isIsoDate(f.updated)) errors.push(`${where}: updated is not a YYYY-MM-DD date`);
    if (f.tendencies !== undefined && !isStringList(f.tendencies)) errors.push(`${where}: tendencies is not a list of strings`);
    // auto: true marks a family a script added with no data about it yet.
    if (f.auto !== undefined && typeof f.auto !== 'boolean') errors.push(`${where}: auto is not true or false`);
    checkSources(f.sources, where);
  });
  return errors;
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

async function refreshed({ file, key, readFile, writeFile, now, offline, force, load, warnings, label }) {
  const cache = tryReadJson(readFile, file);
  if (cache && !force && now - cache.fetchedAt < DAY) return { value: cache[key], from: 'cache' };
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

// A family without a usable date counts as stale.
export const isStale = (family, now) => !(now - Date.parse(family.updated) <= STALE_AFTER);

// force: skip the daily caches (foreman knowledge refresh).
export async function loadKnowledge({ paths, fetchImpl = fetch, readFile, writeFile, now = Date.now(), knowledgeUrl = null, offline = false, force = false }) {
  const warnings = [];
  let knowledge = BUILTIN;
  let source = 'builtin';

  if (knowledgeUrl) {
    const remote = await refreshed({
      file: paths.knowledgeCache, key: 'data', readFile, writeFile, now, offline, force, warnings, label: 'knowledge',
      load: () => fetchJson(fetchImpl, knowledgeUrl),
    });
    const problems = remote.value ? validateKnowledge(remote.value) : [];
    if (problems.length) {
      warnings.push(`knowledge from ${knowledgeUrl} is invalid, the built-in copy is used: ${problems.slice(0, 3).join('; ')}`);
    } else if (remote.value?.updated && remote.value.updated > BUILTIN.updated) {
      // A newer full copy: its rules replace the built-in ones, families merge by id.
      knowledge = mergeKnowledge(BUILTIN, remote.value, { appendRules: false });
      source = remote.from;
    }
  }

  const overrides = readOptionalJson(readFile, paths.overrides, warnings, 'knowledge override');
  if (overrides !== null) {
    const merged = isObject(overrides) ? mergeKnowledge(knowledge, overrides) : null;
    const problems = merged ? validateKnowledge(merged) : ['it is not a JSON object'];
    if (problems.length) warnings.push(`knowledge override ${paths.overrides} ignored: ${problems.slice(0, 3).join('; ')}`);
    else knowledge = merged;
  }

  knowledge = {
    ...knowledge,
    families: (knowledge.families ?? []).map((f) => ({ ...f, stale: isStale(f, now) })),
  };

  const dev = await refreshed({
    file: paths.modelsDevCache, key: 'index', readFile, writeFile, now, offline, force, warnings, label: 'models.dev',
    load: async () => indexModelsDev(await fetchJson(fetchImpl, MODELS_DEV_URL)),
  });

  return { knowledge, source, modelsDev: dev.value ?? {}, warnings };
}

// What foreman knows now, for foreman knowledge show, refresh and stale.
export function describeKnowledge({ knowledge, source, warnings }, { knowledgeUrl = null } = {}) {
  const families = knowledge.families ?? [];
  return {
    source,
    url: knowledgeUrl || null,
    updated: knowledge.updated,
    builtinUpdated: BUILTIN.updated,
    harnesses: Object.keys(knowledge.harnesses ?? {}).length,
    families: families.length,
    stale: families.filter((f) => f.stale).map((f) => ({ id: f.id, updated: f.updated ?? null, ...(f.auto ? { auto: true } : {}) })),
    auto: families.filter((f) => f.auto).map((f) => f.id),
    warnings,
  };
}

export function builtinKnowledge() {
  return BUILTIN;
}
