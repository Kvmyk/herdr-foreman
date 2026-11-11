import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { SOURCES, collectFacts, readSource, finalise, DEFAULT_TTL_DAYS } from '../scripts/knowledge-sources/index.js';
import { normaliseModel, harnessKind, parseCsv, vendorFor } from '../scripts/knowledge-sources/normalise.js';
import { readZip } from '../scripts/knowledge-sources/epoch.js';
import { familyFor } from '../src/knowledge.js';

// Fixtures are cut from the real responses of 2026-11-11 (a few rows each).
const NOW = Date.parse('2026-11-11T12:00:00Z');
const FIXTURES = new URL('./fixtures/sources/', import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES));
const source = (id) => SOURCES.find((s) => s.id === id);

// Minimal ZIP writer (deflate, no CRC check on read) to pack the Epoch CSV fixtures.
function zip(files, { year = 2026, month = 11, day = 11 } = {}) {
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const epochZip = () => zip(Object.fromEntries(
  readdirSync(new URL('epoch/', FIXTURES)).map((f) => [`benchmark_data/${f}`, fixture(`epoch/${f}`)]),
));

const ROUTES = {
  'https://epoch.ai/data/benchmark_data.zip': epochZip,
  'https://livebench.ai/': () => fixture('livebench/index.html'),
  'https://livebench.ai/static/js/main.45868924.js': () => fixture('livebench/main.45868924.js.txt'),
  'https://livebench.ai/data/20261106/table.csv': () => fixture('livebench/table.csv'),
  'https://www.tbench.ai/': () => fixture('tbench.html'),
  'https://www.vals.ai/benchmarks/terminal-bench-4': () => fixture('vals-terminal-bench-4.html'),
  'https://www.vals.ai/benchmarks/vibe-code': () => fixture('vals-vibe-code.html'),
  'https://www.vals.ai/benchmarks/vals_index': () => fixture('vals-vals_index.html'),
  'https://scale.com/leaderboard/swe-atlas': () => fixture('seal-swe-atlas.html'),
  'https://scale.com/leaderboard/swe_bench_pro_public_v2': () => fixture('seal-swe-bench-pro-v2.html'),
};

function response(body, status = 200) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  };
}

// overrides: url -> body (string/Buffer) or function returning one; null means 404.
function fakeFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url in overrides) {
      const o = overrides[url];
      if (o === null) return response('not found', 404);
      return response(typeof o === 'function' ? o() : o);
    }
    if (url.startsWith('https://datasets-server.huggingface.co/rows?')) {
      const config = new URL(url).searchParams.get('config');
      return response(fixture(`lmarena-${config}.json`));
    }
    const route = ROUTES[url];
    return route ? response(route()) : response('not found', 404);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const read = (id, overrides) => readSource(source(id), { fetchImpl: fakeFetch(overrides), now: NOW });
const find = (records, where) => records.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));

// ---- contract ---------------------------------------------------------

test('SOURCES follow the shared contract', () => {
  assert.deepEqual(SOURCES.map((s) => s.id), ['lmarena-webdev', 'lmarena-agent', 'epoch', 'livebench', 'tbench', 'vals', 'seal']);
  for (const s of SOURCES) {
    assert.match(s.url, /^https:\/\//);
    assert.ok(s.title && s.licence, s.id);
    assert.ok(['data', 'html'].includes(s.kind), s.id);
    assert.equal(s.ttlDays, DEFAULT_TTL_DAYS);
    assert.equal(typeof s.read, 'function');
  }
  assert.equal(DEFAULT_TTL_DAYS, 45);
  assert.deepEqual(SOURCES.filter((s) => s.kind === 'html').map((s) => s.id), ['tbench', 'vals', 'seal']);
});

test('collectFacts reads every source from the fixtures', async () => {
  const { records, status } = await collectFacts({ fetchImpl: fakeFetch(), now: NOW });
  assert.deepEqual(Object.keys(status), SOURCES.map((s) => s.id));
  for (const [id, s] of Object.entries(status)) {
    assert.equal(s.ok, true, `${id}: ${s.error}`);
    assert.equal(s.count, records.filter((r) => r.source === id).length);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(status).map(([id, s]) => [id, s.newest])), {
    'lmarena-webdev': '2026-11-10', 'lmarena-agent': '2026-11-08', epoch: '2026-11-11', livebench: '2026-11-06',
    tbench: '2026-11-11', vals: '2026-11-09', seal: '2026-11-06',
  });
  const keys = ['source', 'benchmark', 'model', 'vendor', 'harness', 'effort', 'score', 'unit', 'rank', 'of', 'date', 'category'];
  for (const r of records) {
    assert.deepEqual(Object.keys(r), keys);
    assert.ok(Number.isInteger(r.rank) && Number.isInteger(r.of) && r.rank >= 1 && r.rank <= r.of, JSON.stringify(r));
  }
  // No two records of one source look identical apart from the score.
  const facts = records.map((r) => [r.source, r.benchmark, r.model, r.harness, r.category].join('|'));
  assert.equal(new Set(facts).size, facts.length);
});

