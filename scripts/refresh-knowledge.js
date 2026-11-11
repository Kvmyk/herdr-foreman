#!/usr/bin/env node
// Weekly refresh of knowledge/agents.json, meant for the GitHub Action in
// .github/workflows/refresh-knowledge.yml but runnable by hand:
//   node scripts/refresh-knowledge.js
// Part A needs no LLM: it adds stub families for new first-party models from
// models.dev and checks every source URL. Part B runs only when GEMINI_API_KEY
// is set: Gemini rewrites a family's text tendencies from its own source pages,
// and the answer is dropped unless it passes strict validation.
// Network access is injected (fetchImpl) so the functions are testable.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { familyFor, MODELS_DEV_URL } from '../src/knowledge.js';

const DAY = 24 * 3600 * 1000;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KNOWLEDGE_FILE = `${ROOT}knowledge/agents.json`;
const CHANGELOG_FILE = `${ROOT}CHANGELOG.md`;
const LOG_FILE = `${ROOT}docs/research/knowledge-log.md`;

export const FIRST_PARTY = ['anthropic', 'openai', 'google', 'alibaba', 'zhipuai', 'moonshotai', 'deepseek', 'xai'];
export const NEW_MODEL_WINDOW = 365 * DAY;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const FALLBACK_GEMINI_MODEL = 'gemini-3.6-flash';
const NOT_CODING = /embed|tts|image|audio|transcribe|live|moderation|whisper|realtime|speech|vision|ocr/i;
const PAGE_CAP = 12000;
const MAX_TENDENCIES = 4;
const MAX_TENDENCY_LENGTH = 200;

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

// ---- Part B: Gemini -----------------------------------------------------

export function stripHtml(html, cap = PAGE_CAP) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

export const geminiSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    match: { type: 'string' },
    vendor: { type: 'string' },
    tendencies: { type: 'array', maxItems: MAX_TENDENCIES, items: { type: 'string', maxLength: MAX_TENDENCY_LENGTH } },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'match', 'vendor', 'tendencies', 'sources'],
};

export const SYSTEM_PROMPT = [
  'You maintain a short fact sheet about one AI model family for coding agents.',
  'The user message is JSON: the current entry, the ids of allowed sources and the text of those source pages.',
  'Rewrite "tendencies" (at most 4 short sentences, each under 200 characters) using ONLY facts stated in the provided JSON.',
  'Never introduce a number, benchmark score or model name that does not appear in the provided JSON.',
  'If the pages do not support a change, return the current tendencies unchanged.',
  'Return the same id, match and vendor as given. In "sources" list only ids from allowedSources.',
  'Answer with JSON only.',
].join(' ');

const numbersIn = (text) => new Set((String(text).match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '.')));

// Returns { ok: true, entry } or { ok: false, reason }.
export function validateAnswer(text, family, input, sourceIds) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return { ok: false, reason: 'not an object' };
  for (const k of ['id', 'match', 'vendor']) {
    if (answer[k] !== family[k]) return { ok: false, reason: `${k} changed` };
  }
  const { tendencies, sources } = answer;
  if (!Array.isArray(tendencies) || tendencies.length > MAX_TENDENCIES
    || tendencies.some((t) => typeof t !== 'string' || !t.trim() || t.length > MAX_TENDENCY_LENGTH)) {
    return { ok: false, reason: 'tendencies fail the schema' };
  }
  if (!Array.isArray(sources) || sources.some((s) => typeof s !== 'string' || !sourceIds.includes(s))) {
    return { ok: false, reason: 'cites an unknown source id' };
  }
  const known = numbersIn(JSON.stringify(input));
  for (const n of numbersIn(tendencies.join(' '))) {
    if (!known.has(n)) return { ok: false, reason: `number ${n} is not in the input` };
  }
  return { ok: true, entry: { tendencies, sources } };
}

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function generate(fetchImpl, apiKey, model, input) {
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: geminiSchema },
    }),
  });
  if (!res.ok) throw new GeminiError(`Gemini ${model} returned HTTP ${res.status}`, res.status);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
}

