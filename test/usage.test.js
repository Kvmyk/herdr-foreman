import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './git-repo.js';
import {
  claudeProjectName, claudeUsage, codexUsage, costOf, workerUsage, runUsage, formatUsage, formatTokens, usageForEntries,
} from '../src/usage.js';
import { computeStats } from '../src/journal.js';
import { formatShow, formatRuns } from '../src/history.js';

const home = () => makeTempDir('foreman-usage-');
const worktree = path.resolve('/s/worktrees/shop-abc/fix-login/w1');
const prices = { 'claude-opus-5-5': { costIn: 5, costOut: 25, costCacheRead: 0.5, costCacheWrite: 6.25 }, 'gpt-5-1-codex': { costIn: 1.25, costOut: 10 } };

const assistant = (id, model, usage, timestamp = '2026-11-09T10:00:00.000Z') => JSON.stringify({ type: 'assistant', timestamp, message: { id, model, usage } });

function claudeLog(h, wt, lines) {
  const dir = path.join(h, '.claude', 'projects', claudeProjectName(wt));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'session.jsonl'), `${lines.join('\n')}\n`);
}

function codexLog(h, day, name, cwd, lines) {
  const dir = path.join(h, '.codex', 'sessions', ...day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), [JSON.stringify({ type: 'session_meta', payload: { cwd } }), ...lines].join('\n'));
}

test('claude project folder name replaces every non letter or digit', () => {
  const name = claudeProjectName(worktree);
  assert.match(name, /^[A-Za-z0-9-]+$/);
  assert.ok(name.endsWith('-s-worktrees-shop-abc-fix-login-w1'));
});