test('every fixture model lands in the intended family of knowledge/agents.json', async () => {
  const knowledge = JSON.parse(readFileSync(new URL('../knowledge/agents.json', import.meta.url), 'utf8'));
  const { records } = await collectFacts({ fetchImpl: fakeFetch(), now: NOW });
  const expected = {
    'claude-opus-5.5': 'claude-opus', 'claude-sonnet-5.5': 'claude-sonnet', 'claude-fable-5.2': 'claude-fable',
    'gpt-6.1-sol': 'gpt', 'gpt-6-astra': 'gpt', 'gemini-4-argon': 'gemini-pro', 'gemini-3.8-flash': 'gemini-flash',
    'kimi-k3.1-pro': 'kimi', 'glm-5.3': 'glm', 'qwen3.8-max': 'qwen', 'qwen3.8-max-0902': 'qwen', 'grok-4.7': 'grok',
  };
  for (const [model, family] of Object.entries(expected)) {
    assert.ok(records.some((r) => r.model === model), `no record for ${model}`);
    assert.equal(familyFor(knowledge, model)?.id, family, model);
  }
});

test('a source that throws or answers garbage is ok false and never throws', async () => {
  const boom = async () => { throw new Error('network down'); };
  const { records, status } = await collectFacts({ fetchImpl: boom, now: NOW });
  assert.deepEqual(records, []);
  for (const s of Object.values(status)) {
    assert.equal(s.ok, false);
    assert.equal(s.newest, null);
    assert.equal(s.count, 0);
    assert.match(s.error, /network down/);
  }
  const broken = await readSource(source('lmarena-webdev'), {
    fetchImpl: async () => response('{"rows": "nope"}'), now: NOW,
  });
  assert.deepEqual(broken, { records: [], status: { ok: false, newest: null, count: 0, error: broken.status.error } });
});

test('status.newest is the later of the source update date and the newest result', async () => {
  const rec = { source: 'fake', benchmark: 'b', model: 'm', vendor: null, harness: null, effort: null, score: 50, unit: '%', date: '2026-09-01', category: null };
  const fake = (updated) => ({ id: 'fake', ttlDays: 45, read: async () => Object.assign([rec], updated === undefined ? {} : { updated }) });
  const newest = async (updated) => (await readSource(fake(updated), { fetchImpl: null, now: NOW })).status;
  assert.equal((await newest('2026-11-10')).newest, '2026-11-10');
  assert.equal((await newest(undefined)).newest, '2026-09-01');
  assert.equal((await newest('2026-08-01')).newest, '2026-09-01');
  assert.equal((await newest('yesterday')).ok, false);
});

test('a transient HTTP error is retried, a 404 is not', async () => {
  const inner = fakeFetch();
  let failures = 1;
  const flaky = async (url, opts) => (failures-- > 0 ? response('busy', 502) : inner(url, opts));
  const { status } = await readSource(source('lmarena-agent'), { fetchImpl: flaky, now: NOW });
  assert.equal(status.ok, true);
  const calls = [];
  const missing = async (url) => { calls.push(url); return response('gone', 404); };
  const gone = await readSource(source('lmarena-agent'), { fetchImpl: missing, now: NOW });
  assert.deepEqual([gone.status.ok, calls.length], [false, 1]);
});

