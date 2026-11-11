// Terminal-Bench (tbench.ai, Laude Institute / Harbor): harness + model pairs
// on terminal tasks. No JSON API; the leaderboard object is embedded in the
// Next.js RSC payload of the home page as {"leaderboard": {...}, "rows": [...]}.
// Every row is checked; one odd row rejects the whole page.
import { getText, nextFlight, grabJson, normaliseModel, effortWord, vendorFor, vendorLabel, harnessKind, isoDay, percent, fail } from './normalise.js';

const URL = 'https://www.tbench.ai/';

export function parseTbench(html) {
  const text = nextFlight(html);
  const boards = [];
  for (const m of text.matchAll(/\{"leaderboard":\{/g)) {
    const board = grabJson(text, m.index);
    const version = String(board.leaderboard?.title ?? '').match(/^Terminal-Bench (\d+(?:\.\d+)*)$/)?.[1];
    if (version && Array.isArray(board.rows)) boards.push({ version, board });
  }
  if (!boards.length) fail('tbench: no Terminal-Bench leaderboard in the payload');
  const byVersion = (a, b) => a.version.localeCompare(b.version, 'en', { numeric: true });
  const { version, board } = boards.sort(byVersion).pop();
  const rankBy = board.leaderboard.rank_by?.[0]?.accessor;
  if (rankBy !== 'metrics.accuracy') fail(`tbench: ranked by ${rankBy}, expected metrics.accuracy`);
  if (!board.rows.length) fail('tbench: no rows');
  return board.rows.map((row) => {
    const md = row?.metadata ?? fail('tbench: row without metadata');
    const modelLabel = md.model_display?.label;
    const agentLabel = md.agent_display?.label;
    if (typeof modelLabel !== 'string' || typeof agentLabel !== 'string') fail('tbench: row without model or agent label');
    const { model, effort } = normaliseModel(modelLabel, { vendor: vendorLabel(md.model_org?.label) });
    return {
      source: 'tbench', benchmark: `terminal-bench-${version}`, model, vendor: vendorFor(model, md.model_org?.label),
      harness: harnessKind(agentLabel), effort: effortWord(md.reasoning_effort ?? '') ?? effort,
      score: percent(row.metrics?.accuracy, 'tbench accuracy'), unit: '%',
      date: isoDay(md.date) ?? fail(`tbench: bad date ${md.date}`), category: null,
    };
  });
}

export default {
  id: 'tbench',
  url: URL,
  title: 'Terminal-Bench leaderboard',
  kind: 'html',
  licence: 'Apache-2.0 (repository); site data, no separate terms',
  async read({ fetchImpl }) {
    return parseTbench(await getText(fetchImpl, URL));
  },
};
