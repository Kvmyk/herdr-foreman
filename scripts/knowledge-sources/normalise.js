// Shared helpers for the knowledge-source adapters: fetching through the
// injected fetchImpl, model-name normalisation, harness and vendor mapping,
// and small parsers (CSV, Next.js RSC payloads, JSON embedded in text).
// Adapters throw on anything unexpected; index.js turns that into ok: false.

export const CATEGORIES = ['analysis', 'security-audit', 'testing', 'bugfix', 'feature', 'refactor', 'test-writing', 'docs'];
export const HARNESS_KINDS = ['claude', 'codex', 'opencode', 'agy', 'gemini', 'pi'];
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'thinking'];

const USER_AGENT = 'Mozilla/5.0 (compatible; herdr-foreman-knowledge/1.0; +https://github.com/Kvmyk/herdr-foreman)';
const TIMEOUT_MS = 30000;

// Rate limits and gateway errors (Hugging Face answers 429/502 now and then) get two more tries.
const RETRY_DELAYS_MS = [1000, 4000];
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

async function get(fetchImpl, url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return res;
    if (!TRANSIENT.has(res.status) || attempt >= RETRY_DELAYS_MS.length) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
}
export const getText = async (fetchImpl, url) => (await get(fetchImpl, url)).text();
export const getJson = async (fetchImpl, url) => (await get(fetchImpl, url)).json();
export const getBuffer = async (fetchImpl, url) => Buffer.from(await (await get(fetchImpl, url)).arrayBuffer());

// All rows of one split from the Hugging Face datasets-server (100 per page).
export async function hfRows(fetchImpl, { dataset, config, split, maxPages = 30 }) {
  const rows = [];
  let features = null;
  for (let page = 0, total = Infinity; page * 100 < total; page++) {
    if (page >= maxPages) fail(`${dataset}/${config}: more than ${maxPages} pages`);
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${page * 100}&length=100`;
    const body = await getJson(fetchImpl, url);
    if (!Array.isArray(body?.rows) || !Array.isArray(body.features) || !Number.isInteger(body.num_rows_total)) fail(`${url}: unexpected response`);
    features ??= body.features.map((f) => f.name);
    total = body.num_rows_total;
    rows.push(...body.rows.map((r) => r.row));
    if (!body.rows.length) break;
  }
  return { features, rows };
}

export function fail(message) {
  throw new Error(message);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export function isoDay(value) {
  const day = String(value ?? '').slice(0, 10);
  if (!ISO_DAY.test(day) || Number.isNaN(Date.parse(day))) return null;
  return day;
}
export const compactToIso = (yyyymmdd) => isoDay(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`);

// A number in 0..100; text is rejected, so callers parse CSV cells themselves.
export function percent(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) fail(`${label}: not a percentage: ${JSON.stringify(value)}`);
  return value;
}

// ---- harnesses ----------------------------------------------------------

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const KIND_BY_LABEL = {
  claudecode: 'claude', claude: 'claude',
  codex: 'codex', codexcli: 'codex',
  opencode: 'opencode',
  agy: 'agy', antigravity: 'agy', antigravitycli: 'agy',
  geminicli: 'gemini',
  pi: 'pi', pidev: 'pi',
};
// Harnesses that appear on the boards but are not foreman kinds.
const OTHER_HARNESSES = new Set([
  'minisweagent', 'sweagent', 'openhands', 'terminus', 'terminus2', 'terminuskira', 'grokbuild', 'musecode',
  'factory', 'droid', 'cursorcli', 'devincli', 'proximus', 'aider', 'cline', 'goose',
]);

// Foreman kind for a harness label, or null when it is some other harness.
export const harnessKind = (label) => (label ? KIND_BY_LABEL[slug(label)] ?? null : null);
export const isHarnessLabel = (label) => slug(label) in KIND_BY_LABEL || OTHER_HARNESSES.has(slug(label));

// ---- vendors ------------------------------------------------------------

const VENDOR_BY_PREFIX = [
  [/^claude/, 'anthropic'], [/^(gpt|o\d|codex)/, 'openai'], [/^(gemini|gemma)/, 'google'], [/^qwen/, 'alibaba'],
  [/^glm/, 'zhipu'], [/^kimi/, 'moonshot'], [/^deepseek/, 'deepseek'], [/^grok/, 'xai'], [/^(muse|llama)/, 'meta'],
  [/^(mistral|ministral|devstral|codestral|magistral)/, 'mistral'], [/^minimax/, 'minimax'], [/^mimo/, 'xiaomi'],
  [/^inkling/, 'thinkingmachines'],
];
const VENDOR_ALIASES = {
  anthropic: 'anthropic', openai: 'openai', google: 'google', googledeepmind: 'google', alibaba: 'alibaba', qwen: 'alibaba',
  zai: 'zhipu', zhipu: 'zhipu', zhipuai: 'zhipu', moonshot: 'moonshot', moonshotai: 'moonshot', kimi: 'moonshot',
  deepseek: 'deepseek', xai: 'xai', spacexai: 'xai', grok: 'xai', meta: 'meta', metaai: 'meta', mistral: 'mistral', mistralai: 'mistral',
  minimax: 'minimax', xiaomi: 'xiaomi', xiaomimimo: 'xiaomi', thinkingmachines: 'thinkingmachines',
};

