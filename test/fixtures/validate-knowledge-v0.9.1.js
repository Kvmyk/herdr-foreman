// validateKnowledge as shipped in foreman v0.9.1 (git show v0.9.1:src/knowledge.js), copied verbatim.
// 0.9.x clients check the knowledge file fetched from main with exactly this function.
function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
const isIsoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
export function validateKnowledge(k) {
  if (!isObject(k)) return ['knowledge is not a JSON object'];
  const errors = [];
  if (!isIsoDate(k.updated)) errors.push('updated is not a YYYY-MM-DD date');
  if (!isStringList(k.categories) || !k.categories.length || k.categories.some((c) => !c)) errors.push('categories is not a list of names');
  if (!isStringList(k.rules)) errors.push('rules is not a list of strings');
  if (k.sources !== undefined && (!isObject(k.sources) || Object.values(k.sources).some((u) => typeof u !== 'string'))) errors.push('sources is not an object of URLs');
  const sources = isObject(k.sources) ? k.sources : {};
  const checkSources = (list, where) => {
    if (list === undefined) return;
    if (!isStringList(list)) errors.push(`${where}: sources is not a list of source ids`);
    else for (const id of list) if (!(id in sources)) errors.push(`${where}: source ${id} is not in sources`);
  };
  if (!isObject(k.harnesses)) {
    errors.push('harnesses is not an object');
  } else {
    for (const [name, h] of Object.entries(k.harnesses)) {
      if (!isObject(h)) {
        errors.push(`harness ${name} is not an object`);
        continue;
      }
      for (const f of ['strengths', 'weaknesses']) if (h[f] !== undefined && !isStringList(h[f])) errors.push(`harness ${name}: ${f} is not a list of strings`);
      checkSources(h.sources, `harness ${name}`);
    }
  }
  if (!Array.isArray(k.families)) {
    errors.push('families is not a list');
    return errors;
  }
  const seen = new Set();
  k.families.forEach((f, i) => {
    if (!isObject(f)) {
      errors.push(`family #${i + 1} is not an object`);
      return;
    }
    const where = `family ${typeof f.id === 'string' && f.id ? f.id : `#${i + 1}`}`;
    if (typeof f.id !== 'string' || !f.id) errors.push(`${where}: id is missing`);
    else if (seen.has(f.id)) errors.push(`${where}: id is used twice`);
    else seen.add(f.id);
    if (typeof f.match !== 'string' || !f.match) {
      errors.push(`${where}: match is missing`);
    } else {
      try {
        new RegExp(f.match, 'i');
      } catch (err) {
        errors.push(`${where}: match is not a valid regular expression (${err.message})`);
      }
    }
    if (!isIsoDate(f.updated)) errors.push(`${where}: updated is not a YYYY-MM-DD date`);
    if (f.tendencies !== undefined && !isStringList(f.tendencies)) errors.push(`${where}: tendencies is not a list of strings`);
    // auto: true marks a family a script added with no data about it yet.
    if (f.auto !== undefined && typeof f.auto !== 'boolean') errors.push(`${where}: auto is not true or false`);
    checkSources(f.sources, where);
  });
  return errors;
}
