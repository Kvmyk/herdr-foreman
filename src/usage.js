// Tokens each worker used, read from the logs its agent writes itself, and
// what they would cost at API prices (models.dev, per million tokens). Only
// claude (~/.claude/projects) and codex (~/.codex/sessions) logs are read;
// for other agents, or when no log is found, usage is null. With a
// subscription the cost is what the same tokens would cost through the API.
import fs from 'node:fs';
import path from 'node:path';
import { lookupModel } from './knowledge.js';

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const addTo = (sum, t) => { for (const k of FIELDS) sum[k] += t[k] ?? 0; return sum; };
const total = (t) => FIELDS.reduce((s, k) => s + (t[k] ?? 0), 0);

const norm = (p) => {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function lines(file, fsx) {
  try {
    return fsx.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

function list(dir, fsx) {
  try {
    return fsx.readdirSync(dir);
  } catch {
    return [];
  }
}

// Claude Code keeps a folder per working directory, named after its path
// with every character other than a letter or digit turned into "-".
export const claudeProjectName = (cwd) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');

function claudeDirs(root, worktree, fsx) {
  const name = claudeProjectName(worktree);
  if (fsx.existsSync(path.join(root, name))) return [path.join(root, name)];
  // Very long paths are cut and get a hash appended.
  if (name.length > 200) return list(root, fsx).filter((d) => d.startsWith(name.slice(0, 200))).map((d) => path.join(root, d));
  return [];
}

// { model: tokens } from the worker's Claude Code sessions, or null.
export function claudeUsage({ worktree, home, env = {}, since = null, fsx = fs }) {
  const root = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
  // A reply is logged once per content block with the same message id; the last one counts.
  const replies = new Map();
  for (const dir of claudeDirs(root, worktree, fsx)) {
    for (const file of list(dir, fsx).filter((f) => f.endsWith('.jsonl'))) {
      for (const line of lines(path.join(dir, file), fsx)) {
        if (!line.includes('"usage"')) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const m = o.message;
        if (o.type !== 'assistant' || !m?.usage || m.model === '<synthetic>') continue;
        if (since && o.timestamp && o.timestamp < since) continue;
        replies.set(m.id ?? o.uuid, { model: m.model ?? 'unknown', u: m.usage });
      }
    }
  }
  if (!replies.size) return null;
  const byModel = {};
  for (const { model, u } of replies.values()) {
    addTo(byModel[model] ??= empty(), {
      input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
    });
  }
  return byModel;
}

const DAY = 24 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');

// Codex files sessions under the local date: every day of the run, one either side.
function codexDays(since, until) {
  const out = [];
  for (let t = Date.parse(since) - DAY; t <= Date.parse(until) + DAY; t += DAY) {
    const d = new Date(t);
    out.push([String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())]);
  }
  return out.slice(0, 62);
}

// { model: tokens } from the worker's Codex sessions, or null. A session's
// last token_count holds its running total; cached input is part of input.
export function codexUsage({ worktree, home, env = {}, since, until, fsx = fs }) {
  if (!since) return null;
  const root = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
  const byModel = {};
  let found = false;
  for (const day of codexDays(since, until ?? new Date().toISOString())) {
    const dir = path.join(root, ...day);
    for (const file of list(dir, fsx).filter((f) => f.endsWith('.jsonl'))) {
      const all = lines(path.join(dir, file), fsx);
      let meta;
      try {
        meta = JSON.parse(all[0]);
      } catch {
        continue;
      }
      if (meta?.type !== 'session_meta' || !meta.payload?.cwd || norm(meta.payload.cwd) !== norm(worktree)) continue;
      let model = 'unknown';
      let last = null;
      for (const line of all) {
        if (!line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type === 'turn_context' && o.payload?.model) model = o.payload.model;
        if (o.payload?.type === 'token_count' && o.payload.info?.total_token_usage) last = o.payload.info.total_token_usage;
      }
      if (!last) continue;
      found = true;
      const cached = last.cached_input_tokens ?? 0;
      addTo(byModel[model] ??= empty(), { input: (last.input_tokens ?? 0) - cached, output: last.output_tokens, cacheRead: cached });
    }
  }
  return found ? byModel : null;
}

const READERS = { claude: claudeUsage, codex: codexUsage };

// US dollars at API prices, or null when models.dev has no price for the model.
export function costOf(model, t, modelsDev) {
  const f = modelsDev && model ? lookupModel(modelsDev, model) : null;
  if (!f || typeof f.costIn !== 'number' || typeof f.costOut !== 'number') return null;
  const cacheRead = f.costCacheRead ?? f.costIn * 0.1;
  const cacheWrite = f.costCacheWrite ?? f.costIn * 1.25;
  return (t.input * f.costIn + t.output * f.costOut + t.cacheRead * cacheRead + t.cacheWrite * cacheWrite) / 1e6;
}

// One worker: { tokens, total, costUsd, costKnown, models: [...] }, or null.
export function workerUsage(w, { run, home, env, modelsDev, fsx = fs }) {
  const read = READERS[w.kind];
  if (!read) return null;
  const since = w.startedAt ?? run.createdAt ?? null;
  const byModel = read({ worktree: w.worktree, home, env, since, until: w.endedAt ?? run.cleanedAt ?? null, fsx });
  if (!byModel) return null;
  const models = Object.entries(byModel).map(([model, tokens]) => ({ model, tokens, total: total(tokens), costUsd: costOf(model, tokens, modelsDev) }));
  const tokens = models.reduce((s, m) => addTo(s, m.tokens), empty());
  const known = models.filter((m) => m.costUsd !== null);
  return {
    tokens,
    total: total(tokens),
    costUsd: known.length ? known.reduce((s, m) => s + m.costUsd, 0) : null,
    costKnown: known.length === models.length,
    models,
  };
}

// The whole run: per worker and summed. unknown lists workers without logs.
export function runUsage(run, ctx) {
  const workers = Object.fromEntries(run.workers.map((w) => [w.name, workerUsage(w, { run, ...ctx })]));
  const read = Object.values(workers).filter(Boolean);
  const tokens = read.reduce((s, u) => addTo(s, u.tokens), empty());
  const priced = read.filter((u) => u.costUsd !== null);
  return {
    workers,
    total: total(tokens),
    tokens,
    costUsd: priced.length ? priced.reduce((s, u) => s + u.costUsd, 0) : null,
    costKnown: read.length > 0 && read.every((u) => u.costKnown),
    unknown: run.workers.filter((w) => !workers[w.name]).map((w) => w.name),
  };
}

export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

// "~$1.23", or "cost unknown" when any model in it has no price (a partial sum would read too low).
export const costText = (u) => (u.costUsd === null || u.costKnown === false ? 'cost unknown' : `~$${u.costUsd.toFixed(2)}`);

// "1.2M tokens (out 34k), ~$1.23"; "no log" when nothing was read.
export function formatUsage(u) {
  if (!u || !u.total) return 'usage unknown';
  const cost = costText(u);
  return `${formatTokens(u.total)} tokens (out ${formatTokens(u.tokens.output)}), ${cost}`;
}

// Journal entries get tokens and costUsd from the run they name: the worker
// called entry.worker, else the only worker with that kind and model.
export function usageForEntries(entries, { loadRun, ctx }) {
  const list = Array.isArray(entries) ? entries : [entries];
  return list.map((e) => {
    if (!e || typeof e !== 'object' || e.tokens !== undefined) return e;
    const run = typeof e.task === 'string' ? loadRun(e.task) : null;
    if (!run) return e;
    const matches = run.workers.filter((w) => (e.worker ? w.name === e.worker : w.kind === e.kind && (e.model == null || w.model === e.model)));
    if (matches.length !== 1) return e;
    const u = workerUsage(matches[0], { run, ...ctx });
    if (!u) return e;
    return { ...e, tokens: u.total, ...(u.costUsd !== null && u.costKnown ? { costUsd: Math.round(u.costUsd * 10000) / 10000 } : {}) };
  });
}
