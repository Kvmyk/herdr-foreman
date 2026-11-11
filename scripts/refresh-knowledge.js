#!/usr/bin/env node
// Weekly refresh of knowledge/agents.json, meant for the GitHub Action in
// .github/workflows/refresh-knowledge.yml but runnable by hand:
//   node scripts/refresh-knowledge.js
// No LLM and no API key. Every claim in the file is a dated fact from a renewable
// source: benchmark records from scripts/knowledge-sources/ (families[].facts,
// harnesses[].facts and the tendencies generated from them), harness releases from
// the npm registry, the newest model per family from models.dev. A source that stops
// updating or keeps failing is frozen and its facts are dropped. New first-party
// models from models.dev get a stub family and every source URL is link-checked.
// Network access is injected (fetchImpl) so the functions are testable.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { familyFor, MODELS_DEV_URL } from '../src/knowledge.js';

const DAY = 24 * 3600 * 1000;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KNOWLEDGE_FILE = `${ROOT}knowledge/agents.json`;
const LOG_FILE = `${ROOT}docs/research/knowledge-log.md`;

export const FIRST_PARTY = ['anthropic', 'openai', 'google', 'alibaba', 'zhipuai', 'moonshotai', 'deepseek', 'xai'];
export const NEW_MODEL_WINDOW = 365 * DAY;
const NOT_CODING = /embed|tts|image|audio|transcribe|live|moderation|whisper|realtime|speech|vision|ocr/i;
const MAX_TENDENCIES = 6;
const MAX_FACTS = 8;
export const NPM_PACKAGES = Object.freeze({
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
  pi: '@earendil-works/pi-coding-agent',
  opencode: 'opencode-ai',
});
const HARNESS_NAMES = { claude: 'Claude Code', codex: 'Codex CLI', opencode: 'opencode', agy: 'Antigravity CLI', gemini: 'Gemini CLI', pi: 'pi' };

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Same shape familyFor() tests a match against: dots are kept.
const matchForm = (id) => id.toLowerCase().replace(/[\s_]+/g, '-').split('/').pop();
const normalize = (id) => id.toLowerCase().split('/').pop().replace(/[\s_.]+/g, '-');

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- Part A: new models -------------------------------------------------

function commonPrefix(ids) {
  let p = ids[0];
  for (const id of ids) while (!id.startsWith(p)) p = p.slice(0, -1);
  return p.replace(/-+$/, '');
}

// Vendor and product words that say nothing about which model a stub covers.
const GENERIC = new Set([...FIRST_PARTY, 'claude', 'gpt', 'gemini', 'qwen', 'glm', 'kimi', 'grok', 'llama', 'mistral', 'o']);
const VENDOR_SUFFIX = new RegExp(`-(${[...FIRST_PARTY, 'meta', 'mistral', 'microsoft'].join('|')})$`);
const ALIAS = /-latest$/;
const DATED = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

const stripVendor = (id) => id.replace(VENDOR_SUFFIX, '');

function groupKey(provider, m) {
  const family = m.family ? normalize(m.family) : normalize(m.id).replace(/-\d[\w-]*$/, '');
  return { family: family || normalize(m.id), key: `${provider}:${family}` };
}

// The match covers exactly the group's concrete ids: the family word when it is
// distinctive, else their longest common prefix when it carries a version, else
// the escaped ids. Never a bare vendor or product word.
function buildMatch(ids, family) {
  const covers = (re) => ids.every((id) => new RegExp(re, 'i').test(id));
  const prefix = ids.length > 1 ? commonPrefix(ids) : '';
  const candidates = [
    GENERIC.has(family) ? null : escapeRe(family),
    prefix && /\d/.test(prefix) && !GENERIC.has(prefix) ? escapeRe(prefix) : null,
  ];
  for (const candidate of candidates) if (candidate && covers(candidate)) return candidate;
  return ids.map(escapeRe).join('|');
}

// Canonical ids of a group: no aliases (*-latest, *-preview-latest) and no dated
// copy of an id that is also listed.
function canonicalIds(ids) {
  return ids.filter((id) => !ALIAS.test(id) && !(DATED.test(id) && ids.includes(id.replace(DATED, ''))));
}

