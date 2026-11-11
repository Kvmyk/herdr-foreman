import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectNewModels, analyzeNewModels, checkSources, refresh, serializeKnowledge, renderLogEntry,
  applyFacts, factText, selectFamilyFacts, selectHarnessFacts, fetchReleases, latestModels,
} from '../scripts/refresh-knowledge.js';

const NOW = Date.parse('2026-11-11T06:00:00Z');
const DAY = 24 * 3600 * 1000;
const knowledge = {
  updated: '2026-11-07',
  sources: { s1: 'https://example.test/a', s2: 'https://example.test/b' },
  families: [
    { id: 'claude-opus', match: 'claude-opus', vendor: 'anthropic', tendencies: ['Scores 78.9% on bench.'], updated: '2026-11-07', sources: ['s1'] },
  ],
};
const model = (id, extra = {}) => ({ id, release_date: '2026-09-01', tool_call: true, modalities: { output: ['text'] }, ...extra });
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
    today: '2026-11-11', stubs: [], warnings: [],
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
  assert.deepEqual({ ...result.knowledge.families[0], latest: undefined }, { ...knowledge.families[0], latest: undefined });
  assert.equal(result.knowledge.families.length, 3);
  assert.equal(knowledge.families.length, 1);
  assert.ok(result.knowledge.families.slice(1).every((f) => f.auto === true && !('models' in f)));
});

test('refresh keeps updated when nothing changed', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200 });
  const first = await refresh({ knowledge, api: {}, fetchImpl, now: NOW });
  const again = await refresh({ knowledge: first.knowledge, api: {}, fetchImpl, now: NOW + 7 * DAY });
  assert.equal(again.changed, false);
  assert.equal(again.knowledge.updated, first.knowledge.updated);
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

test('serializeKnowledge reproduces the committed file byte for byte', () => {
  const file = new URL('../knowledge/agents.json', import.meta.url);
  const text = readFileSync(file, 'utf8');
  assert.equal(serializeKnowledge(JSON.parse(text)), text);
});

// ---- Facts, releases, latest models, compatibility ----------------------

const rec = (over = {}) => ({
  source: 'tbench', benchmark: 'Terminal-Bench 4.1', model: 'claude-opus-5.5', vendor: 'anthropic', harness: 'claude', effort: null,
  score: 65.8, unit: '%', rank: 1, of: 35, date: '2026-11-11', category: null, ...over,
});
const src = (id, over = {}) => ({ id, url: `https://example.test/${id}`, title: id, kind: 'data', licence: 'CC-BY-4.0', ttlDays: 45, read: async () => [], ...over });
const base = () => ({
  updated: '2026-11-07',
  categories: ['bugfix'],
  rules: [],
  sources: { tbench: 'https://example.test/tbench' },
  harnesses: { claude: { strengths: [], weaknesses: [], sources: [] }, pi: { strengths: [] } },
  families: [
    { id: 'claude-opus', match: 'claude-opus', vendor: 'anthropic', tendencies: ['old'], updated: '2026-08-01', sources: [] },
    { id: 'gpt', match: 'gpt-[0-9]', vendor: 'openai', tendencies: ['old'], updated: '2026-08-01', sources: [] },
  ],
});

test('factText renders the benchmark, category, model, score, rank, harness and date', () => {
  assert.equal(factText(rec({ model: 'x' })), 'Terminal-Bench 4.1, x: 65.8% (#1 of 35, with Claude Code, 2026-11-11)');
  assert.equal(factText(rec({ benchmark: 'SWE Atlas refactoring', category: 'refactor', harness: null, score: 77.1, rank: 1, of: 16, date: '2026-11-06' })),
    'SWE Atlas refactoring (refactor), claude-opus-5.5: 77.1% (#1 of 16, 2026-11-06)');
  assert.equal(factText(rec({ harness: null, rank: null, of: null, unit: 'elo', score: 1513.0021, effort: 'max' })),
    'Terminal-Bench 4.1, claude-opus-5.5 (max): 1513 elo (2026-11-11)');
});