export function vendorLabel(label) {
  if (!label) return null;
  return VENDOR_ALIASES[slug(label)] ?? (slug(label) || null);
}

// The model id decides first: some boards attribute models to the reseller that ran them.
export function vendorFor(model, label) {
  for (const [re, vendor] of VENDOR_BY_PREFIX) if (re.test(model)) return vendor;
  return vendorLabel(label);
}

// ---- model names ----------------------------------------------------------

const EFFORT_ALIASES = { xhigh: 'xhigh', extrahigh: 'xhigh', 'x-high': 'xhigh', reasoning: 'thinking' };
export function effortWord(s) {
  const w = String(s).trim().toLowerCase();
  const key = EFFORT_ALIASES[w] ?? EFFORT_ALIASES[slug(w)] ?? w;
  return EFFORTS.includes(key) ? key : null;
}
const ANTHROPIC_TIERS = /^(opus|sonnet|haiku|fable|mythos)\b/;

// "Claude Opus 5.5 (Max)" -> {model: 'claude-opus-5.5', effort: 'max'};
// "anthropic/claude-opus-5-5" -> claude-opus-5.5; "claude-fable-5-1_xhigh" -> claude-fable-5.1 + xhigh;
// "Opus 5 (Claude Code)" with vendor anthropic -> claude-opus-5, harnessLabel 'Claude Code'.
// Dots are kept so the family regexes in knowledge/agents.json match.
export function normaliseModel(raw, { vendor } = {}) {
  let effort = null;
  let harnessLabel = null;
  const kept = [];
  // Brackets may list several notes: "(xHigh, Codex Harness)", "(High, 32K, 20251101)".
  let s = String(raw ?? '').trim().replace(/\s*[([]([^)\]]*)[)\]]/g, (_, inner) => {
    for (const part of inner.split(',').map((p) => p.trim()).filter(Boolean)) {
      const harness = part.replace(/\s+harness$/i, '');
      if (effortWord(part)) effort = effortWord(part);
      else if (isHarnessLabel(harness)) harnessLabel = harness;
      else kept.push(part);
    }
    return '';
  });
  s = [s, ...kept].join(' ').toLowerCase().split('/').pop().trim();
  const suffix = s.match(/_([a-z-]+)$/);
  if (suffix && effortWord(suffix[1])) {
    effort = effortWord(suffix[1]);
    s = s.slice(0, -suffix[0].length);
  }
  s = s.replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  // Version numbers written with hyphens: claude-opus-5-5 -> claude-opus-5.5, but not dates or sizes.
  s = s.replace(/(?<=^|-)(\d{1,2})-(\d{1,2})(?=-|$)/g, '$1.$2');
  if (ANTHROPIC_TIERS.test(s) && (vendor === 'anthropic' || !vendor)) s = `claude-${s}`;
  if (!/^[a-z0-9][a-z0-9.+-]*$/.test(s)) fail(`unusable model name: ${JSON.stringify(raw)}`);
  return { model: s, effort, harnessLabel };
}

// ---- parsers --------------------------------------------------------------

// RFC 4180 CSV with quoted fields that may hold commas, quotes and newlines.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const [header, ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h.trim(), cells[i] ?? ''])));
}

// The JSON value ({...} or [...]) that starts at text[start].
export function grabJson(text, start) {
  const open = text[start];
  if (open !== '{' && open !== '[') fail('no JSON value at the given position');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  fail('unterminated JSON value');
}

// Text of the React Server Components payload a Next.js page streams in
// self.__next_f.push([1, "..."]) script chunks.
export function nextFlight(html) {
  let text = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) text += JSON.parse(m[1]);
  if (!text) fail('no Next.js payload in the page');
  return text;
}

export function decodeEntities(s) {
  return s.replace(/&(quot|#39|#x27|lt|gt|amp);/g, (_, e) => ({ quot: '"', '#39': "'", '#x27': "'", lt: '<', gt: '>', amp: '&' })[e]);
}
