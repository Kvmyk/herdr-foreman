import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, summarizeModels } from '../src/brief.js';
import { builtinKnowledge } from '../src/knowledge.js';

const knowledge = builtinKnowledge();
const agents = [
  { kind: 'claude', status: 'ready', version: '2', path: '/x/claude', verified: true, reason: null, defaultModel: null, models: [{ id: 'opus', access: 'subscription' }, { id: 'sonnet', access: 'subscription' }] },
  { kind: 'gemini', status: 'unavailable', version: '0.11', path: '/x/gemini', verified: true, reason: 'not signed in', defaultModel: null, models: [] },
  { kind: 'opencode', status: 'ready', version: '1', path: '/x/oc', verified: true, reason: null, defaultModel: 'github-copilot/gpt-5.3-codex',
    models: [{ id: 'github-copilot/gpt-5.3-codex', access: 'subscription' }, ...Array.from({ length: 40 }, (_, i) => ({ id: `openrouter/m${i}`, access: 'api' }))] },
];
const modelsDev = { opus: { name: 'Opus', context: 1000000, costIn: 5, costOut: 25, releaseDate: '2026-05-28', knowledge: '2026-01', lastUpdated: 'x' } };

test('brief keeps only what planning needs', () => {
  const b = buildBrief({ agents, knowledge, modelsDev, stats: {}, config: { maxWorkers: 6 } });
  assert.equal(b.repoDirty, undefined, 'a clean repo says nothing about dirty files');
  assert.deepEqual(b.agents.map((a) => a.kind), ['claude', 'opencode']);
  assert.deepEqual(b.unavailable, [{ kind: 'gemini', status: 'unavailable', reason: 'not signed in' }]);
  assert.equal(b.agents[0].path, undefined);
  assert.equal(b.agents[1].models.length, 25);
  assert.equal(b.agents[1].modelsOmitted, 16);
  assert.deepEqual(Object.keys(b.harnesses).sort(), ['claude', 'opencode']);
  assert.equal(b.harnesses.claude.sources, undefined);
  assert.ok(b.families.every((f) => f.sources === undefined && f.match === undefined));
  assert.deepEqual(b.families.map((f) => f.id).sort(), ['claude-opus', 'claude-sonnet', 'gpt-codex']);
  assert.deepEqual(b.modelFacts, { opus: { context: 1000000, costIn: 5, costOut: 25 } });
  assert.equal(b.sources, undefined);
  assert.equal(b.maxWorkers, 6);
  assert.equal(b.stats, undefined, 'empty stats are left out');
});

test('brief tells the leader when the repo has uncommitted changes', () => {
  const b = buildBrief({ agents, knowledge, modelsDev, stats: {}, config: { maxWorkers: 6 }, repoDirty: true });
  assert.equal(b.repoDirty, true);
});

test('summarizeModels keeps default and subscription first and caps the list', () => {
  const models = [
    ...Array.from({ length: 50 }, (_, i) => ({ id: `openrouter/m${i}`, access: 'api' })),
    { id: 'github-copilot/gpt-5.3-codex', access: 'subscription' },
    { id: 'ollama/qwen', access: 'local' },
  ];
  const s = summarizeModels({ models, defaultModel: 'openrouter/m7' }, 10);
  assert.equal(s.models.length, 10);
  assert.deepEqual(s.models.slice(0, 3).map((m) => m.id), ['openrouter/m7', 'github-copilot/gpt-5.3-codex', 'ollama/qwen']);
  assert.equal(s.modelsTotal, 52);
  assert.equal(s.modelsOmitted, 42);
});

test('brief skips non-coding models and prefers known families', () => {
  const many = { kind: 'opencode', status: 'ready', reason: null, defaultModel: null, models: [
    { id: 'google/gemini-2.5-flash-preview-tts', access: 'api' },
    { id: 'google/gemini-3-pro-image', access: 'api' },
    { id: 'google/deep-research-preview-04-2026', access: 'api' },
    { id: 'openrouter/mystery-model', access: 'api' },
    { id: 'google/gemini-3.1-pro-preview', access: 'api' },
  ] };
  const b = buildBrief({ agents: [many], knowledge, modelsDev: {}, stats: {}, config: { maxWorkers: 6 } });
  assert.deepEqual(b.agents[0].models.map((m) => m.id), ['google/gemini-3.1-pro-preview', 'openrouter/mystery-model']);
  assert.equal(b.agents[0].modelsOmitted, 3);
});