test('factText reads well when the board has no score', () => {
  assert.equal(factText(rec({ benchmark: 'Agent Arena', harness: null, score: null, unit: null, rank: 3, of: 55, date: '2026-11-08' })),
    'Agent Arena, claude-opus-5.5: #3 of 55 (2026-11-08)');
});

test('applyFacts writes facts, tendencies and updated from the newest fact, and lists unmatched models', () => {
  const k = base();
  const records = [
    rec(), rec({ benchmark: 'Other', score: 70, rank: 2, date: '2026-10-01', harness: null }),
    rec({ model: 'mystery-1' }), rec({ model: 'mystery-1', benchmark: 'Other' }),
  ];
  const { frozen, unmatched } = applyFacts(k, { records, status: { tbench: { ok: true, newest: '2026-11-11', count: 4 } } }, [src('tbench')], '2026-11-11');
  assert.deepEqual(frozen, []);
  assert.deepEqual(unmatched, [{ model: 'mystery-1', source: 'tbench' }]);
  const opus = k.families[0];
  assert.equal(opus.updated, '2026-11-11');
  assert.deepEqual(opus.sources, ['tbench']);
  assert.equal(opus.tendencies[0], 'Terminal-Bench 4.1, claude-opus-5.5: 65.8% (#1 of 35, with Claude Code, 2026-11-11)');
  assert.equal(opus.facts.length, 2);
  assert.equal(opus.facts[0].harness, 'claude');
  assert.equal(k.harnesses.claude.facts.length, 1);
  assert.equal(k.harnesses.pi.facts, undefined);
  assert.deepEqual(k.families[1].tendencies, []);
  assert.equal(k.families[1].updated, '2026-08-01');
  assert.deepEqual(k.sourceMeta.tbench, { title: 'tbench', kind: 'data', licence: 'CC-BY-4.0', ttlDays: 45, newest: '2026-11-11', checked: '2026-11-11', ok: true });
});

const F = (over) => ({ ...rec(over), text: `${over.model ?? 'm'} ${over.benchmark ?? 'B'}` });

test('selectFamilyFacts keeps the best model per benchmark, harness and category facts first, at most 8', () => {
  const facts = [
    F({ benchmark: 'Arena', harness: null, model: 'claude-opus-5', rank: 5, of: 50 }),
    F({ benchmark: 'Arena', harness: null, model: 'claude-opus-5.5', rank: 2, of: 50 }),
    F({ benchmark: 'Arena', harness: null, model: 'claude-opus-4.8', rank: 9, of: 50 }),
    F({ benchmark: 'TB', harness: 'claude', model: 'claude-opus-5.5', rank: 9, of: 10 }),
    F({ benchmark: 'SWE', harness: null, category: 'refactor', model: 'claude-opus-5.5', rank: 5, of: 10 }),
    F({ benchmark: 'Tie', harness: null, model: 'claude-opus-5', rank: 1, of: 5 }),
    F({ benchmark: 'Tie', harness: null, model: 'claude-opus-5.5', rank: 1, of: 5 }),
  ];
  const out = selectFamilyFacts(facts);
  assert.deepEqual(out.map((f) => `${f.benchmark}:${f.model}`), [
    'SWE:claude-opus-5.5', 'TB:claude-opus-5.5', 'Arena:claude-opus-5.5', 'Tie:claude-opus-5.5']);
  const many = Array.from({ length: 12 }, (_, i) => F({ benchmark: `B${i}`, harness: null, rank: i + 1, of: 20 }));
  assert.equal(selectFamilyFacts(many).length, 8);
});