test('claudeUsage sums replies once per message id, per model', () => {
  const h = home();
  try {
    claudeLog(h, worktree, [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistant('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
      // The same reply logged again for its next content block: counted once.
      assistant('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
      assistant('m2', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 3, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }),
      assistant('m3', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
      assistant('m0', 'claude-opus-5-5', { input_tokens: 999, output_tokens: 999 }, '2026-11-08T00:00:00.000Z'),
      'not json',
    ]);
    assert.deepEqual(claudeUsage({ worktree, home: h, since: '2026-11-09T00:00:00.000Z' }), {
      'claude-opus-5-5': { input: 11, output: 10, cacheRead: 300, cacheWrite: 50 },
    });
    assert.equal(claudeUsage({ worktree: path.resolve('/other'), home: h }), null);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('codexUsage reads the last running total of sessions in the worktree', () => {
  const h = home();
  try {
    const day = ['2026', '11', '09'];
    const count = (input, cached, output) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    codexLog(h, day, 'rollout-a.jsonl', worktree, [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.1-codex' } }),
      count(100, 60, 10),
      count(300, 200, 40),
    ]);
    codexLog(h, day, 'rollout-b.jsonl', path.resolve('/elsewhere'), [count(5000, 0, 5000)]);
    const u = codexUsage({ worktree, home: h, since: '2026-11-09T10:00:00.000Z', until: '2026-11-09T11:00:00.000Z' });
    assert.deepEqual(u, { 'gpt-5.1-codex': { input: 100, output: 40, cacheRead: 200, cacheWrite: 0 } });
    assert.equal(codexUsage({ worktree, home: h, since: null }), null);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('costOf uses models.dev prices per million tokens; unknown model is null', () => {
  const t = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 };
  assert.equal(costOf('claude-opus-5-5', t, prices), 5 + 25 + 0.5 + 6.25);
  // Without cache prices: a tenth of input for reads, 1.25x for writes.
  assert.equal(costOf('gpt-5.1-codex', { input: 1e6, output: 0, cacheRead: 1e6, cacheWrite: 0 }, prices), 1.25 + 0.125);
  assert.equal(costOf('mystery', t, prices), null);
  assert.equal(costOf('claude-opus-5-5', t, null), null);
});

test('workerUsage and runUsage: per worker, summed, unknown agents listed', () => {
  const h = home();
  try {
    claudeLog(h, worktree, [assistant('m1', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    const run = {
      task: 'fix-login',
      createdAt: '2026-11-09T09:00:00.000Z',
      workers: [
        { name: 'w1', kind: 'claude', worktree, startedAt: '2026-11-09T09:00:00.000Z' },
        { name: 'w2', kind: 'agy', worktree: path.resolve('/s/w2') },
      ],
    };
    const ctx = { home: h, env: {}, modelsDev: prices };
    const w1 = workerUsage(run.workers[0], { run, ...ctx });
    assert.equal(w1.total, 3000);
    assert.equal(w1.costUsd, (1000 * 5 + 2000 * 25) / 1e6);
    assert.equal(w1.costKnown, true);
    assert.equal(workerUsage(run.workers[1], { run, ...ctx }), null);
    const all = runUsage(run, ctx);
    assert.equal(all.total, 3000);
    assert.deepEqual(all.unknown, ['w2']);
    assert.equal(formatUsage(all), '3.0k tokens (out 2.0k), ~$0.06');
    assert.equal(formatUsage(null), 'usage unknown');
    assert.equal(formatUsage(runUsage(run, { ...ctx, modelsDev: {} })), '3.0k tokens (out 2.0k), cost unknown');
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('formatTokens', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(34000), '34k');
  assert.equal(formatTokens(1234567), '1.2M');
});

test('journal entries get tokens and cost of their worker; stats average them', () => {
  const h = home();
  try {
    claudeLog(h, worktree, [assistant('m1', 'claude-opus-5-5', { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    const run = { task: 'fix-login', createdAt: '2026-11-09T09:00:00.000Z', workers: [{ name: 'w1', kind: 'claude', model: 'opus', worktree }, { name: 'w2', kind: 'codex', model: null, worktree: '/x' }] };
    const loadRun = (t) => (t === 'fix-login' ? run : null);
    const entries = [
      { task: 'fix-login', kind: 'claude', model: 'opus' },
      { task: 'fix-login', kind: 'claude', model: 'sonnet' },
      { task: 'other', kind: 'claude', model: 'opus' },
      { task: 'fix-login', worker: 'w2', kind: 'codex', model: null },
    ];
    const out = usageForEntries(entries, { loadRun, ctx: { home: h, env: {}, modelsDev: prices } });
    assert.equal(out[0].tokens, 1e6);
    assert.equal(out[0].costUsd, 5);
    assert.equal(out[1].tokens, undefined);
    assert.equal(out[2].tokens, undefined);
    assert.equal(out[3].tokens, undefined);

    const base = { category: 'bugfix', kind: 'claude', model: 'opus', proposed: 1, approved: 1, rejected: 0, testsPassed: true, reviewPassed: true, fixRounds: 0, stuck: false };
    const stats = computeStats([{ ...base, tokens: 1000, costUsd: 0.5 }, { ...base, tokens: 3000, costUsd: 1 }, { ...base }]);
    assert.equal(stats.bugfix[0].avgTokens, 2000);
    assert.equal(stats.bugfix[0].avgCostUsd, 0.75);
    assert.equal('avgTokens' in computeStats([base]).bugfix[0], false);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('show and runs print usage', () => {
  const usage = { total: 3000, tokens: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.055, costKnown: true, unknown: ['w2'] };
  const text = formatShow({
    task: 't', repo: '/r', base: 'abc', phase: 'cleaned', merged: [], usage,
    workers: [{ name: 'w1', kind: 'claude', model: null, state: 'removed', reports: [], usage }, { name: 'w2', kind: 'agy', model: null, state: 'removed', reports: [], usage: null }],
  });
  assert.match(text, /usage\s+3\.0k tokens \(out 2\.0k\), ~\$0\.06; no log for w2/);
  assert.match(text, /usage unknown/);
  assert.match(formatRuns([{ task: 't', phase: 'cleaned', outcome: 'landed', branch: 'b', workers: 2, liveWorkers: [], createdAt: null, repo: '/r', usage }]), /3\.0k ~\$0\.06/);
});

test('a cost with a model without a price reads "cost unknown"; one worker is not "1 workers"', () => {
  const usage = { total: 3000, tokens: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, costKnown: false, unknown: [] };
  assert.match(formatUsage(usage), /cost unknown$/);
  const row = formatRuns([{ task: 't', phase: 'landed', outcome: 'landed', branch: 'b', workers: 1, liveWorkers: [], createdAt: null, repo: '/r', usage }]);
  assert.match(row, /3\.0k cost unknown/);
  assert.match(row, /1 worker\b/);
  assert.doesNotMatch(row, /landed \(landed\)/);
});
