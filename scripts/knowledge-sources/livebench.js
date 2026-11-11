// LiveBench 2.0: contamination-free long-horizon benchmark, one CSV per
// release. The list of releases lives only in the site's JS bundle, so the
// newest one is found there: index.html -> static/js/main.*.js -> ["YYYYMMDD", ...].
import { getText, parseCsv, normaliseModel, vendorFor, compactToIso, percent, fail } from './normalise.js';

const SITE = 'https://livebench.ai/';
const COLUMNS = { coding: 'livebench-coding', long_agentic: 'livebench-long-agentic' };

export async function newestRelease(fetchImpl) {
  const html = await getText(fetchImpl, SITE);
  const bundle = html.match(/src="\.?\/?(static\/js\/main\.[0-9a-f]+\.js)"/)?.[1] ?? fail('livebench: no main bundle in index.html');
  const js = await getText(fetchImpl, SITE + bundle);
  const releases = [];
  for (const m of js.matchAll(/\[\s*"\d{8}"(?:\s*,\s*"\d{8}")*\s*\]/g)) {
    for (const id of JSON.parse(m[0])) if (compactToIso(id)) releases.push(id);
  }
  if (!releases.length) fail('livebench: no release list in the bundle');
  return releases.sort().pop();
}

export default {
  id: 'livebench',
  url: SITE,
  title: 'LiveBench 2.0',
  kind: 'data',
  licence: 'none stated (site data)',
  async read({ fetchImpl }) {
    const release = await newestRelease(fetchImpl);
    const rows = parseCsv(await getText(fetchImpl, `${SITE}data/${release}/table.csv`));
    if (!rows.length) fail('livebench: empty table');
    for (const col of ['model', ...Object.keys(COLUMNS)]) if (!(col in rows[0])) fail(`livebench: missing column ${col}`);
    const date = compactToIso(release);
    const records = [];
    for (const r of rows) {
      const { model, effort } = normaliseModel(r.model);
      for (const [col, benchmark] of Object.entries(COLUMNS)) {
        const cell = r[col].trim();
        if (cell === '' || /^n\/?a$/i.test(cell)) continue;
        if (!/^\d+(\.\d+)?$/.test(cell)) fail(`livebench ${col}: not a number: ${cell}`);
        records.push({
          source: 'livebench', benchmark, model, vendor: vendorFor(model), harness: null, effort,
          score: percent(Number(cell), `livebench ${col}`), unit: '%', date, category: null,
        });
      }
    }
    return records;
  },
};