test('selectHarnessFacts keeps the best pair per benchmark and model family, best relative rank first', () => {
  const items = [
    { ...F({ benchmark: 'TB', model: 'claude-opus-5.5', rank: 4, of: 10 }), family: 'claude-opus' },
    { ...F({ benchmark: 'TB', model: 'claude-opus-5', rank: 2, of: 10 }), family: 'claude-opus' },
    { ...F({ benchmark: 'TB', model: 'claude-sonnet-5.5', rank: 3, of: 10 }), family: 'claude-sonnet' },
    { ...F({ benchmark: 'Other', model: 'claude-opus-5.5', rank: 1, of: 2 }), family: 'claude-opus' },
  ];
  assert.deepEqual(selectHarnessFacts(items).map((f) => `${f.benchmark}:${f.model}`),
    ['TB:claude-opus-5', 'TB:claude-sonnet-5.5', 'Other:claude-opus-5.5']);
});

test('a source older than its ttl is frozen and its facts are dropped', () => {
  const k = base();
  applyFacts(k, { records: [rec()], status: { tbench: { ok: true, newest: '2026-11-11', count: 1 } } }, [src('tbench')], '2026-11-11');
  const { frozen } = applyFacts(k, { records: [rec({ date: '2026-08-01' })], status: { tbench: { ok: true, newest: '2026-08-01', count: 1 } } }, [src('tbench')], '2026-11-11');
  assert.match(frozen[0].reason, /last changed 2026-08-01, more than 45 days ago/);
  assert.equal(k.families[0].facts, undefined);
  assert.deepEqual(k.families[0].tendencies, []);
  assert.equal(k.harnesses.claude.facts, undefined);
});

test('one failure keeps the facts, two failures in a row freeze the source', () => {
  const k = base();
  applyFacts(k, { records: [rec()], status: { tbench: { ok: true, newest: '2026-11-11', count: 1 } } }, [src('tbench')], '2026-11-11');
  const down = { records: [], status: { tbench: { ok: false, newest: null, count: 0, error: 'HTTP 500' } } };
  const first = applyFacts(k, down, [src('tbench')], '2026-11-18');
  assert.deepEqual(first.frozen, []);
  assert.equal(k.families[0].facts.length, 1);
  assert.equal(k.sourceMeta.tbench.ok, false);
  assert.equal(k.sourceMeta.tbench.newest, '2026-11-11');
  const second = applyFacts(k, down, [src('tbench')], '2026-11-25');
  assert.match(second.frozen[0].reason, /ok false twice in a row \(HTTP 500\)/);
  assert.equal(k.families[0].facts, undefined);
});

test('fetchReleases reads dist-tags.latest and its publish time; a failing package is a warning', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('claude-code')) return { ok: true, json: async () => ({ 'dist-tags': { latest: '2.1.322' }, time: { '2.1.322': '2026-11-10T01:58:41.811Z' } }) };
    return { ok: false, status: 503 };
  };
  const r = await fetchReleases(fetchImpl, { claude: '@anthropic-ai/claude-code', pi: '@earendil-works/pi-coding-agent' });
  assert.deepEqual(r.releases, { claude: { version: '2.1.322', date: '2026-11-10', source: 'npm' } });
  assert.match(r.warnings[0], /pi-coding-agent not read: HTTP 503/);
});

test('latestModels picks the newest first-party model that can call tools and writes text', () => {
  const k = base();
  const dev = { anthropic: { models: { a: { id: 'claude-opus-5-5', release_date: '2026-09-01', tool_call: true }, b: { id: 'claude-opus-4-6', release_date: '2026-02-01', tool_call: true }, v: { id: 'claude-opus-video-1', release_date: '2026-10-01', tool_call: true, modalities: { output: ['video'] } }, n: { id: 'claude-opus-6-notools', release_date: '2026-10-05', tool_call: false } } }, reseller: { models: { c: { id: 'claude-opus-9', release_date: '2026-11-01' } } } };
  assert.deepEqual(latestModels(k, dev), { 'claude-opus': { id: 'claude-opus-5-5', date: '2026-09-01' } });
});