// New first-party text models released within the window that no family matches,
// grouped into one stub family per provider and models.dev family. Returns
// { stubs, review }; review lists the uncovered ids that were not turned into a
// stub (alias only, or a variant of an existing family) and need a manual look.
export function analyzeNewModels(knowledge, api, { now = Date.now(), providers = FIRST_PARTY } = {}) {
  const groups = new Map();
  for (const provider of providers) {
    for (const m of Object.values(api?.[provider]?.models ?? {})) {
      const released = Date.parse(m.release_date ?? '');
      if (!m.id || Number.isNaN(released) || now - released > NEW_MODEL_WINDOW) continue;
      if (NOT_CODING.test(m.id) || (m.modalities?.output && m.modalities.output.join() !== 'text')) continue;
      if (familyFor(knowledge, m.id)) continue;
      const { family, key } = groupKey(provider, m);
      if (!groups.has(key)) groups.set(key, { provider, family, derived: normalize(m.id).replace(/-\d[\w-]*$/, ''), models: [] });
      groups.get(key).models.push(m.id);
    }
  }
  const taken = new Set((knowledge.families ?? []).map((f) => f.id));
  const stubs = [];
  const review = [];
  for (const { provider, family, derived, models } of groups.values()) {
    const id = stripVendor(family);
    const variant = [family, id, derived, stripVendor(derived)].some((c) => taken.has(c));
    if (variant) {
      review.push({ family, provider, models, reason: `variant of existing family ${[family, id, derived, stripVendor(derived)].find((c) => taken.has(c))}` });
      continue;
    }
    const ids = canonicalIds(models.map(matchForm));
    if (!ids.length) {
      review.push({ family, provider, models, reason: 'only alias ids (*-latest)' });
      continue;
    }
    taken.add(id);
    stubs.push({
      id,
      vendor: provider,
      match: buildMatch(ids, id),
      updated: isoDay(now),
      tendencies: [],
      sources: [],
      auto: true,
      models: models.filter((m) => ids.includes(matchForm(m))),
    });
  }
  return { stubs, review };
}

export const detectNewModels = (knowledge, api, options) => analyzeNewModels(knowledge, api, options).stubs;

// ---- Part A: source URLs ------------------------------------------------

export const sourceUrl = (s) => (typeof s === 'string' ? s : s?.url);

export async function checkSources(sources, fetchImpl, { timeoutMs = 10000, concurrency = 4 } = {}) {
  const headers = { 'user-agent': 'herdr-foreman-knowledge-refresh' };
  const attempt = async (url, method, extra = {}) => {
    const res = await fetchImpl(url, {
      method, headers: { ...headers, ...extra }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
    });
    return res;
  };
  const entries = Object.entries(sources ?? {});
  return mapLimit(entries, concurrency, async ([id, source]) => {
    const url = sourceUrl(source);
    let res;
    let error = null;
    try {
      res = await attempt(url, 'HEAD');
      if ([403, 405, 501].includes(res.status)) res = await attempt(url, 'GET', { range: 'bytes=0-0' });
    } catch {
      try {
        res = await attempt(url, 'GET', { range: 'bytes=0-0' });
      } catch (err) {
        error = err.message;
      }
    }
    const status = res?.status ?? null;
    const ok = status !== null && status >= 200 && status < 400;
    const moved = ok && Boolean(res.url) && res.url !== new URL(url).href;
    const verdict = error ? 'unreachable' : [404, 410].includes(status) ? 'dead' : ok ? (moved ? 'moved' : 'ok') : 'error';
    return { id, url, status, verdict, ...(moved ? { finalUrl: res.url } : {}), ...(error ? { error } : {}) };
  });
}

// ---- Facts --------------------------------------------------------------

const daysBetween = (a, b) => (Date.parse(a) - Date.parse(b)) / DAY;
const number = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

