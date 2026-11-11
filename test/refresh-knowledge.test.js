import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectNewModels, analyzeNewModels, checkSources, validateAnswer, rewriteTendencies, refresh, callGemini,
  stripHtml, addChangelogLine, serializeKnowledge, renderLogEntry,
} from '../scripts/refresh-knowledge.js';

const NOW = Date.parse('2026-11-11T06:00:00Z');
const knowledge = {
  updated: '2026-11-07',
  sources: { s1: 'https://example.test/a', s2: 'https://example.test/b' },
  families: [
    { id: 'claude-opus', match: 'claude-opus', vendor: 'anthropic', tendencies: ['Scores 78.9% on bench.'], updated: '2026-11-07', sources: ['s1'] },
  ],
};
const model = (id, extra = {}) => ({ id, release_date: '2026-09-01', modalities: { output: ['text'] }, ...extra });
const api = {
  anthropic: { models: { a: model('claude-opus-5-5'), b: model('claude-mystic-1', { family: 'claude-mystic' }), c: model('claude-mystic-2', { family: 'claude-mystic' }) } },
  google: { models: { d: model('gemini-9-image-preview'), e: model('gemini-9-pro', { release_date: '2024-01-01' }) } },
  openai: { models: { f: model('gpt-sol-1', { family: 'gpt-sol' }) } },
  'some-reseller': { models: { g: model('shiny-new-model-1') } },
};

test('detectNewModels groups unmatched first-party models into one stub per family', () => {
  const stubs = detectNewModels(knowledge, api, { now: NOW });
  assert.deepEqual(stubs.map((s) => s.id), ['claude-mystic', 'gpt-sol']);
  const [mystic] = stubs;
  assert.deepEqual(
    { ...mystic, models: undefined },
    { id: 'claude-mystic', vendor: 'anthropic', match: 'claude-mystic', updated: '2026-11-11', tendencies: [], sources: [], auto: true, models: undefined },
  );
  assert.deepEqual(mystic.models, ['claude-mystic-1', 'claude-mystic-2']);
});

test('detectNewModels skips covered, old, non-text and reseller models', () => {
  const ids = detectNewModels(knowledge, api, { now: NOW }).flatMap((s) => s.models);
  assert.ok(!ids.includes('claude-opus-5-5'));
  assert.ok(!ids.includes('gemini-9-image-preview'));
  assert.ok(!ids.includes('gemini-9-pro'));
  assert.ok(!ids.includes('shiny-new-model-1'));
});

// Subset of https://models.dev/api.json as of 2026-11-11, plus the existing families it collided with.
const realApi = JSON.parse(readFileSync(new URL('./fixtures/models-dev-stubs.json', import.meta.url), 'utf8'));
const realKnowledge = {
  updated: '2026-11-07',
  sources: {},
  families: [
    { id: 'gpt', match: 'gpt-[0-9]', vendor: 'openai', tendencies: [], updated: '2026-11-07', sources: [] },
    { id: 'gemini-pro', match: 'gemini-[0-9.]+-pro|gemini-[0-9.]+-argon|gemini-4', vendor: 'google', tendencies: [], updated: '2026-11-07', sources: [] },
  ],
};

test('analyzeNewModels on real models.dev data adds only gemma and flags the rest for a manual look', () => {
  const { stubs, review } = analyzeNewModels(realKnowledge, realApi, { now: NOW });
  assert.deepEqual(stubs.map((s) => [s.id, s.match]), [['gemma', 'gemma']]);
  assert.deepEqual(review.map((r) => r.models).flat().sort(),
    ['gemini-pro-latest', 'gpt-daybreak-blue-latest', 'gpt-daybreak-red-latest']);
  const byFamily = Object.fromEntries(review.map((r) => [r.family, r.reason]));
  assert.match(byFamily.gpt, /variant of existing family gpt/);
  assert.match(byFamily['gemini-pro'], /variant of existing family gemini-pro/);
  assert.match(byFamily['gpt-sol'], /only alias ids/);
});

test('stub matches never use a bare vendor word and cover only the concrete ids', () => {
  const k = { families: [] };
  const apiOf = (provider, ...ids) => ({ [provider]: { models: Object.fromEntries(ids.map((id) => [id, model(id, { family: 'gpt' })])) } });
  const [multi] = detectNewModels(k, apiOf('openai', 'gpt-7.1-mini', 'gpt-7.1-nano'), { now: NOW });
  assert.equal(multi.match, String.raw`gpt-7\.1`);
  const [mixed] = detectNewModels(k, apiOf('openai', 'gpt-7-mini', 'gpt-8-pro'), { now: NOW });
  assert.equal(mixed.match, 'gpt-7-mini|gpt-8-pro');
  const [single] = detectNewModels(k, apiOf('openai', 'gpt-7-mini'), { now: NOW });
  assert.equal(single.match, 'gpt-7-mini');
});

