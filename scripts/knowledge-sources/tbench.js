import { createKnowledgeFetch, getJson, postJson, normaliseModel, effortWord, vendorFor, vendorLabel, harnessKind, isoDay, percent, fail } from './normalise.js';

const API = 'https://api.harborframework.com/functions/v1';
const PACKAGE = 'terminal-bench/terminal-bench';
// The public list route backs `harbor hub leaderboard list` in the Harbor SDK.
const LIST_VERSION = '2026-09-10.preview';
const PAGE_SIZE = 100;

function recordFrom(row, version) {
  const md = row.metadata;
  const modelLabel = md?.model_display?.label;
  const agentLabel = md?.agent_display?.label;
  if (typeof modelLabel !== 'string' || typeof agentLabel !== 'string') fail('tbench: row without model or agent label');
  const { model, effort } = normaliseModel(modelLabel, { vendor: vendorLabel(md.model_org?.label) });
  return {
    source: 'tbench', benchmark: `terminal-bench-${version}`, model, vendor: vendorFor(model, md.model_org?.label),
    harness: harnessKind(agentLabel), effort: effortWord(md.reasoning_effort ?? '') ?? effort,
    score: percent(row.metrics?.accuracy, 'tbench accuracy'), unit: '%',
    date: isoDay(md.date) ?? fail(`tbench: bad date ${md.date}`), category: null,
  };
}

async function newestPublicBoard(request) {
  const names = [];
  const cursors = new Set();
  const query = new URLSearchParams({ package: PACKAGE, page_size: String(PAGE_SIZE) });
  for (;;) {
    const data = await getJson(request, `${API}/api/v1/leaderboards?${query}`, {
      headers: { 'harbor-api-version': LIST_VERSION },
    });
    if (!Array.isArray(data?.items)) fail('tbench: invalid leaderboard list');
    for (const board of data.items) {
      if (board?.package === PACKAGE && board.visibility === 'public'
        && typeof board.name === 'string' && /^\d+-\d+-\d+$/.test(board.name)) names.push(board.name);
    }
    const cursor = data.next_cursor;
    if (cursor == null) break;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) fail('tbench: invalid leaderboard list cursor');
    cursors.add(cursor);
    query.set('cursor', cursor);
  }
  return names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)
    ?? fail('tbench: no public versioned leaderboard');
}

async function readLeaderboard(fetchImpl) {
  const request = createKnowledgeFetch(fetchImpl);
  const name = await newestPublicBoard(request);
  const readPage = (page) => postJson(request, `${API}/leaderboard-read`, { package: PACKAGE, name, page, page_size: PAGE_SIZE });
  const first = await readPage(1);
  const board = first?.leaderboard;
  if (board?.name !== name || board.package !== PACKAGE || typeof board.id !== 'string') fail('tbench: unexpected leaderboard');
  if (board.rank_by?.[0]?.accessor !== 'metrics.accuracy') fail('tbench: leaderboard is not ranked by accuracy');
  const { total, total_pages: pages } = first.pagination ?? {};
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(pages) || pages < 1 || pages > total) {
    fail('tbench: invalid leaderboard pagination');
  }
  const updated = isoDay(board.updated_at) ?? fail('tbench: invalid leaderboard update date');
  const version = name.replace(/-0$/, '').replaceAll('-', '.');
  const records = [];
  for (let page = 1; page <= pages; page++) {
    const data = page === 1 ? first : await readPage(page);
    if (data?.leaderboard?.id !== board.id || data.leaderboard.updated_at !== board.updated_at
      || data.pagination?.page !== page || data.pagination.total_pages !== pages || data.pagination.total !== total
      || !Array.isArray(data.rows) || !data.rows.length) {
      fail(`tbench: inconsistent leaderboard page ${page}`);
    }
    for (const row of data.rows) records.push(recordFrom(row, version));
  }
  if (records.length !== total) fail('tbench: incomplete leaderboard');
  return Object.assign(records, { updated });
}

export default {
  id: 'tbench',
  url: 'https://www.tbench.ai/',
  title: 'Terminal-Bench leaderboard (Harbor Hub public API)',
  kind: 'data',
  licence: 'facts; public read API documented for display; repo Apache-2.0; no site terms (checked 2026-11-19)',
  attribution: {
    creator: 'Terminal-Bench (Stanford / Harbor / Laude Institute)',
    citation: 'https://github.com/harbor-framework/terminal-bench/blob/main/CITATION.cff',
  },
  read: ({ fetchImpl }) => readLeaderboard(fetchImpl),
};