// 'SWE Atlas refactoring (refactor), claude-opus-5.5: 77.1% (#1 of 16, 2026-11-06)'
// 'Agent Arena, claude-opus-5.5: #3 of 55 (2026-11-08)' when the board has no comparable score.
export function factText(r) {
  const model = r.effort ? `${r.model} (${r.effort})` : r.model;
  const head = `${r.benchmark}${r.category ? ` (${r.category})` : ''}, ${model}`;
  const rank = Number.isFinite(r.rank) ? (Number.isFinite(r.of) ? `#${r.rank} of ${r.of}` : `#${r.rank}`) : null;
  const harness = r.harness ? `with ${HARNESS_NAMES[r.harness] ?? r.harness}` : null;
  if (Number.isFinite(r.score)) {
    const score = r.unit === '%' ? `${number(r.score)}%` : r.unit ? `${number(r.score)} ${r.unit}` : number(r.score);
    return `${head}: ${score} (${[rank, harness, r.date].filter(Boolean).join(', ')})`;
  }
  return `${head}: ${[rank ?? 'listed', harness].filter(Boolean).join(' ')} (${r.date})`;
}

export function toFact(r) {
  return {
    text: factText(r), benchmark: r.benchmark, model: r.model, ...(r.effort ? { effort: r.effort } : {}),
    score: r.score ?? null, unit: r.unit ?? null, rank: r.rank ?? null, of: r.of ?? null,
    harness: r.harness ?? null, category: r.category ?? null, date: r.date, source: r.source,
  };
}

