// LMArena WebDev Arena: Bradley-Terry ratings from human votes on web apps,
// read from the lmarena-ai/leaderboard-dataset on Hugging Face (CC-BY-4.0).
import { hfRows, normaliseModel, harnessKind, vendorFor, vendorLabel, isoDay, fail } from './normalise.js';

const REQUIRED = ['model_name', 'organization', 'rating', 'category', 'leaderboard_publish_date'];

export default {
  id: 'lmarena-webdev',
  url: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
  title: 'LMArena WebDev Arena',
  kind: 'data',
  licence: 'CC-BY-4.0',
  async read({ fetchImpl }) {
    const { features, rows } = await hfRows(fetchImpl, { dataset: 'lmarena-ai/leaderboard-dataset', config: 'webdev', split: 'latest' });
    for (const f of REQUIRED) if (!features.includes(f)) fail(`webdev: missing column ${f}`);
    return rows.filter((r) => r.category === 'overall').map((r) => {
      const hint = vendorLabel(r.organization);
      const { model, effort, harnessLabel } = normaliseModel(r.model_name, { vendor: hint });
      const date = isoDay(r.leaderboard_publish_date) ?? fail(`webdev: bad date ${r.leaderboard_publish_date}`);
      if (typeof r.rating !== 'number' || !Number.isFinite(r.rating) || r.rating < 100 || r.rating > 4000) fail(`webdev: bad rating ${r.rating}`);
      return {
        source: 'lmarena-webdev', benchmark: 'webdev-arena', model, vendor: vendorFor(model, r.organization), harness: harnessKind(harnessLabel),
        effort, score: Math.round(r.rating * 10) / 10, unit: 'elo', date, category: null,
      };
    });
  },
};
