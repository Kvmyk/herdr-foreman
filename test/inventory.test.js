import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PROBES, HERDR_KINDS } from '../src/inventory/kinds.js';
import { inventory } from '../src/inventory/index.js';
import { fakeRun } from './helpers.js';

const home = '/home/k';
const ctx = (run, { files = {}, env = {} } = {}) => ({
  run,
  env,
  home,
  readJson: (p) => files[p] ?? null,
  exists: (p) => p in files,
});

test('herdr kinds list matches herdr 0.9.5', () => {
  assert.equal(HERDR_KINDS.length, 24);
  assert.ok(HERDR_KINDS.includes('agy') && HERDR_KINDS.includes('opencode'));
});

test('claude ready with subscription access', async () => {
  const run = fakeRun({ 'claude auth status': { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }) } });
  const files = { [path.join(home, '.claude', 'settings.json')]: { model: 'opus' } };
  const r = await PROBES.claude.probe(ctx(run, { files }));
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.models.map((m) => m.id), ['opus', 'sonnet', 'haiku']);
  assert.ok(r.models.every((m) => m.access === 'subscription'));
  assert.equal(r.defaultModel, 'opus');
});

test('claude logged out is unavailable', async () => {
  const run = fakeRun({ 'claude auth status': { code: 1, stdout: JSON.stringify({ loggedIn: false }) } });
  const r = await PROBES.claude.probe(ctx(run));
  assert.equal(r.status, 'unavailable');
  assert.match(r.reason, /claude auth login/);
});

test('agy lists models', async () => {
  const run = fakeRun({ 'agy models': { stdout: 'Claude Sonnet 4.6 (Thinking)\nClaude Opus 4.6 (Thinking)\nGPT-OSS 120B (Medium)\n' } });
  const files = { [path.join(home, '.gemini', 'antigravity-cli', 'settings.json')]: { model: 'Gemini 3.1 Pro (High)' } };
  const r = await PROBES.agy.probe(ctx(run, { files }));
  assert.equal(r.status, 'ready');
  assert.equal(r.models.length, 3);
  assert.equal(r.defaultModel, null);
  assert.match(r.reason, /Gemini 3\.1 Pro \(High\)" is not offered/);
});

test('agy 1.5 prints slug and name; default maps to slug', async () => {
  const out = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n';
  const run = fakeRun({ 'agy models': { stdout: out } });
  const files = { [path.join(home, '.gemini', 'antigravity-cli', 'settings.json')]: { model: 'Claude Opus 4.6 (Thinking)' } };
  const r = await PROBES.agy.probe(ctx(run, { files }));
  assert.deepEqual(r.models.map((m) => m.id), ['gemini-3.8-flash-high', 'claude-opus-4-6-thinking']);
  assert.equal(r.models[1].name, 'Claude Opus 4.6 (Thinking)');
  assert.equal(r.defaultModel, 'claude-opus-4-6-thinking');
});

test('agy without sign-in is unavailable', async () => {
  const run = fakeRun({ 'agy models': { code: 1, stderr: 'not signed in' } });
  const r = await PROBES.agy.probe(ctx(run));
  assert.equal(r.status, 'unavailable');
});

test('opencode classifies access by provider', async () => {
  const out = '\x1b[0mgithub-copilot/gpt-5.3-codex\nopencode/glm-5.3-flash-free\nollama/qwen2.5-coder:7b-instruct-q4_K_M\ngoogle/gemini-3.5-flash\n';
  const run = fakeRun({ 'opencode models': { stdout: out } });
  const files = {
    [path.join(home, '.local', 'state', 'opencode', 'model.json')]: { recent: [{ providerID: 'github-copilot', modelID: 'gpt-5.3-codex' }] },
  };
  const r = await PROBES.opencode.probe(ctx(run, { files }));
  assert.equal(r.status, 'ready');
  const access = Object.fromEntries(r.models.map((m) => [m.id, m.access]));
  assert.deepEqual(access, {
    'github-copilot/gpt-5.3-codex': 'subscription',
    'opencode/glm-5.3-flash-free': 'free',
    'ollama/qwen2.5-coder:7b-instruct-q4_K_M': 'local',
    'google/gemini-3.5-flash': 'api',
  });
  assert.equal(r.defaultModel, 'github-copilot/gpt-5.3-codex');
});

test('pi parses table', async () => {
  const out = 'provider  model               context  max-out  thinking  images\nlmstudio  openai/gpt-oss-20b  128K     16.4K    yes       no    \n';
  const run = fakeRun({ 'pi --list-models': { stdout: out } });
  const r = await PROBES.pi.probe(ctx(run));
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.models, [{ id: 'lmstudio/openai/gpt-oss-20b', access: 'local' }]);
  assert.equal(r.defaultModel, 'lmstudio/openai/gpt-oss-20b');
});

