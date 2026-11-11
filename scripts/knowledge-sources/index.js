// Renewable, script-readable sources of model quality for knowledge/agents.json.
// Each source reads its own leaderboard through the injected fetchImpl and
// returns records; collectFacts() runs them all, never throws, and reports a
// status per source. A source that fails or changes format returns ok: false
// and no records, so a wrong number never reaches the knowledge file.
//
// Record: {source, benchmark, model, vendor, harness, effort, score, unit, rank, of, date, category}
//   model    normalised lower-case id with dots kept (claude-opus-5.5, gpt-6.1-sol)
//   harness  foreman kind (claude, codex, opencode, agy, gemini, pi) or null
//   unit     '%' or 'elo'; null together with score when a board has no comparable number
//   rank/of  position among the records of the same source, benchmark and category,
//            after keeping the best effort variant per model and harness
import { CATEGORIES, HARNESS_KINDS, isoDay } from './normalise.js';
import lmarenaWebdev from './lmarena-webdev.js';
import lmarenaAgent from './lmarena-agent.js';
import epoch from './epoch.js';
import livebench from './livebench.js';
import tbench from './tbench.js';
import vals from './vals.js';
import seal from './seal.js';

export const DEFAULT_TTL_DAYS = 45;

export const SOURCES = [lmarenaWebdev, lmarenaAgent, epoch, livebench, tbench, vals, seal]
  .map((s) => ({ ttlDays: DEFAULT_TTL_DAYS, ...s }));

const MODEL_ID = /^[a-z0-9][a-z0-9.+-]*$/;

function checkRecord(r, id) {
  const bad = (what) => { throw new Error(`${id}: ${what} in ${JSON.stringify(r)}`); };
  if (r.source !== id) bad('wrong source');
  if (typeof r.benchmark !== 'string' || !r.benchmark) bad('no benchmark');
  if (typeof r.model !== 'string' || !MODEL_ID.test(r.model)) bad('bad model');
  if (r.vendor !== null && typeof r.vendor !== 'string') bad('bad vendor');
  if (r.harness !== null && !HARNESS_KINDS.includes(r.harness)) bad('bad harness');
  if (r.effort !== null && typeof r.effort !== 'string') bad('bad effort');
  if (r.category !== null && !CATEGORIES.includes(r.category)) bad('bad category');
  if (isoDay(r.date) !== r.date) bad('bad date');
  if (r.unit === null) {
    if (r.score !== null || typeof r.order !== 'number' || !Number.isFinite(r.order)) bad('unitless record without order');
  } else if (r.unit === '%') {
    if (typeof r.score !== 'number' || !(r.score >= 0 && r.score <= 100)) bad('bad percentage');
  } else if (r.unit === 'elo') {
    if (typeof r.score !== 'number' || !Number.isFinite(r.score)) bad('bad rating');
  } else bad('bad unit');
}

const value = (r) => r.score ?? r.order;

// Best effort variant per model, harness, benchmark and category; then ranks
// (ties share a rank) within each source, benchmark and category.
export function finalise(records) {
  const best = new Map();
  for (const r of records) {
    const key = [r.source, r.benchmark, r.category, r.model, r.harness].join('|');
    const seen = best.get(key);
    if (!seen || value(r) > value(seen)) best.set(key, r);
  }
  const groups = new Map();
  for (const r of best.values()) {
    const key = [r.source, r.benchmark, r.category].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const group of groups.values()) {
    group.sort((a, b) => value(b) - value(a) || a.model.localeCompare(b.model));
    group.forEach((r, i) => {
      const rank = i > 0 && value(group[i - 1]) === value(r) ? out[out.length - 1].rank : i + 1;
      const { order, ...rest } = r;
      out.push({
        source: rest.source, benchmark: rest.benchmark, model: rest.model, vendor: rest.vendor, harness: rest.harness,
        effort: rest.effort, score: rest.score, unit: rest.unit, rank, of: group.length, date: rest.date, category: rest.category,
      });
    });
  }
  return out;
}

export async function readSource(source, { fetchImpl, now }) {
  try {
    const raw = await source.read({ fetchImpl, now, ttlDays: source.ttlDays });
    if (!Array.isArray(raw) || !raw.length) throw new Error(`${source.id}: no records`);
    for (const r of raw) checkRecord(r, source.id);
    const records = finalise(raw);
    const newest = records.map((r) => r.date).sort().pop();
    return { records, status: { ok: true, newest, count: records.length } };
  } catch (err) {
    return { records: [], status: { ok: false, newest: null, count: 0, error: String(err?.message ?? err) } };
  }
}

export async function collectFacts({ fetchImpl = globalThis.fetch, now = Date.now(), sources = SOURCES } = {}) {
  const results = await Promise.all(sources.map((s) => readSource(s, { fetchImpl, now })));
  const records = [];
  const status = {};
  results.forEach((res, i) => {
    records.push(...res.records);
    status[sources[i].id] = res.status;
  });
  return { records, status };
}