test('refresh with a fake collectFacts stores facts, releases and the log lines; a second run changes nothing', async () => {
  const registry = { 'dist-tags': { latest: '2.1.322' }, time: { '2.1.322': '2026-11-10T01:58:41.811Z' } };
  const fetchImpl = async (url) => (url.startsWith('https://registry.npmjs.org/') && url.length > 30
    ? { ok: true, status: 200, url, json: async () => registry }
    : { ok: true, status: 200, url });
  const collectFacts = async () => ({
    records: [rec(), rec({ source: 'dead', model: 'gpt-6.1-sol', harness: null })],
    status: { tbench: { ok: true, newest: '2026-11-11', count: 1 }, dead: { ok: true, newest: '2026-01-01', count: 1 } },
  });
  const sourceList = [src('tbench'), src('dead')];
  const k = base();
  const r = await refresh({ knowledge: k, api, fetchImpl, collectFacts, sourceList, packages: { claude: '@anthropic-ai/claude-code' }, now: NOW });
  assert.equal(r.changed, true);
  assert.equal(r.knowledge.updated, '2026-11-11');
  assert.equal(r.knowledge.families[0].facts.length, 1);
  assert.deepEqual(r.knowledge.harnesses.claude.release, { version: '2.1.322', date: '2026-11-10', source: 'npm' });
  assert.deepEqual(r.knowledge.families[0].latest, { id: 'claude-opus-5-5', date: '2026-09-01' });
  assert.deepEqual(r.knowledge.sourceMeta.npm.newest, '2026-11-10');
  assert.deepEqual(r.frozen.map((f) => f.id), ['dead']);
  const log = renderLogEntry(r);
  assert.match(log, /Source `dead` is frozen, its facts were dropped/);
  assert.match(log, /Harness `claude` release unknown -> 2.1.322/);
  const again = await refresh({ knowledge: r.knowledge, api, fetchImpl, collectFacts, sourceList, packages: { claude: '@anthropic-ai/claude-code' }, now: NOW + 7 * DAY });
  assert.equal(again.changed, false);
});

test('the regenerated shape is valid for the current validator and for foreman v0.9.1 clients', async () => {
  const { validateKnowledge: validateOld } = await import('./fixtures/validate-knowledge-v0.9.1.js');
  const { validateKnowledge } = await import('../src/knowledge.js');
  const committed = JSON.parse(readFileSync(new URL('../knowledge/agents.json', import.meta.url), 'utf8'));
  const fetchImpl = async (url) => ({ ok: true, status: 200, url, json: async () => ({ 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': '2026-11-10T00:00:00Z' } }) });
  const collectFacts = async () => ({
    records: [rec(), rec({ model: 'gpt-6.1-sol', harness: 'codex', rank: 3 }), rec({ model: 'gemini-4-argon', harness: null, unit: 'elo', score: 1530.1 })],
    status: { tbench: { ok: true, newest: '2026-11-11', count: 3 } },
  });
  const r = await refresh({ knowledge: committed, api, fetchImpl, collectFacts, sourceList: [src('tbench')], now: NOW });
  assert.ok(r.knowledge.families.some((f) => f.facts?.length));
  for (const k of [committed, r.knowledge]) {
    assert.deepEqual(validateOld(k), []);
    assert.deepEqual(validateKnowledge(k), []);
  }
  assert.deepEqual(validateOld(JSON.parse(serializeKnowledge(r.knowledge))), []);
});

test('serializeKnowledge keeps facts, release and sourceMeta on one line each and round-trips', async () => {
  const collectFacts = async () => ({ records: [rec()], status: { tbench: { ok: true, newest: '2026-11-11', count: 1 } } });
  const r = await refresh({ knowledge: base(), api: {}, fetchImpl: async () => ({ ok: false, status: 500 }), collectFacts, sourceList: [src('tbench')], now: NOW });
  const text = serializeKnowledge(r.knowledge);
  assert.deepEqual(JSON.parse(text), r.knowledge);
  assert.equal(serializeKnowledge(JSON.parse(text)), text);
  assert.match(text, /\n {8}\{"text":"Terminal-Bench 4\.1, claude-opus-5\.5: 65\.8%[^\n]*"source":"tbench"\}\n/);
  assert.match(text, /\n {4}"tbench": \{"title":"tbench"[^\n]*"ok":true\},?\n/);
});
