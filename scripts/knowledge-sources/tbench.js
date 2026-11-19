// Terminal-Bench publishes leaderboard submissions in its Apache-2.0 repository.
import { getJson, normaliseModel, effortWord, vendorFor, vendorLabel, harnessKind, isoDay, percent, fail } from './normalise.js';

const REPO = 'harbor-framework/terminal-bench';
const DIRECTORY = 'leaderboard/submissions';
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}`;

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

async function readSubmissions(fetchImpl) {
  const commits = await getJson(fetchImpl, `${API}/commits?path=${encodeURIComponent(DIRECTORY)}&per_page=1`);
  const latest = commits?.[0];
  if (typeof latest?.sha !== 'string' || !/^[0-9a-f]{40}$/.test(latest.sha)) fail('tbench: missing submissions commit');
  const updated = isoDay(latest.commit?.committer?.date) ?? fail('tbench: invalid submissions commit date');

  // Pin the directory listing and downloads to the same revision.
  const files = await getJson(fetchImpl, `${API}/contents/${DIRECTORY}?ref=${latest.sha}`);
  if (!Array.isArray(files) || files.length >= 1000) fail('tbench: missing or incomplete submission listing');
  const names = files.filter((file) => file?.type === 'file' && /^[^/]+\.json$/.test(file.name)).map((file) => file.name);
  if (!names.length) fail('tbench: no submission files');

  const submissions = new Map();
  const concurrency = 4;
  for (let i = 0; i < names.length; i += concurrency) {
    const batch = await Promise.all(names.slice(i, i + concurrency).map((name) =>
      getJson(fetchImpl, `${RAW}/${latest.sha}/${DIRECTORY}/${encodeURIComponent(name)}`),
    ));
    for (const row of batch) {
      // Legacy submissions lack a board ID. Model, harness and trial counts
      // can match across board versions, so use only explicit IDs.
      const board = row?.leaderboard;
      if (typeof board !== 'string' || !/^\d+-\d+-\d+$/.test(board)) continue;
      if (!submissions.has(board)) submissions.set(board, []);
      submissions.get(board).push(row);
    }
  }
  if (!submissions.size) fail('tbench: no submission has a valid leaderboard');
  const board = [...submissions.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
  const version = board.replace(/-0$/, '').replaceAll('-', '.');
  const records = submissions.get(board).map((row) => recordFrom(row, version));
  return Object.assign(records, { updated });
}

export default {
  id: 'tbench',
  url: `https://github.com/${REPO}/tree/main/${DIRECTORY}`,
  title: 'Terminal-Bench leaderboard submissions',
  kind: 'data',
  licence: 'Apache-2.0 (harbor-framework/terminal-bench)',
  read: ({ fetchImpl }) => readSubmissions(fetchImpl),
};
