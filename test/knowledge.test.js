import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge, lookupModel, indexModelsDev, familyFor, validateKnowledge, builtinKnowledge, describeKnowledge, isStale } from '../src/knowledge.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const p = {
  knowledgeCache: '/s/knowledge-cache.json',
  modelsDevCache: '/s/models-dev-cache.json',
  overrides: '/s/knowledge.override.json',
};
const NOW = Date.parse('2026-11-07T12:00:00Z');
const HOUR = 3600 * 1000;

function memfs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    readFile: (f) => {
      if (!(f in files)) {
        const e = new Error('missing');
        e.code = 'ENOENT';
        throw e;
      }
      return files[f];
    },
    writeFile: (f, data) => { files[f] = data; },
  };
}
const noFetch = async () => { throw new Error('network should not be used'); };

test('uses builtin when no url', async () => {
  const fs = memfs();
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl: noFetch, now: NOW, offline: true });
  assert.equal(r.source, 'builtin');
  assert.equal(r.knowledge.categories.length, 8);
  assert.ok(Object.keys(r.knowledge.harnesses).includes('claude'));
});

test('marks old family entries stale', async () => {
  const fs = memfs();
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl: noFetch, now: Date.parse('2027-03-01'), offline: true });
  assert.ok(r.knowledge.families.length > 0);
  assert.ok(r.knowledge.families.every((f) => f.stale === true));
});

test('remote newer replaces builtin and is cached', async () => {
  const fs = memfs();
  const remote = { updated: '2026-12-01', categories: ['a'], rules: [], harnesses: {}, families: [] };
  const fetchImpl = async (url) => {
    if (url.includes('models.dev')) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => remote };
  };
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl, now: NOW, knowledgeUrl: 'https://x/agents.json' });
  assert.equal(r.source, 'remote');
  assert.equal(r.knowledge.updated, '2026-12-01');
  assert.equal(JSON.parse(fs.files[p.knowledgeCache]).data.updated, '2026-12-01');
});

test('remote older than builtin is ignored', async () => {
  const fs = memfs();
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('models.dev') ? {} : { updated: '2025-01-01', categories: ['a'], rules: [], harnesses: {}, families: [] }) });
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl, now: NOW, knowledgeUrl: 'https://x/agents.json' });
  assert.equal(r.source, 'builtin');
});

test('remote fetched at most daily', async () => {
  const cached = { fetchedAt: NOW - 2 * HOUR, data: { updated: '2026-12-01', categories: ['a'], rules: [], harnesses: {}, families: [] } };
  const devCache = { fetchedAt: NOW - 2 * HOUR, index: {} };
  const fs = memfs({ [p.knowledgeCache]: JSON.stringify(cached), [p.modelsDevCache]: JSON.stringify(devCache) });
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl: noFetch, now: NOW, knowledgeUrl: 'https://x/agents.json' });
  assert.equal(r.source, 'cache');
});

test('network failure falls back with warning', async () => {
  const fs = memfs();
  const fetchImpl = async () => { throw new Error('offline'); };
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl, now: NOW, knowledgeUrl: 'https://x/agents.json' });
  assert.equal(r.source, 'builtin');
  assert.ok(r.warnings.some((w) => /offline/.test(w)));
});

test('overrides deep-merge', async () => {
  const fs = memfs({ [p.overrides]: JSON.stringify({ harnesses: { pi: { notes: 'only for tiny jobs' } } }) });
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl: noFetch, now: NOW, offline: true });
  assert.equal(r.knowledge.harnesses.pi.notes, 'only for tiny jobs');
  assert.ok(r.knowledge.harnesses.pi.strengths.length > 0);
});

test('models.dev index strips provider and keeps newest', () => {
  const api = {
    anthropic: { models: { 'claude-opus-4-8': { name: 'Opus 4.8 old', last_updated: '2026-05-01', limit: { context: 200000 } } } },
    proxy: { models: { 'claude-opus-4-8': { name: 'Opus 4.8', last_updated: '2026-05-28', limit: { context: 1000000, output: 128000 }, cost: { input: 5, output: 25 }, reasoning: true, release_date: '2026-05-28', knowledge: '2026-01' } } },
  };
  const idx = indexModelsDev(api);
  assert.equal(idx['claude-opus-4-8'].context, 1000000);
  assert.equal(lookupModel(idx, 'github-copilot/claude-opus-4-8').name, 'Opus 4.8');
  assert.equal(lookupModel(idx, 'Claude_Opus 4-8').name, 'Opus 4.8');
  assert.equal(lookupModel(idx, 'nothing'), null);
});

