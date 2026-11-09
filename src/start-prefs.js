// Answers the user already gave before the leader starts (the desktop prompt
// has toggles for them), so the leader does not ask the same questions again.
export const PREF_FLAGS = Object.freeze({
  '--auto-answer': 'autoAnswer',
  '--include-uncommitted': 'includeUncommitted',
});

// Takes the preference flags off the front of argv.
export function takePrefs(argv) {
  const prefs = {};
  let i = 0;
  while (i < argv.length && argv[i] in PREF_FLAGS) prefs[PREF_FLAGS[argv[i++]]] = true;
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
  return parts.length ? ` ${parts.join(' ')}` : '';
}