// rank / of, 0 is the best; a fact without a rank counts as the worst.
const relative = (f) => (Number.isFinite(f.rank) && Number.isFinite(f.of) && f.of > 0 ? f.rank / f.of : 1);
const byRank = (a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (b.score ?? 0) - (a.score ?? 0) || b.date.localeCompare(a.date) || b.model.localeCompare(a.model, 'en', { numeric: true });
const byRelative = (a, b) => relative(a) - relative(b) || byRank(a, b);

// The best-ranked fact of each group; ties go to the newer model.
function bestPer(facts, keyOf) {
  const best = new Map();
  for (const f of facts) {
    const key = keyOf(f);
    const cur = best.get(key);
    if (!cur || byRank(f, cur) < 0) best.set(key, f);
  }
  return [...best.values()];
}

// A family keeps one fact per benchmark (and category): the one of its best-ranked model.
// Harness pairs and category facts come first, then by relative rank; at most MAX_FACTS.
export function selectFamilyFacts(facts, max = MAX_FACTS) {
  const picked = bestPer(facts, (f) => [f.source, f.benchmark, f.category ?? ''].join('|'));
  const specific = (f) => (f.harness || f.category ? 0 : 1);
  return picked.sort((a, b) => specific(a) - specific(b) || byRelative(a, b)).slice(0, max);
}

// A harness keeps, per benchmark and model family, its best-ranked pair; best relative rank first.
export function selectHarnessFacts(items, max = MAX_FACTS) {
  const picked = bestPer(items, (f) => [f.source, f.benchmark, f.category ?? '', f.family].join('|'));
  return picked.sort(byRelative).slice(0, max);
}

export const pickTendencies = (facts, max = MAX_TENDENCIES) => facts.slice(0, max);

const newest = (facts) => facts.reduce((m, f) => (f.date > m ? f.date : m), '');

// Replaces the facts of every source that answered and is not frozen; keeps the
// facts of a source that failed once; drops those of a frozen source. Mutates next.
// status[id].newest is the last time the source itself changed.
// Returns { frozen: [{id, reason}], unmatched: [{model, source}] }.
export function applyFacts(next, { records = [], status = {} }, sourceList, today) {
  const frozen = [];
  const unmatched = [];
  const meta = (next.sourceMeta ??= {});
  const live = new Set();
  const keep = new Set();
  for (const s of sourceList) {
    const st = status[s.id] ?? { ok: false, newest: null, count: 0, error: 'no status returned' };
    const before = meta[s.id];
    const age = st.newest ? daysBetween(today, st.newest) : null;
    let reason = null;
    if (!st.ok) {
      if (before?.ok === false) reason = `returned ok false twice in a row${st.error ? ` (${st.error})` : ''}`;
      else keep.add(s.id);
    } else if (age === null) {
      reason = 'returned no dated record';
    } else if (age > s.ttlDays) {
      reason = `last changed ${st.newest}, more than ${s.ttlDays} days ago`;
    }
    if (reason) frozen.push({ id: s.id, reason });
    else if (st.ok) live.add(s.id);
    next.sources[s.id] = s.url;
    meta[s.id] = {
      title: s.title, kind: s.kind, licence: s.licence, ttlDays: s.ttlDays,
      newest: st.ok ? st.newest : before?.newest ?? null, checked: today, ok: Boolean(st.ok),
    };
  }

  const fresh = new Map();
  const add = (key, fact) => (fresh.get(key) ?? fresh.set(key, []).get(key)).push(fact);
  const seenUnmatched = new Set();
  for (const r of records) {
    if (!live.has(r.source)) continue;
    const family = familyFor(next, r.model);
    if (!family) {
      const k = `${r.model}|${r.source}`;
      if (!seenUnmatched.has(k)) unmatched.push({ model: r.model, source: r.source });
      seenUnmatched.add(k);
      continue;
    }
    const fact = toFact(r);
    add(`family:${family.id}`, fact);
    if (r.harness && next.harnesses?.[r.harness]) add(`harness:${r.harness}`, { ...fact, family: family.id });
  }

  const kept = (owner) => (owner.facts ?? []).filter((f) => keep.has(f.source));
  const strip = ({ family, ...fact }) => fact;
  for (const f of next.families ?? []) {
    const facts = selectFamilyFacts([...kept(f), ...(fresh.get(`family:${f.id}`) ?? [])]);
    if (facts.length) f.facts = facts;
    else delete f.facts;
    f.tendencies = pickTendencies(facts).map((x) => x.text);
    f.sources = [...new Set(facts.map((x) => x.source))];
    if (facts.length) f.updated = newest(facts);
  }
  for (const [kind, h] of Object.entries(next.harnesses ?? {})) {
    const old = kept(h).map((fact) => ({ ...fact, family: familyFor(next, fact.model)?.id ?? fact.model }));
    const facts = selectHarnessFacts([...old, ...(fresh.get(`harness:${kind}`) ?? [])]).map(strip);
    if (facts.length) h.facts = facts;
    else delete h.facts;
  }
  return { frozen, unmatched };
}

// ---- Harness releases and newest models ----------------------------------

const npmUrl = (pkg) => `https://registry.npmjs.org/${pkg.replace('/', '%2F')}`;

// harnesses.<kind>.release from the npm registry: dist-tags.latest and its publish time.
// A package that cannot be read keeps its old release and adds a warning.
export async function fetchReleases(fetchImpl, packages = NPM_PACKAGES) {
  const releases = {};
  const warnings = [];
  await mapLimit(Object.entries(packages), 4, async ([kind, pkg]) => {
    try {
      const res = await fetchImpl(npmUrl(pkg), { headers: { 'user-agent': 'herdr-foreman-knowledge-refresh' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await res.json();
      const version = doc?.['dist-tags']?.latest;
      const date = typeof doc?.time?.[version] === 'string' ? doc.time[version].slice(0, 10) : null;
      if (!version || !date) throw new Error('no latest version');
      releases[kind] = { version, date, source: 'npm' };
    } catch (err) {
      warnings.push(`npm ${pkg} not read: ${err.message}`);
    }
  });
  return { releases, warnings };
}

// Tool calling and text output only: no image, video, audio or embedding models.
const canDoTheWork = (m) => m.tool_call === true && !NOT_CODING.test(m.id) && (!m.modalities?.output || m.modalities.output.join() === 'text');

// families[].latest: the newest first-party model of each family on models.dev.
export function latestModels(knowledge, api, providers = FIRST_PARTY) {
  const latest = {};
  for (const provider of providers) {
    for (const m of Object.values(api?.[provider]?.models ?? {})) {
      if (!m.id || !/^\d{4}-\d{2}-\d{2}$/.test(m.release_date ?? '') || !canDoTheWork(m)) continue;
      const family = familyFor(knowledge, m.id);
      if (!family) continue;
      const cur = latest[family.id];
      if (!cur || m.release_date > cur.date || (m.release_date === cur.date && m.id < cur.id)) latest[family.id] = { id: m.id, date: m.release_date };
    }
  }
  return latest;
}

// ---- Orchestration ------------------------------------------------------

// The file without the dates that change on every run, to tell whether anything real changed.
const comparable = (k) => JSON.stringify({ ...k, updated: null }, (key, v) => (key === 'checked' ? undefined : v));

// collectFacts and sourceList come from scripts/knowledge-sources/ (injected, so tests need no network).
export async function refresh({ knowledge, api, fetchImpl, collectFacts = null, sourceList = [], packages = NPM_PACKAGES, now = Date.now() }) {
  const warnings = [];
  const next = structuredClone(knowledge);
  const today = isoDay(now);
  next.sources ??= {};
  next.sources.npm ??= 'https://registry.npmjs.org/';
  next.sources['models-dev'] ??= MODELS_DEV_URL;

  const { stubs, review } = analyzeNewModels(next, api, { now });
  for (const { models, ...stub } of stubs) next.families.push(stub);

  let frozen = [];
  let unmatched = [];
  if (collectFacts) {
    const collected = await collectFacts({ fetchImpl, now });
    ({ frozen, unmatched } = applyFacts(next, collected, sourceList, today));
  }

  const { releases, warnings: npmWarnings } = await fetchReleases(fetchImpl, packages);
  warnings.push(...npmWarnings);
  const releaseChanges = [];
  for (const [kind, release] of Object.entries(releases)) {
    const h = next.harnesses?.[kind];
    if (!h) continue;
    if (h.release?.version !== release.version) releaseChanges.push({ kind, from: h.release?.version ?? null, to: release.version });
    h.release = release;
  }
  const meta = (next.sourceMeta ??= {});
  const releaseDates = Object.values(releases).map((r) => r.date).sort();
  meta.npm = {
    title: 'npm registry (harness releases)', kind: 'data', licence: 'public package metadata', ttlDays: 30,
    newest: releaseDates.at(-1) ?? meta.npm?.newest ?? null, checked: today, ok: Object.keys(releases).length > 0,
  };

  const latest = latestModels(next, api);
  for (const f of next.families) if (latest[f.id]) f.latest = latest[f.id];
  const modelDates = FIRST_PARTY.flatMap((p) => Object.values(api?.[p]?.models ?? {}).map((m) => m.release_date)).filter(Boolean).sort();
  meta['models-dev'] = {
    title: 'models.dev model catalog', kind: 'data', licence: 'MIT', ttlDays: 30,
    newest: modelDates.at(-1) ?? meta['models-dev']?.newest ?? null, checked: today, ok: modelDates.length > 0,
  };

  const links = await checkSources(next.sources, fetchImpl);

  const changed = comparable(next) !== comparable(knowledge);
  if (changed) next.updated = today;
  return { knowledge: next, changed, stubs, review, links, frozen, unmatched, releaseChanges, warnings, today };
}

export function renderLogEntry(result) {
  const lines = [`## ${result.today}`, ''];
  for (const s of result.stubs) lines.push(`- New unverified family \`${s.id}\` (${s.vendor}, match \`${s.match}\`) for: ${s.models.join(', ')}.`);
  for (const r of result.review ?? []) lines.push(`- Needs a manual look, no stub added (${r.reason}): ${r.models.join(', ')} (${r.provider}, models.dev family \`${r.family}\`).`);
  for (const f of result.frozen ?? []) lines.push(`- Source \`${f.id}\` is frozen, its facts were dropped: ${f.reason}.`);
  if (result.unmatched?.length) {
    lines.push('- Facts for models no family matches (not stored; add a family or fix the model id):');
    for (const u of result.unmatched) lines.push(`  - \`${u.model}\` (${u.source})`);
  }
  for (const c of result.releaseChanges ?? []) lines.push(`- Harness \`${c.kind}\` release ${c.from ?? 'unknown'} -> ${c.to}.`);
  const bad = result.links.filter((l) => !['ok', 'moved'].includes(l.verdict));
  const moved = result.links.filter((l) => l.verdict === 'moved');
  const linkLine = (l) => `  - \`${l.id}\` ${l.verdict}${l.status ? ` (HTTP ${l.status})` : ''}${l.finalUrl ? ` -> ${l.finalUrl}` : ''}${l.error ? ` (${l.error})` : ''}: ${l.url}`;
  if (bad.length) {
    lines.push('- Source links needing attention (none removed automatically):');
    for (const l of bad) lines.push(linkLine(l));
  }
  if (moved.length) {
    lines.push('- Note: source links that redirect (still reachable, consider updating the URL):');
    for (const l of moved) lines.push(linkLine(l));
  }
  for (const w of result.warnings) lines.push(`- Warning: ${w}`);
  return `${lines.join('\n')}\n`;
}

// Same layout as the hand-edited file: arrays of strings inline, except "rules";
// facts, releases, latest models and source metadata are one line each.
export function serializeKnowledge(value) {
  const scalar = (v) => v === null || typeof v !== 'object';
  const walk = (v, indent, key) => {
    if (v !== null && typeof v === 'object' && ['inline', 'release', 'latest'].includes(key)) return JSON.stringify(v);
    const pad = '  '.repeat(indent + 1);
    const close = '  '.repeat(indent);
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      if (v.every(scalar) && key !== 'rules') return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      return `[\n${v.map((x) => pad + walk(x, indent + 1, key === 'facts' ? 'inline' : undefined)).join(',\n')}\n${close}]`;
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v);
      if (!entries.length) return '{}';
      return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${walk(x, indent + 1, key === 'sourceMeta' ? 'inline' : k)}`).join(',\n')}\n${close}}`;
    }
    return JSON.stringify(v);
  };
  return `${walk(value, 0)}\n`;
}

async function main() {
  const knowledge = JSON.parse(readFileSync(KNOWLEDGE_FILE, 'utf8'));
  const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`);
  let collectFacts = null;
  let sourceList = [];
  try {
    ({ collectFacts, SOURCES: sourceList } = await import('./knowledge-sources/index.js'));
  } catch (err) {
    console.log(`warning: benchmark sources not loaded, facts are left as they are: ${err.message}`);
  }
  const result = await refresh({ knowledge, api: await res.json(), fetchImpl: fetch, collectFacts, sourceList });

  const annotate = process.env.GITHUB_ACTIONS ? '::warning::' : 'warning: ';
  const notice = process.env.GITHUB_ACTIONS ? '::notice::' : 'note: ';
  for (const l of result.links.filter((x) => !['ok', 'moved'].includes(x.verdict))) console.log(`${annotate}source ${l.id} ${l.verdict} ${l.status ?? ''} ${l.url}`);
  for (const l of result.links.filter((x) => x.verdict === 'moved')) console.log(`${notice}source ${l.id} moved to ${l.finalUrl}`);
  for (const r of result.review) console.log(`${notice}no stub for ${r.models.join(', ')}: ${r.reason}`);
  for (const f of result.frozen) console.log(`${annotate}source ${f.id} is frozen: ${f.reason}`);
  for (const w of result.warnings) console.log(`${annotate}${w}`);

  if (!result.changed) {
    console.log('knowledge is up to date; nothing to write');
    return;
  }
  writeFileSync(KNOWLEDGE_FILE, serializeKnowledge(result.knowledge));
  const header = '# Knowledge log\n\nWhat each refresh of `knowledge/agents.json` changed, newest last. Written by `scripts/refresh-knowledge.js`.\n\n';
  const log = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : header;
  writeFileSync(LOG_FILE, `${log.replace(/\n*$/, '\n\n')}${renderLogEntry(result)}`);
  console.log(`knowledge written; see ${LOG_FILE.replace(ROOT, '')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
