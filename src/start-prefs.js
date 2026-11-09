// Answers the user already gave before the leader starts (the desktop prompt
// has toggles for them), so the leader does not ask the same questions again.
export const PREF_FLAGS = Object.freeze({
  '--auto-answer': 'autoAnswer',
  '--include-uncommitted': 'includeUncommitted',
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

// One sentence per answer, for the leader's prompt.
export function prefsText(prefs = {}) {
  const parts = [];
  if (prefs.autoAnswer) {
    parts.push("The user already chose that you answer the workers' permission questions on their behalf (at their responsibility): do not ask again, add --auto to every spawn, and still refuse git push and pull requests.");
  }
  if (prefs.includeUncommitted) {
    parts.push('The user already chose that workers get a copy of the changes not committed yet: do not ask again, add --include-uncommitted to the first spawn.');
  }
  if (prefs.base) {
    parts.push(`The user already chose the base branch ${prefs.base}: add --base ${prefs.base} to the first spawn, and tell the user that land will merge into ${prefs.base}.`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}
