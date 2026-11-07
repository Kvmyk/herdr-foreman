// The user's own record of how each harness + model did, per task category.
// After a few weeks this outweighs any public ranking.

const INT_FIELDS = ['proposed', 'approved', 'rejected', 'fixRounds'];
const BOOL_OR_NULL = ['testsPassed', 'reviewPassed'];

function invalid(field, entry) {
  const err = new Error(`invalid journal entry (${field}): ${JSON.stringify(entry)}`);
  err.code = 'INVALID_ENTRY';
  return err;
}

function validate(e, categories) {
  if (!e || typeof e !== 'object') throw invalid('entry', e);
  if (typeof e.task !== 'string' || !e.task) throw invalid('task', e);
  if (!categories.includes(e.category)) throw invalid('category', e);
  if (typeof e.kind !== 'string' || !e.kind) throw invalid('kind', e);
  if (!(e.model === null || typeof e.model === 'string')) throw invalid('model', e);
  for (const f of INT_FIELDS) if (!Number.isInteger(e[f]) || e[f] < 0) throw invalid(f, e);
  for (const f of BOOL_OR_NULL) if (!(e[f] === null || typeof e[f] === 'boolean')) throw invalid(f, e);
  if (typeof e.stuck !== 'boolean') throw invalid('stuck', e);
}

export function appendEntries(entries, { path, appendFile, categories, now = Date.now() }) {
  const list = Array.isArray(entries) ? entries : [entries];
  list.forEach((e) => validate(e, categories));
  const at = new Date(now).toISOString();
  appendFile(path, list.map((e) => `${JSON.stringify({ at, ...e })}\n`).join(''));
  return list.length;
}

export function readEntries({ path, readFile }) {
  let text;
  try {
    text = readFile(path);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const ratio = (num, den) => (den ? num / den : null);

export function computeStats(entries, { minSamples = 5 } = {}) {
  const groups = new Map();
  for (const e of entries) {
    const key = JSON.stringify([e.category, e.kind, e.model]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const stats = {};
  for (const [key, list] of groups) {
    const [category, kind, model] = JSON.parse(key);
    const withProposals = list.filter((e) => e.proposed > 0);
    const reviewed = list.filter((e) => e.reviewPassed !== null && e.reviewPassed !== undefined);
    const row = {
      kind,
      model,
      n: list.length,
      approvalRate: ratio(withProposals.reduce((s, e) => s + e.approved, 0), withProposals.reduce((s, e) => s + e.proposed, 0)),
      firstPassRate: ratio(reviewed.filter((e) => e.reviewPassed === true && e.fixRounds === 0).length, reviewed.length),
      stuckRate: list.filter((e) => e.stuck).length / list.length,
      trusted: list.length >= minSamples,
    };
    (stats[category] ??= []).push(row);
  }

  const score = (r) => (r.approvalRate ?? 0) + (r.firstPassRate ?? 0) - r.stuckRate;
  for (const rows of Object.values(stats)) rows.sort((a, b) => score(b) - score(a));
  return stats;
}
