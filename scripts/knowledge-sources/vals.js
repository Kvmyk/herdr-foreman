// Vals AI: independent benchmark runs, one page per benchmark. The data sits
// in the props attribute of the page's Astro islands (HTML-escaped JSON in
// Astro's [type, value] encoding) as benchmarkView {metadata, tasks.overall}.
// Model ids are vendor/model; a run in a named harness carries the harness as a
// suffix (anthropic/claude-opus-4-8-claude-code with harness "Claude Code").
import { getText, decodeEntities, normaliseModel, effortWord, vendorFor, harnessKind, isoDay, percent, fail } from './normalise.js';

const BASE = 'https://www.vals.ai/benchmarks/';
export const BENCHMARKS = {
  'terminal-bench-4': 'vals-terminal-bench-4',
  'vibe-code': 'vibe-code-bench',
  vals_index: 'vals-index',
};

// Astro serialises every value as [type, value]: 0 plain or object, 1 array; others keep their value.
function revive(encoded) {
  if (!Array.isArray(encoded) || encoded.length !== 2 || typeof encoded[0] !== 'number') fail('vals: unexpected props encoding');
  const [type, value] = encoded;
  if (type === 1) return value.map(revive);
  if (type === 0 && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  }
  return value;
}

export function benchmarkView(html) {
  let best = null;
  for (const m of html.matchAll(/<astro-island\b[^>]*?\sprops="([^"]*)"/g)) {
    let props;
    try {
      props = JSON.parse(decodeEntities(m[1]));
    } catch {
      continue;
    }
    if (!props?.benchmarkView) continue;
    const view = revive(props.benchmarkView);
    const overall = view?.tasks?.overall;
    if (!view?.metadata || !overall || typeof overall !== 'object') continue;
    if (!best || Object.keys(overall).length > Object.keys(best.tasks.overall).length) best = view;
  }
  return best ?? fail('vals: no benchmarkView with overall results in the page');
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function parseVals(html, page) {
  const view = benchmarkView(html);
  if (view.metadata.slug !== page) fail(`vals: page ${page} holds ${view.metadata.slug}`);
  const updated = isoDay(view.metadata.updated) ?? fail(`vals: bad updated date ${view.metadata.updated}`);
  const entries = Object.entries(view.tasks.overall);
  if (!entries.length) fail(`vals ${page}: no results`);
  for (const [id, e] of entries) if (!e || typeof e !== 'object') fail(`vals ${page}: bad entry ${id}`);
  const labelOf = (e) => (typeof e.harness === 'string' ? e.harness : null);
  // The board's own harness (most entries) stands for "the model"; a run in another
  // harness counts only when that harness is a foreman kind.
  const counts = {};
  for (const [, e] of entries) counts[labelOf(e)] = (counts[labelOf(e)] ?? 0) + 1;
  const usual = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const kept = entries.filter(([, e]) => String(labelOf(e)) === usual || harnessKind(labelOf(e)));
  return kept.map(([id, e]) => {
    const label = labelOf(e);
    const suffix = label ? `-${slug(label)}` : null;
    const bare = suffix && id.toLowerCase().endsWith(suffix) ? id.slice(0, -suffix.length) : id;
    const { model, effort } = normaliseModel(bare);
    return {
      source: 'vals', benchmark: BENCHMARKS[page], model, vendor: vendorFor(model, e.provider ?? id.split('/')[0]),
      harness: harnessKind(label), effort: effortWord(e.reasoning_effort ?? '') ?? effort,
      score: percent(e.accuracy, `vals ${page} ${id}`), unit: '%',
      date: isoDay(e.run_date) ?? updated, category: null,
    };
  });
}

export default {
  id: 'vals',
  url: BASE,
  title: 'Vals AI benchmarks',
  kind: 'html',
  licence: 'none stated (public site; robots.txt allows the benchmark pages)',
  async read({ fetchImpl }) {
    const records = [];
    for (const page of Object.keys(BENCHMARKS)) records.push(...parseVals(await getText(fetchImpl, BASE + page), page));
    return records;
  },
};
