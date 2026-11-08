// What the leader reads before planning. It sits in the leader's context for
// the rest of the task and is re-sent on every turn, so it carries only what
// planning needs: no source URLs, no data about agents that cannot work.
import { familyFor, lookupModel } from './knowledge.js';

const ACCESS_ORDER = { subscription: 0, free: 1, local: 2, api: 3, unknown: 4 };

// Speech, image, live-audio and research-only models are no use for coding parts.
const NON_CODING = /(^|[-/])(tts|image|embed|embedding|live|audio|transcribe|realtime|computer-use|deep-research|moderation|whisper|imagen|veo)([-./]|$)/i;

// Default model first, then subscription, free, local, api; within that,
// models foreman knows something about before unknown ones.
export function summarizeModels(agent, limit = 25, { knowledge = null } = {}) {
  const total = agent.models.length;
  const known = (m) => (knowledge && familyFor(knowledge, m.id) ? 0 : 1);
  const sorted = agent.models
    .filter((m) => m.id === agent.defaultModel || !NON_CODING.test(m.id))
    .sort((a, b) => {
      if (a.id === agent.defaultModel) return -1;
      if (b.id === agent.defaultModel) return 1;
      return (ACCESS_ORDER[a.access] ?? 9) - (ACCESS_ORDER[b.access] ?? 9) || known(a) - known(b);
    });
  const models = sorted.slice(0, limit);
  return { models, modelsTotal: total, modelsOmitted: total - models.length };
}

const isEmpty = (v) => v === null || v === undefined || v === ''
  || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
const nonEmpty = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => !isEmpty(v)));

export function buildBrief({ agents, knowledge, modelsDev, stats, config, warnings = [], repoDirty = null, limit = 25 }) {
  const families = new Set();
  const modelFacts = {};
  const ready = [];
  const unavailable = [];

  for (const a of agents) {
    if (a.status !== 'ready') {
      unavailable.push({ kind: a.kind, status: a.status, reason: a.reason });
      continue;
    }
    const s = summarizeModels(a, limit, { knowledge });
    const models = s.models.map((m) => {
      const fam = familyFor(knowledge, m.id);
      if (fam) families.add(fam.id);
      const f = lookupModel(modelsDev, m.id);
      if (f) modelFacts[m.id] = nonEmpty({ context: f.context, costIn: f.costIn, costOut: f.costOut });
      return nonEmpty({ id: m.id, access: m.access, family: fam?.id ?? null });
    });
    ready.push(nonEmpty({
      kind: a.kind,
      defaultModel: a.defaultModel,
      note: a.reason,
      models,
      modelsOmitted: s.modelsOmitted || null,
    }));
  }

  const kinds = new Set(ready.map((a) => a.kind));
  const harnesses = Object.fromEntries(Object.entries(knowledge.harnesses ?? {})
    .filter(([k]) => kinds.has(k))
    .map(([k, h]) => [k, nonEmpty({ strengths: h.strengths, weaknesses: h.weaknesses, permissions: h.permissions, notes: h.notes })]));

  return nonEmpty({
    agents: ready,
    unavailable,
    harnesses,
    families: (knowledge.families ?? [])
      .filter((f) => families.has(f.id))
      .map((f) => nonEmpty({ id: f.id, vendor: f.vendor, tendencies: f.tendencies, stale: f.stale || null })),
    rules: knowledge.rules,
    categories: knowledge.categories,
    modelFacts,
    stats,
    maxWorkers: config.maxWorkers,
    // Only when true: the leader asks the user about unsaved changes before spawning.
    repoDirty: repoDirty === true ? true : null,
    knowledgeUpdated: knowledge.updated,
    warnings,
  });
}