test('pi with no models is unavailable', async () => {
  const run = fakeRun({ 'pi --list-models': { stdout: 'No models available.\n' } });
  const r = await PROBES.pi.probe(ctx(run));
  assert.equal(r.status, 'unavailable');
});

test('gemini oauth only is unavailable with migration reason', async () => {
  const files = { [path.join(home, '.gemini', 'oauth_creds.json')]: {} };
  const r = await PROBES.gemini.probe(ctx(fakeRun(), { files }));
  assert.equal(r.status, 'unavailable');
  assert.match(r.reason, /2026-06-18/);
});

test('gemini with api key is ready', async () => {
  const r = await PROBES.gemini.probe(ctx(fakeRun(), { env: { GEMINI_API_KEY: 'x' } }));
  assert.equal(r.status, 'ready');
});

test('model args per kind', () => {
  assert.deepEqual(PROBES.opencode.modelArgs('a/b'), ['--model', 'a/b']);
  assert.deepEqual(PROBES.codex.modelArgs('gpt-5.5'), ['-m', 'gpt-5.5']);
});

test('inventory skips kinds not on PATH and marks unknown kinds', async () => {
  const run = fakeRun([
    [/--version$/, { stdout: '1.0.0\n' }],
    ['claude auth status', { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) }],
  ]);
  const which = (k) => (k === 'claude' || k === 'kimi' ? `/bin/${k}` : null);
  const list = await inventory({ run, which, env: {}, home, readJson: () => null, exists: () => false });
  assert.deepEqual(list.map((a) => [a.kind, a.status]), [['claude', 'ready'], ['kimi', 'unknown']]);
  assert.equal(list[0].version, '1.0.0');
  assert.match(list[1].reason, /no probe/);
});

test('inventory marks slow probe as unknown', async () => {
  const run = fakeRun([
    [/--version$/, { stdout: '1\n' }],
    ['agy models', () => new Promise((r) => setTimeout(() => r({ stdout: 'x\n' }), 500))],
  ]);
  const list = await inventory({ run, which: (k) => (k === 'agy' ? '/bin/agy' : null), env: {}, home, readJson: () => null, exists: () => false, timeoutMs: 50 });
  assert.equal(list[0].status, 'unknown');
  assert.equal(list[0].reason, 'probe timed out');
});

test('inventory honours exclude', async () => {
  const run = fakeRun([[/--version$/, { stdout: '1\n' }]]);
  const list = await inventory({ run, which: (k) => (k === 'kimi' ? '/bin/kimi' : null), env: {}, home, readJson: () => null, exists: () => false, exclude: ['kimi'] });
  assert.equal(list.length, 0);
});

test('lean and effort args per kind', () => {
  assert.ok(PROBES.claude.leanArgs.worker.includes('--strict-mcp-config'));
  assert.ok(PROBES.claude.leanArgs.leader.join(' ').includes('AskUserQuestion'));
  assert.ok(!PROBES.claude.leanArgs.worker.join(' ').includes('AskUserQuestion'));
  assert.deepEqual(PROBES.claude.effortArgs('low'), ['--effort', 'low']);
  assert.deepEqual(PROBES.agy.effortArgs('high'), ['--effort', 'high']);
  assert.equal(PROBES.opencode.effortArgs, undefined);
});

test('a remembered default that is no longer listed is dropped with a note', async () => {
  const run = fakeRun([[/--version$/, { stdout: '1\n' }], ['opencode models', { stdout: 'google/gemini-3.5-flash\n' }]]);
  const readJson = (p) => (p.endsWith('model.json') ? { recent: [{ providerID: 'github-copilot', modelID: 'gpt-5.3-codex' }] } : null);
  const [a] = await inventory({ run, which: (k) => (k === 'opencode' ? '/bin/opencode' : null), env: {}, home, readJson, exists: () => false });
  assert.equal(a.status, 'ready');
  assert.equal(a.defaultModel, null);
  assert.match(a.reason, /github-copilot\/gpt-5\.3-codex/);
});
