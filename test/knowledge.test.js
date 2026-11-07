import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge, lookupModel, indexModelsDev, familyFor } from '../src/knowledge.js';

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
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('models.dev') ? {} : { updated: '2025-01-01', categories: [], rules: [], harnesses: {}, families: [] }) });
  const r = await loadKnowledge({ paths: p, ...fs, fetchImpl, now: NOW, knowledgeUrl: 'https://x/agents.json' });
  assert.equal(r.source, 'builtin');
});

test('remote fetched at most daily', async () => {
  const cached = { fetchedAt: NOW - 2 * HOUR, data: { updated: '2026-12-01', categories: [], rules: [], harnesses: {}, families: [] } };
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
