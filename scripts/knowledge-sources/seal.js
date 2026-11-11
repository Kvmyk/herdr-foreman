// Scale SEAL leaderboards. Each page embeds {"variants": [{key, label,
// entries: [{model, version, rank, score, company, createdAt}]}]} in its
// Next.js RSC payload. SWE Atlas variants map to foreman categories; SWE-bench
// Pro V2 is read only for entries that name a foreman harness ("Opus 5 (Claude
// Code)"), since its scores sit near the ceiling and say little on their own.
import { getText, nextFlight, grabJson, normaliseModel, effortWord, vendorFor, vendorLabel, harnessKind, isoDay, percent, fail } from './normalise.js';

const BASE = 'https://scale.com/leaderboard/';
const ATLAS = { qna: 'analysis', testwriting: 'test-writing', refactoring: 'refactor' };
const PRO = { full: 'swe-bench-pro-v2', hard: 'swe-bench-pro-v2-hard' };

export function variants(html) {
  const text = nextFlight(html);
  const out = {};
  for (const m of text.matchAll(/\{"variants":\[/g)) {
    const { variants: list } = grabJson(text, m.index);
    for (const v of list) {
      if (typeof v?.key !== 'string' || !Array.isArray(v.entries)) fail('seal: variant without key or entries');
      out[v.key] = v.entries;
    }
  }
  return out;
}

function entryRecord(e, where) {
  if (typeof e?.model !== 'string') fail(`seal ${where}: entry without model`);
  // SWE-bench Pro writes the effort after the harness: "Opus 5 (Claude Code) xhigh".
  const raw = e.model.trim();
  const tail = raw.match(/^(.*\))\s+([a-z]+)$/i);
  const name = tail && effortWord(tail[2]) ? tail[1] : raw;
  const { model, effort: named, harnessLabel } = normaliseModel(name, { vendor: vendorLabel(e.company) });
  const effort = name === raw ? named : effortWord(tail[2]);
  return {
    record: {
      source: 'seal', model, vendor: vendorFor(model, e.company), effort: effortWord(e.version ?? '') ?? effort,
      score: percent(e.score, `seal ${where} ${e.model}`), unit: '%',
      date: isoDay(e.createdAt) ?? fail(`seal ${where}: bad createdAt ${e.createdAt}`),
    },
    harnessLabel,
  };
}

export function parseAtlas(html) {
  const found = variants(html);
  const records = [];
  for (const [key, category] of Object.entries(ATLAS)) {
    const entries = found[key] ?? fail(`seal: SWE Atlas variant ${key} missing`);
    if (!entries.length) fail(`seal: SWE Atlas variant ${key} empty`);
    for (const e of entries) {
      const { record } = entryRecord(e, `swe-atlas ${key}`);
      records.push({ ...record, benchmark: 'swe-atlas', harness: null, category });
    }
  }
  return records;
}

export function parsePro(html) {
  const found = variants(html);
  const records = [];
  for (const [key, benchmark] of Object.entries(PRO)) {
    const entries = found[key] ?? fail(`seal: SWE-bench Pro variant ${key} missing`);
    if (!entries.length) fail(`seal: SWE-bench Pro variant ${key} empty`);
    for (const e of entries) {
      const { record, harnessLabel } = entryRecord(e, benchmark);
      const harness = harnessKind(harnessLabel);
      if (harness) records.push({ ...record, benchmark, harness, category: null });
    }
  }
  return records;
}

export default {
  id: 'seal',
  url: BASE,
  title: 'Scale SEAL leaderboards',
  kind: 'html',
  licence: 'none stated (scale.com terms of use)',
  async read({ fetchImpl }) {
    return [
      ...parseAtlas(await getText(fetchImpl, `${BASE}swe-atlas`)),
      ...parsePro(await getText(fetchImpl, `${BASE}swe_bench_pro_public_v2`)),
    ];
  },
};
