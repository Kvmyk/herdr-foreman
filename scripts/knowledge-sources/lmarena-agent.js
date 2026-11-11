// LMArena Agent Arena: models ranked on real agent sessions, read from the
// lmarena-ai/leaderboard-dataset on Hugging Face (CC-BY-4.0). Its IPS score
// (net improvement, tau-hat) is neither a percentage nor an Elo rating, so the
// record carries the rank only: score and unit stay null, and the benchmark
// name says so (agent-arena-rank).
import { hfRows, normaliseModel, harnessKind, vendorFor, vendorLabel, isoDay, fail } from './normalise.js';

const REQUIRED = ['model_name', 'organization', 'score', 'category', 'leaderboard_publish_date'];

export default {
  id: 'lmarena-agent',
  url: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
  title: 'LMArena Agent Arena',
  kind: 'data',
  licence: 'CC-BY-4.0',
  async read({ fetchImpl }) {
    const { features, rows } = await hfRows(fetchImpl, { dataset: 'lmarena-ai/leaderboard-dataset', config: 'agent', split: 'latest' });
    for (const f of REQUIRED) if (!features.includes(f)) fail(`agent: missing column ${f}`);
    return rows.filter((r) => r.category === 'overall').map((r) => {
      const { model, effort, harnessLabel } = normaliseModel(r.model_name, { vendor: vendorLabel(r.organization) });
      const date = isoDay(r.leaderboard_publish_date) ?? fail(`agent: bad date ${r.leaderboard_publish_date}`);
      if (typeof r.score !== 'number' || !Number.isFinite(r.score)) fail(`agent: bad score ${r.score}`);
      return {
        source: 'lmarena-agent', benchmark: 'agent-arena-rank', model, vendor: vendorFor(model, r.organization), harness: harnessKind(harnessLabel),
        effort, score: null, unit: null, order: r.score, date, category: null,
      };
    });
  },
};