test('finalise keeps the best effort per model and harness and ranks with ties', () => {
  const base = { source: 's', benchmark: 'b', vendor: 'x', unit: '%', date: '2026-11-01', category: null };
  const out = finalise([
    { ...base, model: 'a', harness: null, effort: 'high', score: 50 },
    { ...base, model: 'a', harness: null, effort: 'max', score: 60 },
    { ...base, model: 'a', harness: 'claude', effort: null, score: 40 },
    { ...base, model: 'b', harness: null, effort: null, score: 60 },
    { ...base, model: 'c', harness: null, effort: null, score: 10 },
  ]);
  assert.deepEqual(out.map((r) => [r.model, r.harness, r.effort, r.rank, r.of]), [
    ['a', null, 'max', 1, 4], ['b', null, null, 1, 4], ['a', 'claude', null, 3, 4], ['c', null, null, 4, 4],
  ]);
});

// ---- normalisation ----------------------------------------------------

test('normaliseModel keeps dots and moves effort and harness out of the name', () => {
  const cases = [
    ['Claude Opus 5.5 (Max)', {}, 'claude-opus-5.5', 'max', null],
    ['Claude Fable 5.2 (xHigh)', {}, 'claude-fable-5.2', 'xhigh', null],
    ['anthropic/claude-opus-5-5', {}, 'claude-opus-5.5', null, null],
    ['claude-fable-5-1_xhigh', {}, 'claude-fable-5.1', 'xhigh', null],
    ['gemini-3.8-flash_high', {}, 'gemini-3.8-flash', 'high', null],
    ['meta/muse_spark_1_3_max', {}, 'muse-spark-1.3', 'max', null],
    ['Opus 5 (Claude Code)', { vendor: 'anthropic' }, 'claude-opus-5', null, 'Claude Code'],
    ['Gemini 4 Argon (mini-swe-agent)', {}, 'gemini-4-argon', null, 'mini-swe-agent'],
    ['Fable 5.1', { vendor: 'anthropic' }, 'claude-fable-5.1', null, null],
    ['GPT-6.1 Sol', {}, 'gpt-6.1-sol', null, null],
    ['Qwen3.8-Max (0902)', {}, 'qwen3.8-max-0902', null, null],
    ['GPT-5.6 Sol (xHigh, Codex Harness)', {}, 'gpt-5.6-sol', 'xhigh', 'Codex'],
    ['GPT-5.3-Codex (Codex Harness)', {}, 'gpt-5.3-codex', null, 'Codex'],
    ['Claude Opus 4.5 (High, 32K, 20251101)', {}, 'claude-opus-4.5-32k-20251101', 'high', null],
    ['Qwen3.8-Max-0902', {}, 'qwen3.8-max-0902', null, null],
    ['anthropic/claude-opus-4-5-20251101-thinking', {}, 'claude-opus-4.5-20251101-thinking', null, null],
    ['gemma-4-31b', {}, 'gemma-4-31b', null, null],
  ];
  for (const [raw, opts, model, effort, harnessLabel] of cases) {
    assert.deepEqual(normaliseModel(raw, opts), { model, effort, harnessLabel }, raw);
  }
  assert.throws(() => normaliseModel(''), /unusable model name/);
});

test('harness labels map to foreman kinds, other harnesses to null', () => {
  assert.equal(harnessKind('Claude Code'), 'claude');
  assert.equal(harnessKind('Codex'), 'codex');
  assert.equal(harnessKind('Gemini CLI'), 'gemini');
  assert.equal(harnessKind('OpenCode'), 'opencode');
  assert.equal(harnessKind('mini-SWE-agent'), null);
  assert.equal(harnessKind('OpenHands'), null);
  assert.equal(harnessKind(null), null);
});

test('vendorFor trusts the model id over a reseller label', () => {
  assert.equal(vendorFor('gemini-4-argon', 'openai'), 'google');
  assert.equal(vendorFor('glm-5.3', 'Z.ai'), 'zhipu');
  assert.equal(vendorFor('hy4', 'tencent'), 'tencent');
});

