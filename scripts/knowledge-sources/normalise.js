// Shared helpers for the knowledge-source adapters: fetching through the
// injected fetchImpl, model-name normalisation, harness and vendor mapping,
// and small parsers for CSV and HTML entities.
// Adapters throw on anything unexpected; index.js turns that into ok: false.

export const CATEGORIES = ['analysis', 'security-audit', 'testing', 'bugfix', 'feature', 'refactor', 'test-writing', 'docs'];
export const HARNESS_KINDS = ['claude', 'codex', 'opencode', 'agy', 'gemini', 'pi'];
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'thinking'];

const PRODUCT = 'herdr-foreman-knowledge';
const USER_AGENT = `${PRODUCT}/1.0 (+https://github.com/Kvmyk/herdr-foreman)`;
const TIMEOUT_MS = 30000;

const RETRY_DELAYS_MS = [1000, 4000];
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const guardedFetches = new WeakSet();

export class RobotsError extends Error {}

// Compare rule and URL octets after decoding percent-encoded unreserved characters.
function robotsPath(text) {
  return text.replace(/[^\x00-\x7f]+/g, encodeURIComponent).replace(/%[a-f0-9]{2}/gi, (escape) => {
    const char = String.fromCharCode(parseInt(escape.slice(1), 16));
    return /^[A-Za-z0-9._~-]$/.test(char) ? char : escape.toUpperCase();
  });
}

function robotsRules(text) {
  const groups = [];
  let group;
  for (const line of text.split(/\r\n|[\r\n]/)) {
    const field = line.split('#', 1)[0].match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (!field) continue;
    const [, key, value] = field;
    const directive = key.toLowerCase();
    if (directive === 'user-agent') {
      if (!group || group.hasRules) {
        group = { agents: [], rules: [], hasRules: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (directive === 'allow' || directive === 'disallow')) {
      group.hasRules = true;
      if (!value.startsWith('/')) continue;
      const path = robotsPath(value);
      const anchored = path.endsWith('$');
      const pattern = (anchored ? path.slice(0, -1) : path)
        .split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      group.rules.push({ pattern: new RegExp(`^${pattern}${anchored ? '$' : ''}`), length: path.length, allow: directive === 'allow' });
    }
  }
  const specific = groups.filter(({ agents }) => agents.includes(PRODUCT));
  return (specific.length ? specific : groups.filter(({ agents }) => agents.includes('*'))).flatMap(({ rules }) => rules);
}

function robotsAllow(rules, url) {
  const path = robotsPath(url.pathname + url.search);
  let best;
  for (const rule of rules) {
    if (!rule.pattern.test(path)) continue;
    if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) best = rule;
  }
  return best?.allow ?? true;
}

function retryDelay(res, attempt, now) {
  const after = [429, 503].includes(res.status) ? res.headers?.get('retry-after')?.trim() : null;
  if (after) {
    const delay = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - now();
    if (!Number.isNaN(delay)) return Math.max(0, delay);
  }
  return RETRY_DELAYS_MS[attempt];
}

// Share robots checks for concurrent requests within one refresh. Follow redirects
// manually so a new origin's policy is applied before any resource request there.
export function createKnowledgeFetch(fetchImpl, { wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
  if (guardedFetches.has(fetchImpl)) return fetchImpl;
  const policies = new Map();

  async function request(url, options, timeoutMs) {
    const headers = new Headers(options.headers);
    headers.set('user-agent', USER_AGENT);
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url.href, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (attempt >= RETRY_DELAYS_MS.length || !TRANSIENT.has(res.status)) return res;
      const delay = retryDelay(res, attempt, now);
      // Leave a longer server-requested pause to the next refresh.
      if (delay >= timeoutMs) return res;
      await res.body?.cancel();
      await wait(delay);
    }
  }

  async function follow(input, options, timeoutMs, checkPolicy) {
    let url = new URL(input);
    for (let redirects = 0; ; redirects++) {
      if (!['http:', 'https:'].includes(url.protocol)) fail(`Unsupported URL: ${url.href}`);
      if (checkPolicy) await checkPolicy(url, timeoutMs);
      const res = await request(url, options, timeoutMs);
      const location = REDIRECTS.has(res.status) && res.headers?.get('location');
      if (!location) return res;
      await res.body?.cancel();
      if (redirects >= MAX_REDIRECTS) fail(`Too many redirects: ${input}`);
      url = new URL(location, url);
    }
  }

  async function loadPolicy(origin, timeoutMs) {
    const url = `${origin}/robots.txt`;
    try {
      // The site of the original robots URL owns these rules, even after redirects.
      const res = await follow(url, { method: 'GET' }, timeoutMs);
      if (res.ok) return robotsRules(await res.text());
      if (res.status >= 400 && res.status < 500 && ![401, 403, 429].includes(res.status)) return [];
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      throw new RobotsError(`Skipped ${origin}: unable to read ${url} (${err.message})`);
    }
  }

  async function checkPolicy(url, timeoutMs) {
    if (!policies.has(url.origin)) policies.set(url.origin, loadPolicy(url.origin, timeoutMs));
    if (!robotsAllow(await policies.get(url.origin), url)) {
      throw new RobotsError(`Skipped ${url.href}: disallowed by ${url.origin}/robots.txt`);
    }
  }

  function guardedFetch(url, { timeoutMs = TIMEOUT_MS, ...options } = {}) {
    return follow(url, options, timeoutMs, checkPolicy);
  }
  guardedFetches.add(guardedFetch);
  return guardedFetch;
}

async function get(fetchImpl, url) {
  const res = await createKnowledgeFetch(fetchImpl)(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
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

export function decodeEntities(s) {
  return s.replace(/&(quot|#39|#x27|lt|gt|amp);/g, (_, e) => ({ quot: '"', '#39': "'", '#x27': "'", lt: '<', gt: '>', amp: '&' })[e]);
}