test('familyFor matches ids from different harnesses', async () => {
  const fs = memfs();
  const { knowledge } = await loadKnowledge({ paths: p, ...fs, fetchImpl: noFetch, now: NOW, offline: true });
  assert.equal(familyFor(knowledge, 'Claude Opus 4.6 (Thinking)').id, 'claude-opus');
  assert.equal(familyFor(knowledge, 'github-copilot/gpt-5.3-codex').id, 'gpt-codex');
  assert.equal(familyFor(knowledge, 'GPT-OSS 120B (Medium)').id, 'gpt-oss');
  assert.equal(familyFor(knowledge, 'lmstudio/openai/gpt-oss-20b').id, 'gpt-oss');
  assert.equal(familyFor(knowledge, 'Gemini 3.1 Pro (High)').id, 'gemini-pro');
  assert.equal(familyFor(knowledge, 'opus').id, 'claude-opus');
  assert.equal(familyFor(knowledge, 'totally-new-model'), null);
});

test('models.dev is fetched when cache is old', async () => {
  const fs = memfs();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ openai: { models: { 'gpt-5.5': { name: 'GPT-5.5', last_updated: '2026-04-23', limit: { context: 1050000 } } } } }) });
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl, now: NOW });
  assert.equal(lookupModel(r.modelsDev, 'gpt-5.5').context, 1050000);
  assert.ok(fs.files[p.modelsDevCache]);
});

test('builtin knowledge/agents.json passes validation', () => {
  assert.deepEqual(validateKnowledge(builtinKnowledge()), []);
});

test('validateKnowledge names each problem', () => {
  const base = { updated: '2026-12-01', categories: ['bugfix'], rules: [], harnesses: { pi: { sources: ['nope'] } }, sources: { a: 'https://a' }, families: [] };
  assert.deepEqual(validateKnowledge(base), ['harness pi: source nope is not in sources']);
  const errors = validateKnowledge({
    ...base,
    updated: 'yesterday',
    harnesses: {},
    families: [
      { id: 'x', match: '(', updated: '2026-12-01' },
      { id: 'x', match: 'x', updated: 'soon', auto: 'yes' },
      { id: 'new', match: 'new', updated: '2026-12-01', tendencies: [], sources: [], auto: true },
    ],
  });
  assert.ok(errors.includes('updated is not a YYYY-MM-DD date'));
  assert.ok(errors.some((e) => /family x: match is not a valid regular expression/.test(e)));
  assert.ok(errors.includes('family x: id is used twice'));
  assert.ok(errors.includes('family x: updated is not a YYYY-MM-DD date'));
  assert.ok(errors.includes('family x: auto is not true or false'));
  assert.ok(!errors.some((e) => e.startsWith('family new')));
  assert.deepEqual(validateKnowledge([]), ['knowledge is not a JSON object']);
  assert.ok(validateKnowledge({ updated: '2026-12-01' }).includes('families is not a list'));
});

test('invalid remote knowledge is rejected with a warning', async () => {
  const fs = memfs();
  const remote = { updated: '2026-12-01', categories: ['a'], rules: [], harnesses: {}, families: [{ id: 'bad', match: '[', updated: '2026-12-01' }] };
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('models.dev') ? {} : remote) });
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl, now: NOW, knowledgeUrl: 'https://x/agents.json' });
  assert.equal(r.source, 'builtin');
  assert.equal(r.knowledge.updated, builtinKnowledge().updated);
  assert.ok(r.warnings.some((w) => /https:\/\/x\/agents\.json is invalid.*family bad/.test(w)));
});

test('remote families merge by id with the builtin ones; remote rules replace', async () => {
  const fs = memfs();
  const remote = {
    ...builtinKnowledge(),
    updated: '2026-12-01',
    rules: ['only rule'],
    families: [
      { id: 'grok', match: 'grok', updated: '2026-12-01', tendencies: ['new data'] },
      { id: 'newfam', match: 'newfam', updated: '2026-12-01', tendencies: [], sources: [], auto: true },
    ],
  };
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('models.dev') ? {} : remote) });
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl, now: NOW, knowledgeUrl: 'https://x/agents.json' });
  assert.equal(r.source, 'remote');
  assert.equal(r.knowledge.families.length, builtinKnowledge().families.length + 1);
  assert.deepEqual(r.knowledge.families.find((f) => f.id === 'grok').tendencies, ['new data']);
  assert.equal(r.knowledge.families.find((f) => f.id === 'newfam').auto, true);
  assert.deepEqual(r.knowledge.rules, ['only rule']);
});