test('parseCsv handles quoted commas, quotes and newlines', () => {
  const rows = parseCsv('a,b,c\r\n1,"x, ""y""\nz",3\n4,,6\n');
  assert.deepEqual(rows, [{ a: '1', b: 'x, "y"\nz', c: '3' }, { a: '4', b: '', c: '6' }]);
});

test('readZip reads deflated entries and their dates', () => {
  const entries = readZip(zip({ 'd/a.csv': Buffer.from('x,y\n1,2\n') }, { year: 2026, month: 3, day: 9 }));
  assert.deepEqual(entries.map((e) => [e.name, e.date, e.data().toString()]), [['d/a.csv', '2026-03-09', 'x,y\n1,2\n']]);
  assert.throws(() => readZip(Buffer.from('not a zip')), /not a ZIP/);
});

// ---- data sources -----------------------------------------------------

test('lmarena-webdev: Elo per model, best effort kept', async () => {
  const { records, status } = await read('lmarena-webdev');
  assert.equal(status.ok, true);
  assert.deepEqual(find(records, { model: 'claude-fable-5.2' }), [{
    source: 'lmarena-webdev', benchmark: 'webdev-arena', model: 'claude-fable-5.2', vendor: 'anthropic', harness: null,
    effort: 'xhigh', score: 1835.8, unit: 'elo', rank: 1, of: 7, date: '2026-11-10', category: null,
  }]);
  const sonnet = find(records, { model: 'claude-sonnet-5.5' });
  assert.deepEqual(sonnet.map((r) => r.effort), ['xhigh']);
  // "GPT-5.5 (xHigh, Codex Harness)" is a harness + model pair.
  assert.deepEqual(find(records, { harness: 'codex' }).map((r) => [r.model, r.effort]).sort(), [['gpt-5.5', 'xhigh'], ['gpt-5.6-sol', 'xhigh']]);
  assert.ok(records.some((r) => r.model === 'qwen3.8-max-0902' && r.vendor === 'alibaba'));
});

test('lmarena-agent: rank only, the IPS score is not passed on as % or Elo', async () => {
  const { records } = await read('lmarena-agent');
  assert.deepEqual(records.map((r) => [r.rank, r.of, r.model, r.score, r.unit, r.benchmark]), [
    [1, 4, 'claude-opus-5.5', null, null, 'agent-arena-rank'], [2, 4, 'gemini-4-carbon', null, null, 'agent-arena-rank'],
    [3, 4, 'gpt-6-astra', null, null, 'agent-arena-rank'], [4, 4, 'kimi-k3.1-pro', null, null, 'agent-arena-rank'],
  ]);
});

test('epoch: fresh CSVs from the ZIP as percentages, stale files skipped', async () => {
  const { records, status } = await read('epoch');
  assert.equal(status.ok, true);
  assert.deepEqual([...new Set(records.map((r) => r.benchmark))], ['cursorbench', 'frontierswe']);
  const [fable] = find(records, { benchmark: 'frontierswe', model: 'claude-fable-5.2' });
  assert.deepEqual([fable.score, fable.effort, fable.harness, fable.date, fable.rank], [69.9, 'max', null, '2026-11-11', 1]);
  assert.deepEqual(find(records, { benchmark: 'cursorbench', model: 'claude-fable-5.2' }).map((r) => r.effort), ['max']);
  // deepswe's newest model is from 2026-06-09: read only while that is within ttlDays.
  const early = await readSource(source('epoch'), { fetchImpl: fakeFetch(), now: Date.parse('2026-07-01') });
  assert.ok(early.records.some((r) => r.benchmark === 'deepswe' && r.model === 'claude-fable-5' && r.effort === 'xhigh'));
});

test('epoch: a score that is not a fraction rejects the source', async () => {
  const csv = fixture('epoch/cursorbench_external.csv').toString().replace(/,0\.\d+,/, ',57.8,');
  const files = Object.fromEntries(readdirSync(new URL('epoch/', FIXTURES)).map((f) => [f, fixture(`epoch/${f}`)]));
  files['cursorbench_external.csv'] = Buffer.from(csv);
  const { status } = await read('epoch', { 'https://epoch.ai/data/benchmark_data.zip': () => zip(files) });
  assert.equal(status.ok, false);
  assert.match(status.error, /not a fraction/);
});