test('aliases and dated duplicates are ignored when a canonical id exists; stub ids drop vendor suffixes', () => {
  const k = { families: [] };
  const api2 = { google: { models: Object.fromEntries(
    ['gemma-9-it', 'gemma-9-it-latest', 'gemma-9-it-2026-09-01', 'gemma-9-it-preview-latest']
      .map((id) => [id, model(id, { family: 'gemma-google' })])) } };
  const { stubs } = analyzeNewModels(k, api2, { now: NOW });
  assert.deepEqual(stubs.map((s) => [s.id, s.models]), [['gemma', ['gemma-9-it']]]);
});

test('renderLogEntry reports review items and notes redirects separately from warnings', () => {
  const result = {
    today: '2026-11-11', stubs: [], rewrites: { changes: [] }, warnings: [],
    review: [{ family: 'gpt', provider: 'openai', models: ['gpt-x-latest'], reason: 'variant of existing family gpt' }],
    links: [
      { id: 'a', url: 'https://e.test/a', status: 200, verdict: 'moved', finalUrl: 'https://e.test/b' },
      { id: 'b', url: 'https://e.test/c', status: 410, verdict: 'dead' },
    ],
  };
  const log = renderLogEntry(result);
  assert.match(log, /Needs a manual look, no stub added \(variant of existing family gpt\): gpt-x-latest/);
  assert.match(log, /needing attention[^]*`b` dead/);
  assert.match(log, /Note: source links that redirect[^]*`a` moved/);
  assert.doesNotMatch(log.split('Note:')[0], /`a` moved/);
});

test('refresh adds stubs, bumps updated, and leaves existing entries untouched', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, url: 'https://example.test/a' });
  const result = await refresh({ knowledge, api, fetchImpl, now: NOW });
  assert.equal(result.changed, true);
  assert.equal(result.knowledge.updated, '2026-11-11');
  assert.deepEqual(result.knowledge.families[0], knowledge.families[0]);
  assert.equal(result.knowledge.families.length, 3);
  assert.equal(knowledge.families.length, 1);
  assert.ok(result.knowledge.families.slice(1).every((f) => f.auto === true && !('models' in f)));
});

test('refresh keeps updated when nothing changed', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200 });
  const result = await refresh({ knowledge, api: {}, fetchImpl, now: NOW });
  assert.equal(result.changed, false);
  assert.equal(result.knowledge.updated, '2026-11-07');
});

test('checkSources: HEAD, GET fallback, dead, unreachable and redirect', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(`${opts.method} ${url}`);
    if (url.endsWith('/ok')) return { ok: true, status: 200, url };
    if (url.endsWith('/nohead')) return opts.method === 'HEAD' ? { ok: false, status: 405 } : { ok: true, status: 206, url };
    if (url.endsWith('/gone')) return { ok: false, status: 410, url };
    if (url.endsWith('/moved')) return { ok: true, status: 200, url: 'https://example.test/new' };
    throw new Error('timeout');
  };
  const sources = {
    ok: 'https://example.test/ok', nohead: 'https://example.test/nohead', gone: 'https://example.test/gone',
    moved: 'https://example.test/moved', down: 'https://example.test/down',
  };
  const res = Object.fromEntries((await checkSources(sources, fetchImpl)).map((r) => [r.id, r]));
  assert.deepEqual(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.verdict])),
    { ok: 'ok', nohead: 'ok', gone: 'dead', moved: 'moved', down: 'unreachable' });
  assert.equal(res.moved.finalUrl, 'https://example.test/new');
  assert.ok(calls.includes('GET https://example.test/nohead'));
  assert.ok(calls.includes('GET https://example.test/down'));
});

test('checkSources never runs more than 4 requests at once', async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async (url) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return { ok: true, status: 200, url };
  };
  const sources = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`s${i}`, `https://example.test/${i}`]));
  await checkSources(sources, fetchImpl);
  assert.equal(peak, 4);
});

const family = knowledge.families[0];
const input = { family, allowedSources: ['s1', 's2'], pages: [{ id: 's1', text: 'Opus scored 79.5% and 80 on the other test.' }] };
const answer = (over = {}) => JSON.stringify({ id: 'claude-opus', match: 'claude-opus', vendor: 'anthropic', tendencies: ['Scored 79.5%.'], sources: ['s1'], ...over });

test('validateAnswer accepts a grounded answer', () => {
  const v = validateAnswer(answer(), family, input, ['s1', 's2']);
  assert.deepEqual(v, { ok: true, entry: { tendencies: ['Scored 79.5%.'], sources: ['s1'] } });
});