// One fallback model, only when the first one does not exist (404).
export async function callGemini({ fetchImpl, apiKey, model, fallback = FALLBACK_GEMINI_MODEL, input }) {
  try {
    return { text: await generate(fetchImpl, apiKey, model, input), model };
  } catch (err) {
    if (!(err instanceof GeminiError) || err.status !== 404 || !fallback || fallback === model) throw err;
    return { text: await generate(fetchImpl, apiKey, fallback, input), model: fallback };
  }
}

async function pageText(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'herdr-foreman-knowledge-refresh' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return stripHtml(await res.text());
  } catch {
    return null;
  }
}

// Returns { changes: [{id, before, after, model}], warnings, skipped }.
// Any API error skips part B as a whole: nothing partial is applied.
export async function rewriteTendencies({ knowledge, fetchImpl, apiKey, model = DEFAULT_GEMINI_MODEL }) {
  const warnings = [];
  const changes = [];
  const sourceIds = Object.keys(knowledge.sources ?? {});
  try {
    for (const family of knowledge.families ?? []) {
      const ids = (family.sources ?? []).filter((s) => knowledge.sources?.[s]);
      const pages = (await mapLimit(ids, 4, async (id) => ({ id, text: await pageText(fetchImpl, sourceUrl(knowledge.sources[id])) })))
        .filter((p) => p.text);
      if (!pages.length) continue;
      const input = {
        family: { id: family.id, match: family.match, vendor: family.vendor, tendencies: family.tendencies },
        allowedSources: sourceIds,
        pages,
      };
      const { text, model: used } = await callGemini({ fetchImpl, apiKey, model, input });
      const verdict = validateAnswer(text, family, input, sourceIds);
      if (!verdict.ok) {
        warnings.push(`gemini answer for ${family.id} rejected: ${verdict.reason}`);
        continue;
      }
      const { tendencies, sources } = verdict.entry;
      if (JSON.stringify(tendencies) === JSON.stringify(family.tendencies)
        && JSON.stringify(sources) === JSON.stringify(family.sources)) continue;
      changes.push({ id: family.id, before: family.tendencies, after: tendencies, sources, model: used });
    }
  } catch (err) {
    return { changes: [], warnings: [...warnings, `part B skipped: ${err.message}`], skipped: true };
  }
  return { changes, warnings, skipped: false };
}

// ---- Orchestration ------------------------------------------------------

export async function refresh({ knowledge, api, fetchImpl, env = {}, now = Date.now() }) {
  const warnings = [];
  const next = structuredClone(knowledge);
  const today = isoDay(now);

  const { stubs, review } = analyzeNewModels(next, api, { now });
  for (const { models, ...stub } of stubs) next.families.push(stub);

  const links = await checkSources(next.sources, fetchImpl);

  let rewrites = { changes: [], warnings: [], skipped: true };
  if (env.GEMINI_API_KEY) {
    rewrites = await rewriteTendencies({
      knowledge: next, fetchImpl, apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    });
    warnings.push(...rewrites.warnings);
    for (const c of rewrites.changes) {
      const f = next.families.find((x) => x.id === c.id);
      f.tendencies = c.after;
      f.sources = c.sources;
      f.updated = today;
      f.auto = true;
    }
  }

  const changed = stubs.length > 0 || rewrites.changes.length > 0;
  if (changed) next.updated = today;
  return { knowledge: next, changed, stubs, review, links, rewrites, warnings, today };
}