test('livebench: newest release from the bundle, coding and long_agentic columns', async () => {
  const fetchImpl = fakeFetch();
  const { records, status } = await readSource(source('livebench'), { fetchImpl, now: NOW });
  assert.equal(status.ok, true);
  assert.ok(fetchImpl.calls.includes('https://livebench.ai/data/20261106/table.csv'));
  assert.deepEqual(find(records, { model: 'claude-opus-5.5' }).map((r) => [r.benchmark, r.score, r.date]), [
    ['livebench-coding', 87.1, '2026-11-06'], ['livebench-long-agentic', 72.8, '2026-11-06'],
  ]);
  const missing = await read('livebench', { 'https://livebench.ai/static/js/main.45868924.js': 'console.log(1)' });
  assert.equal(missing.status.ok, false);
});

// ---- html sources -----------------------------------------------------

test('tbench: Terminal-Bench 4.1 harness + model pairs with foreman kinds', async () => {
  const { records, status } = await read('tbench');
  assert.equal(status.ok, true);
  assert.deepEqual(records.map((r) => [r.rank, r.model, r.harness, r.effort, r.score]), [
    [1, 'claude-opus-5.5', 'claude', 'max', 65.76],
    [2, 'gpt-6.1-sol', 'codex', 'max', 60.91],
    [3, 'gpt-6-astra', 'codex', 'max', 60.3],
    [4, 'claude-fable-5.1', 'claude', 'xhigh', 57.58],
    [5, 'glm-5.3', 'claude', 'max', 41.21],
    [6, 'gemini-3.8-flash', null, 'high', 18.18],
  ]);
  assert.ok(records.every((r) => r.benchmark === 'terminal-bench-4.1'));
  assert.equal(find(records, { model: 'claude-opus-5.5' })[0].date, '2026-09-22');
  // Results keep their submission dates; newest is when the board last changed.
  assert.equal(status.newest, '2026-11-11');
});

test('tbench: newest falls back to the newest result without updated_at', async () => {
  const html = fixture('tbench.html').toString();
  const noUpdate = html.replace(/,\\"updated_at\\":\\"2026-11-11T[^\\]*\\"\}/, '}');
  assert.notEqual(noUpdate, html);
  const { status } = await read('tbench', { 'https://www.tbench.ai/': noUpdate });
  assert.deepEqual([status.ok, status.newest], [true, '2026-09-29']);
  const bad = await read('tbench', { 'https://www.tbench.ai/': html.replace('\\"updated_at\\":\\"2026-11-11T', '\\"updated_at\\":\\"soon') });
  assert.deepEqual([bad.records, bad.status.ok], [[], false]);
});

test('tbench: an unexpected shape gives ok false, never a wrong number', async () => {
  const html = fixture('tbench.html').toString();
  const cases = {
    'accuracy as text': html.replace('\\"accuracy\\":65.76', '\\"accuracy\\":\\"65.76\\"'),
    'no leaderboard': html.replaceAll('leaderboard', 'board'),
    'ranked by something else': html.replace('\\"accessor\\":\\"metrics.accuracy\\",\\"direction\\"', '\\"accessor\\":\\"metrics.cost\\",\\"direction\\"'),
    'no payload': '<html><body>maintenance</body></html>',
  };
  for (const [name, body] of Object.entries(cases)) {
    assert.notEqual(body, html, name);
    const { records, status } = await read('tbench', { 'https://www.tbench.ai/': body });
    assert.deepEqual([records, status.ok], [[], false], name);
  }
});

test('vals: three boards; harness suffixes mapped, runs in foreign harnesses dropped', async () => {
  const { records, status } = await read('vals');
  assert.equal(status.ok, true);
  assert.deepEqual([...new Set(records.map((r) => r.benchmark))], ['vals-terminal-bench-4', 'vibe-code-bench', 'vals-index']);
  const vibe = find(records, { benchmark: 'vibe-code-bench' });
  assert.deepEqual(vibe.filter((r) => /opus-4.8|gpt-5.5/.test(r.model)).map((r) => [r.model, r.harness]).sort(), [
    ['claude-opus-4.8', null], ['claude-opus-4.8', 'claude'], ['gpt-5.5', null], ['gpt-5.5', 'codex'],
  ]);
  assert.ok(!records.some((r) => r.model.includes('factory')));
  const [muse] = find(records, { benchmark: 'vals-terminal-bench-4', model: 'muse-spark-1.3' });
  assert.equal(muse.effort, 'max');
  const [opus] = find(records, { benchmark: 'vals-terminal-bench-4', model: 'claude-opus-5.5' });
  assert.deepEqual([opus.score, opus.rank, opus.date, opus.vendor], [65.152, 1, '2026-11-09', 'anthropic']);
});