test('validateAnswer rejects bad JSON, changed identity, unknown sources, invented numbers, bad schema', () => {
  const reject = (text, reason) => {
    const v = validateAnswer(text, family, input, ['s1', 's2']);
    assert.equal(v.ok, false);
    assert.match(v.reason, reason);
  };
  reject('not json', /JSON/);
  reject('[]', /object/);
  reject(answer({ id: 'other' }), /id changed/);
  reject(answer({ match: '.*' }), /match changed/);
  reject(answer({ vendor: 'x' }), /vendor changed/);
  reject(answer({ sources: ['s9'] }), /unknown source/);
  reject(answer({ tendencies: ['Scored 91.2%.'] }), /number 91\.2/);
  reject(answer({ tendencies: ['a', 'b', 'c', 'd', 'e'] }), /schema/);
  reject(answer({ tendencies: ['x'.repeat(201)] }), /schema/);
  reject(answer({ tendencies: [5] }), /schema/);
});

const geminiReply = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
const pageFetch = (geminiHandler) => async (url, opts = {}) => {
  if (url.startsWith('https://generativelanguage.googleapis.com/')) return geminiHandler(url, opts);
  return { ok: true, status: 200, text: async () => '<html><script>var x=1</script><p>Opus scored 79.5% here.</p></html>' };
};

test('rewriteTendencies applies a valid answer and rejects an invalid one without failing', async () => {
  const k = { ...knowledge, families: [family, { ...family, id: 'second', match: 'second' }] };
  let n = 0;
  const fetchImpl = pageFetch(() => geminiReply(++n === 1
    ? answer({ tendencies: ['Scored 79.5%.'] })
    : JSON.stringify({ id: 'second', match: 'second', vendor: 'anthropic', tendencies: ['Scored 99%.'], sources: ['s1'] })));
  const r = await rewriteTendencies({ knowledge: k, fetchImpl, apiKey: 'k' });
  assert.equal(r.skipped, false);
  assert.deepEqual(r.changes.map((c) => c.id), ['claude-opus']);
  assert.deepEqual(r.changes[0].before, ['Scores 78.9% on bench.']);
  assert.match(r.warnings[0], /second rejected: number 99/);
});

test('rewriteTendencies skips part B on a quota error and applies nothing', async () => {
  const fetchImpl = pageFetch(() => ({ ok: false, status: 429 }));
  const r = await rewriteTendencies({ knowledge, fetchImpl, apiKey: 'k' });
  assert.equal(r.skipped, true);
  assert.deepEqual(r.changes, []);
  assert.match(r.warnings[0], /part B skipped: .*429/);
});

test('callGemini sends JSON-only config and falls back once on 404', async () => {
  const urls = [];
  let body;
  const fetchImpl = async (url, opts) => {
    urls.push(url);
    body = JSON.parse(opts.body);
    return url.includes('gemini-3.8-flash') ? { ok: false, status: 404 } : geminiReply('{}');
  };
  const r = await callGemini({ fetchImpl, apiKey: 'k', model: 'gemini-3.8-flash', input });
  assert.equal(r.model, 'gemini-3.6-flash');
  assert.equal(urls.length, 2);
  assert.equal(body.generationConfig.temperature, 0);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.responseJsonSchema);
});

test('refresh runs part B only with GEMINI_API_KEY and logs the change', async () => {
  let gemini = 0;
  const fetchImpl = pageFetch(() => { gemini++; return geminiReply(answer()); });
  const without = await refresh({ knowledge, api: {}, fetchImpl, env: {}, now: NOW });
  assert.equal(gemini, 0);
  assert.equal(without.changed, false);
  const withKey = await refresh({ knowledge, api: {}, fetchImpl, env: { GEMINI_API_KEY: 'k' }, now: NOW });
  assert.equal(withKey.changed, true);
  assert.deepEqual(withKey.knowledge.families[0].tendencies, ['Scored 79.5%.']);
  assert.equal(withKey.knowledge.families[0].updated, '2026-11-11');
  const log = renderLogEntry(withKey);
  assert.match(log, /## 2026-11-11/);
  assert.match(log, /old: \["Scores 78\.9% on bench\."\]/);
  assert.match(log, /new: \["Scored 79\.5%\."\]/);
});

test('stripHtml drops scripts and tags and caps length', () => {
  assert.equal(stripHtml('<style>a{}</style><p>Hi &amp; <b>bye</b></p><script>x()</script>'), 'Hi & bye');
  assert.equal(stripHtml('<p>abcdef</p>', 3), 'abc');
});

test('addChangelogLine creates and extends the Knowledge section under Unreleased', () => {
  const base = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- x\n';
  const once = addChangelogLine(base, '- one');
  assert.equal(once, '# Changelog\n\n## [Unreleased]\n\n### Knowledge\n\n- one\n\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- x\n');
  const twice = addChangelogLine(once, '- two');
  assert.match(twice, /### Knowledge\n\n- one\n- two\n\n## \[0\.1\.0\]/);
});

test('serializeKnowledge reproduces the committed file byte for byte', () => {
  const file = new URL('../knowledge/agents.json', import.meta.url);
  const text = readFileSync(file, 'utf8');
  assert.equal(serializeKnowledge(JSON.parse(text)), text);
});