export function renderLogEntry(result) {
  const lines = [`## ${result.today}`, ''];
  for (const s of result.stubs) lines.push(`- New unverified family \`${s.id}\` (${s.vendor}, match \`${s.match}\`) for: ${s.models.join(', ')}.`);
  for (const r of result.review ?? []) lines.push(`- Needs a manual look, no stub added (${r.reason}): ${r.models.join(', ')} (${r.provider}, models.dev family \`${r.family}\`).`);
  for (const c of result.rewrites.changes) {
    lines.push(`- Gemini (${c.model}) rewrote \`${c.id}\`:`);
    lines.push(`  - old: ${JSON.stringify(c.before)}`);
    lines.push(`  - new: ${JSON.stringify(c.after)}`);
  }
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

export function changelogLine(result) {
  const parts = [];
  if (result.stubs.length) parts.push(`${result.stubs.length} new unverified model ${result.stubs.length === 1 ? 'family' : 'families'} (${result.stubs.map((s) => s.id).join(', ')})`);
  if (result.rewrites.changes.length) parts.push(`tendencies rewritten for ${result.rewrites.changes.map((c) => c.id).join(', ')}`);
  return `- Knowledge refresh ${result.today}: ${parts.join('; ')}.`;
}

// Adds a bullet under "### Knowledge" in the [Unreleased] section, creating it if needed.
export function addChangelogLine(text, line) {
  const lines = text.split('\n');
  const u = lines.findIndex((l) => /^## \[Unreleased\]/.test(l));
  if (u === -1) return text;
  let end = lines.findIndex((l, i) => i > u && /^## /.test(l));
  if (end === -1) end = lines.length;
  const k = lines.findIndex((l, i) => i > u && i < end && /^### Knowledge/.test(l));
  if (k === -1) {
    lines.splice(u + 1, 0, '', '### Knowledge', '', line);
    return lines.join('\n');
  }
  let at = lines.findIndex((l, i) => i > k && i < end && /^### /.test(l));
  if (at === -1) at = end;
  while (at > k + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, line);
  return lines.join('\n');
}

// Same layout as the hand-edited file: arrays of strings inline, except "rules".
export function serializeKnowledge(value) {
  const scalar = (v) => v === null || typeof v !== 'object';
  const walk = (v, indent, key) => {
    const pad = '  '.repeat(indent + 1);
    const close = '  '.repeat(indent);
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      if (v.every(scalar) && key !== 'rules') return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      return `[\n${v.map((x) => pad + walk(x, indent + 1)).join(',\n')}\n${close}]`;
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v);
      if (!entries.length) return '{}';
      return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${walk(x, indent + 1, k)}`).join(',\n')}\n${close}}`;
    }
    return JSON.stringify(v);
  };
  return `${walk(value, 0)}\n`;
}

async function main() {
  const knowledge = JSON.parse(readFileSync(KNOWLEDGE_FILE, 'utf8'));
  const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`);
  const result = await refresh({ knowledge, api: await res.json(), fetchImpl: fetch, env: process.env });

  const annotate = process.env.GITHUB_ACTIONS ? '::warning::' : 'warning: ';
  const notice = process.env.GITHUB_ACTIONS ? '::notice::' : 'note: ';
  for (const l of result.links.filter((x) => !['ok', 'moved'].includes(x.verdict))) console.log(`${annotate}source ${l.id} ${l.verdict} ${l.status ?? ''} ${l.url}`);
  for (const l of result.links.filter((x) => x.verdict === 'moved')) console.log(`${notice}source ${l.id} moved to ${l.finalUrl}`);
  for (const r of result.review) console.log(`${notice}no stub for ${r.models.join(', ')}: ${r.reason}`);
  for (const w of result.warnings) console.log(`${annotate}${w}`);

  if (!result.changed) {
    console.log('knowledge is up to date; nothing to write');
    return;
  }
  writeFileSync(KNOWLEDGE_FILE, serializeKnowledge(result.knowledge));
  const header = '# Knowledge log\n\nWhat each refresh of `knowledge/agents.json` changed, newest last. Written by `scripts/refresh-knowledge.js`.\n\n';
  const log = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : header;
  writeFileSync(LOG_FILE, `${log.replace(/\n*$/, '\n\n')}${renderLogEntry(result)}`);
  writeFileSync(CHANGELOG_FILE, addChangelogLine(readFileSync(CHANGELOG_FILE, 'utf8'), changelogLine(result)));
  console.log(changelogLine(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