test('vals: an unexpected shape gives ok false, never a wrong number', async () => {
  const url = 'https://www.vals.ai/benchmarks/vibe-code';
  const html = fixture('vals-vibe-code.html').toString();
  const cases = {
    'no overall results': html.replaceAll('&quot;overall&quot;', '&quot;everything&quot;'),
    'accuracy above 100': html.replace(/(&quot;accuracy&quot;:\[0,)[0-9.]+/, '$19377.1'),
    'another benchmark on the page': html.replace('&quot;slug&quot;:[0,&quot;vibe-code&quot;]', '&quot;slug&quot;:[0,&quot;swebench&quot;]'),
    'plain JSON props': html.replace(/props="[^"]*benchmarkView[^"]*"/, 'props="{&quot;benchmarkView&quot;:{&quot;tasks&quot;:{}}}"'),
  };
  for (const [name, body] of Object.entries(cases)) {
    assert.notEqual(body, html, name);
    const { records, status } = await read('vals', { [url]: body });
    assert.deepEqual([records, status.ok], [[], false], name);
  }
});

test('seal: SWE Atlas variants become benchmarks with categories, SWE-bench Pro only harness pairs', async () => {
  const { records, status } = await read('seal');
  assert.equal(status.ok, true);
  const atlas = records.filter((r) => r.benchmark.startsWith('swe-atlas'));
  assert.deepEqual([...new Set(atlas.map((r) => `${r.benchmark}:${r.category}`))], [
    'swe-atlas-qna:analysis', 'swe-atlas-testwriting:test-writing', 'swe-atlas-refactoring:refactor',
  ]);
  assert.deepEqual(find(atlas, { benchmark: 'swe-atlas-refactoring', rank: 1 }).map((r) => [r.model, r.score, r.date]), [['claude-opus-5.5', 77.1, '2026-11-06']]);
  assert.equal(find(atlas, { model: 'claude-opus-5.5' }).length, 3);
  const pro = find(records, { benchmark: 'swe-bench-pro-v2' });
  assert.deepEqual(pro.map((r) => [r.model, r.harness, r.effort, r.score]), [
    ['claude-opus-5', 'claude', 'xhigh', 99.4], ['gpt-6-astra', 'codex', 'high', 96.9], ['gpt-5.6-sol', 'codex', 'xhigh', 95.5],
  ]);
  assert.ok(!records.some((r) => /inkling/.test(r.model) && r.benchmark.startsWith('swe-bench-pro')));
  assert.ok(records.filter((r) => r.benchmark.startsWith('swe-bench-pro')).every((r) => r.category === null));
});

test('seal: an unexpected shape gives ok false, never a wrong number', async () => {
  const atlasUrl = 'https://scale.com/leaderboard/swe-atlas';
  const html = fixture('seal-swe-atlas.html').toString();
  const cases = {
    'variant renamed': html.replace('\\"key\\":\\"qna\\"', '\\"key\\":\\"questions\\"'),
    'score as text': html.replaceAll(/(\\"score\\":)([0-9.]+)/g, '$1\\"$2\\"'),
    'no variants': html.replaceAll('variants', 'tabs'),
  };
  for (const [name, body] of Object.entries(cases)) {
    assert.notEqual(body, html, name);
    const { records, status } = await read('seal', { [atlasUrl]: body });
    assert.deepEqual([records, status.ok], [[], false], name);
  }
  const gone = await read('seal', { 'https://scale.com/leaderboard/swe_bench_pro_public_v2': null });
  assert.deepEqual([gone.records, gone.status.ok], [[], false]);
  assert.match(gone.status.error, /HTTP 404/);
});
