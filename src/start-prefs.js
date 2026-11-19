// Answers the user already gave before the leader starts (the desktop prompt
// has toggles for them), so the leader does not ask the same questions again.
export const PREF_FLAGS = Object.freeze({
  '--auto-answer': 'autoAnswer',
  '--include-uncommitted': 'includeUncommitted',
});

// The same answers given as "no": the box was left off, so the user answers the questions themselves.
export const PREF_NO_FLAGS = Object.freeze({
  '--no-auto-answer': 'autoAnswer',
  '--no-include-uncommitted': 'includeUncommitted',
});

// Flags with a value: the leader's agent kind and the base branch, for this task only.
export const PREF_VALUE_FLAGS = Object.freeze({
  '--leader': 'leader',
  '--base': 'base',
});

// Takes the preference flags off the front of argv. error: a value flag without its value.
export function takePrefs(argv) {
  const prefs = {};
  let i = 0;
  while (i < argv.length) {
    if (argv[i] in PREF_FLAGS) {
      prefs[PREF_FLAGS[argv[i++]]] = true;
    } else if (argv[i] in PREF_NO_FLAGS) {
      prefs[PREF_NO_FLAGS[argv[i++]]] = false;
    } else if (argv[i] in PREF_VALUE_FLAGS) {
      const value = argv[i + 1];
      if (value === undefined || value === '--') return { prefs, rest: argv.slice(i), error: `${argv[i]} needs a value` };
      prefs[PREF_VALUE_FLAGS[argv[i]]] = value;
      i += 2;
    } else {
      break;
    }
  }
  return { prefs, rest: argv.slice(i) };
}

// What the user already answered, for the start of the leader's prompt. It comes before
// "Read <instructions>" and overrides the questions the instructions tell the leader to ask.
// true: chosen; false: the user switched it off on purpose; undefined: nothing said, the
// leader asks as the instructions say. Empty when nothing was said.
export function prefsText(prefs = {}) {
  const parts = [];
  if (prefs.autoAnswer === true) {
    parts.push("The user already chose that you answer the workers' permission questions on their behalf (at their responsibility). This overrides the instructions: do NOT ask the permission question, add --auto to every spawn, and still refuse git push and pull requests.");
  } else if (prefs.autoAnswer === false) {
    parts.push("The user already chose to answer the workers' permission questions themselves. This overrides the instructions: do NOT ask the permission question, do not add --auto, and relay each worker's question to the user as the instructions describe.");
  }
  if (prefs.includeUncommitted === true) {
    parts.push('The user already chose that workers get a copy of the changes not committed yet. This overrides the instructions: do NOT ask about uncommitted changes, add --include-uncommitted to the first spawn.');
  } else if (prefs.includeUncommitted === false) {
    parts.push('The user already chose that workers do not get the changes not committed yet. This overrides the instructions: do NOT ask about uncommitted changes, leave --include-uncommitted out.');
  }
  if (prefs.base) {
    parts.push(`The user already chose the base branch ${prefs.base}: add --base ${prefs.base} to the first spawn, and tell the user that land will merge into ${prefs.base}.`);
  }
  return parts.length ? `${parts.join(' ')} ` : '';
}

// ---- What the launcher was last set to, kept between tasks and restarts:
// the project, the leader and the two switches. The base branch is not kept,
// it belongs to one task.

export function loadRemembered({ file, readFile }) {
  let saved = {};
  try {
    saved = JSON.parse(readFile(file)) ?? {};
  } catch {
    // nothing remembered yet, or a file that cannot be read: start fresh
  }
  const text = (v) => (typeof v === 'string' && v ? v : null);
  return { repo: text(saved.repo), leader: text(saved.leader), auto: saved.auto === true, uncommitted: saved.uncommitted === true };
}

export function saveRemembered({ file, writeFile }, { repo = null, leader = null, auto = false, uncommitted = false }) {
  try {
    writeFile(file, `${JSON.stringify({ repo, leader, auto: Boolean(auto), uncommitted: Boolean(uncommitted) })}\n`);
    return true;
  } catch {
    return false;
  }
}
