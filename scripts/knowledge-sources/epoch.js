// Epoch AI benchmarking hub: one ZIP of CSV files (CC-BY-4.0), rebuilt daily.
// Only the coding files that still get new models are read; a file whose
// newest model release is older than ttlDays is skipped. WebDev Arena is left
// out because it mirrors LMArena, which is read directly.
import { inflateRawSync } from 'node:zlib';
import { getBuffer, parseCsv, normaliseModel, effortWord, vendorFor, harnessKind, isoDay, percent, fail } from './normalise.js';

const URL = 'https://epoch.ai/data/benchmark_data.zip';
const DAY = 24 * 3600 * 1000;

// file -> how to read it; scores are fractions 0..1
const FILES = {
  'cursorbench_external.csv': { benchmark: 'cursorbench', score: 'Score' },
  'frontierswe_external.csv': { benchmark: 'frontierswe', score: 'Score', harness: 'Harness' },
  'deepswe_external.csv': { benchmark: 'deepswe', score: 'Pass@1', harness: 'Harness', effort: 'Reasoning effort' },
};

// Entries of a ZIP archive: {name, date, data()}. Stored and deflated entries only, no ZIP64.
export function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) fail('not a ZIP archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) fail('broken ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const day = buf.readUInt16LE(p + 14);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    if (size === 0xffffffff || compressed === 0xffffffff || offset === 0xffffffff) fail('ZIP64 is not supported');
    const date = `${(day >> 9) + 1980}-${String((day >> 5) & 15).padStart(2, '0')}-${String(day & 31).padStart(2, '0')}`;
    entries.push({
      name, date,
      data() {
        if (buf.readUInt32LE(offset) !== 0x04034b50) fail(`broken ZIP entry ${name}`);
        const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
        const raw = buf.subarray(start, start + compressed);
        if (method === 0) return raw;
        if (method === 8) return inflateRawSync(raw);
        fail(`ZIP method ${method} is not supported`);
      },
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readFile(entry, spec, { now, ttlDays }) {
  const rows = parseCsv(entry.data().toString('utf8'));
  if (!rows.length) fail(`${entry.name}: no rows`);
  for (const col of ['Model version', 'Release date', spec.score, spec.harness, spec.effort].filter(Boolean)) {
    if (!(col in rows[0])) fail(`${entry.name}: missing column ${col}`);
  }
  const newest = rows.map((r) => isoDay(r['Release date'])).filter(Boolean).sort().pop();
  if (!newest || now - Date.parse(newest) > ttlDays * DAY) return [];
  const date = isoDay(entry.date) ?? fail(`${entry.name}: bad ZIP date`);
  return rows.filter((r) => r['Model version'] && r[spec.score] !== '').map((r) => {
    const { model, effort } = normaliseModel(r['Model version']);
    const fraction = Number(r[spec.score]);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) fail(`${entry.name}: score is not a fraction: ${r[spec.score]}`);
    return {
      source: 'epoch', benchmark: spec.benchmark, model, vendor: vendorFor(model, r.Organization),
      harness: spec.harness ? harnessKind(r[spec.harness]) : null,
      effort: effort ?? (spec.effort ? effortWord(r[spec.effort]) : null),
      score: percent(Math.round(fraction * 1000) / 10, entry.name), unit: '%', date, category: null,
    };
  });
}

export default {
  id: 'epoch',
  url: URL,
  title: 'Epoch AI benchmarking hub',
  kind: 'data',
  licence: 'CC-BY-4.0',
  async read({ fetchImpl, now, ttlDays = 45 }) {
    const entries = readZip(await getBuffer(fetchImpl, URL));
    const records = [];
    for (const [name, spec] of Object.entries(FILES)) {
      const entry = entries.find((e) => e.name.split('/').pop() === name) ?? fail(`missing ${name}`);
      records.push(...readFile(entry, spec, { now, ttlDays }));
    }
    return records;
  },
};