test('override changes one family by id and appends rules', async () => {
  const fs = memfs({ [p.overrides]: JSON.stringify({ rules: ['my rule'], families: [{ id: 'grok', tendencies: ['fine for docs'] }, { id: 'mine', match: 'mine', updated: '2026-11-01' }] }) });
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl: noFetch, now: NOW, offline: true });
  assert.deepEqual(r.warnings, []);
  const builtin = builtinKnowledge();
  assert.equal(r.knowledge.families.length, builtin.families.length + 1);
  const grok = r.knowledge.families.find((f) => f.id === 'grok');
  assert.deepEqual(grok.tendencies, ['fine for docs']);
  assert.equal(grok.match, 'grok');
  assert.deepEqual(r.knowledge.rules, [...builtin.rules, 'my rule']);
});

test('an override that breaks the knowledge or is not JSON is reported and ignored', async () => {
  const bad = memfs({ [p.overrides]: JSON.stringify({ families: [{ id: 'x', match: '(' }] }) });
  const r = await loadKnowledge({ paths: p, ...bad, fetchImpl: noFetch, now: NOW, offline: true });
  assert.equal(r.knowledge.families.length, builtinKnowledge().families.length);
  assert.ok(r.warnings.some((w) => /knowledge override .* ignored: family x/.test(w)));
  const broken = memfs({ [p.overrides]: '{ not json' });
  const b = await loadKnowledge({ paths: p, ...broken, fetchImpl: noFetch, now: NOW, offline: true });
  assert.ok(b.warnings.some((w) => /knowledge override .* is not valid JSON/.test(w)));
  assert.ok(b.knowledge.families.length > 0);
});

test('a family without a usable date counts as stale', async () => {
  const r = await loadKnowledge({ paths: p, ...memfs(), fetchImpl: noFetch, now: NOW, offline: true });
  assert.ok(r.knowledge.families.every((f) => f.stale === false));
  assert.equal(isStale({ updated: '2026-11-01' }, NOW), false);
  assert.equal(isStale({ updated: '2026-01-01' }, NOW), true);
  assert.equal(isStale({}, NOW), true);
  assert.equal(isStale({ updated: 'soon' }, NOW), true);
});

test('invalid cached knowledge is not used', async () => {
  const cached = { fetchedAt: NOW, data: { ...builtinKnowledge(), updated: '2026-12-01', families: [{ id: 'grok', match: 'grok', updated: 'unknown' }] } };
  const fs = memfs({ [p.knowledgeCache]: JSON.stringify(cached), [p.modelsDevCache]: JSON.stringify({ fetchedAt: NOW, index: {} }) });
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl: noFetch, now: NOW, knowledgeUrl: 'https://x/agents.json' });
  assert.equal(r.source, 'builtin');
  assert.ok(r.warnings.some((w) => /family grok: updated/.test(w)));
});

test('force skips the daily caches', async () => {
  const cached = { fetchedAt: NOW - 2 * HOUR, data: { updated: '2026-12-01', categories: ['a'], rules: [], harnesses: {}, families: [] } };
  const devCache = { fetchedAt: NOW - 2 * HOUR, index: {} };
  const fs = memfs({ [p.knowledgeCache]: JSON.stringify(cached), [p.modelsDevCache]: JSON.stringify(devCache) });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => (url.includes('models.dev') ? {} : { ...cached.data, updated: '2026-12-02' }) };
  };
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl, now: NOW, knowledgeUrl: 'https://x/agents.json', force: true });
  assert.equal(r.source, 'remote');
  assert.equal(r.knowledge.updated, '2026-12-02');
  assert.equal(urls.length, 2);
});

test('describeKnowledge lists source, stale and automatically added families', async () => {
  const fs = memfs({ [p.overrides]: JSON.stringify({ families: [{ id: 'auto1', match: 'auto1', updated: '2026-01-01', tendencies: [], sources: [], auto: true }] }) });
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl: noFetch, now: NOW, offline: true });
  const d = describeKnowledge(r, { knowledgeUrl: false });
  assert.equal(d.source, 'builtin');
  assert.equal(d.url, null);
  // The weekly refresh adds families of its own, so look only at the one this test added.
  assert.deepEqual(d.stale.filter((f) => f.id === 'auto1'), [{ id: 'auto1', updated: '2026-01-01', auto: true }]);
  assert.ok(d.auto.includes('auto1'));
});

test('knowledge comes from the repository by default', () => {
  assert.equal(DEFAULT_CONFIG.knowledgeUrl, 'https://raw.githubusercontent.com/Kvmyk/herdr-foreman/main/knowledge/agents.json');
});
