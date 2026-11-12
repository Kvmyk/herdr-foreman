// One usage line per subcommand: shown by `foreman <cmd> --help` and after a
// usage error; also the "did you mean" check for a mistyped subcommand.

const USAGE = {
  agents: 'foreman agents [--json] [--quick]',
  brief: 'foreman brief [--json]',
  spawn: 'foreman spawn --task <slug> [--branch <type>/<name>] [--base <branch>] [--new-tab] [--effort low|medium|high|xhigh|max] [--full] [--auto] [--include-uncommitted] [--json] <name>=<kind>[:<model>]...',
  wait: 'foreman wait --task <slug> [--phase investigate|implement] [--only a,b] [--timeout ms] [--json]',
  status: 'foreman status --task <slug> [--json]',
  watch: 'foreman watch --task <slug> [--interval seconds]',
  merge: 'foreman merge --task <slug> [--only a,b] [--json]',
  land: 'foreman land --task <slug> [--title <summary>] [--json]',
  cleanup: 'foreman cleanup [--task <slug> [--delete-branch]] [--all] [--json]',
  'close-leader': 'foreman close-leader [--json]',
  prompt: 'foreman prompt --task <slug> [--backend app|herdr] [--json] <name> "<text>"',
  read: 'foreman read --task <slug> [--backend app|herdr] [--lines n] <name>',
  keys: 'foreman keys --task <slug> [--backend app|herdr] [--json] <name> <key>...',
  journal: 'foreman journal add <file.json> | foreman journal stats [--json]',
  knowledge: 'foreman knowledge show|refresh|stale [--json] | foreman knowledge validate <file> [--json]',
  setup: 'foreman setup [--json] [--quiet]',
  doctor: 'foreman doctor [--json]',
  config: 'foreman config [--json]',
  new: 'foreman new',
  launcher: 'foreman launcher [--ensure] [--json]',
  runs: 'foreman runs [--json]',
  show: 'foreman show --task <slug> [--json]',
  diff: 'foreman diff --task <slug> [--stat] [--json] [<worker>]',
  resume: 'foreman resume --task <slug> [--json]',
  respawn: 'foreman respawn --task <slug> [--new-tab] [--effort low|medium|high|xhigh|max] [--auto] [--full] [--json] <name>=<kind>[:<model>]',
  help: 'foreman help',
};

// Starting a leader: not a subcommand, so it is not offered by nearSubcommand.
export const START_USAGE = 'foreman [--backend app|herdr] [--leader <kind>] [--base <branch>] [--auto-answer] [--include-uncommitted] "<task>" | -f task.md';

export const usageOf = (name) => USAGE[name] ?? null;

export const commandUsage = (name) => `Usage: ${USAGE[name]}\n`;

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

// The subcommand a word was probably meant to be, or null.
export function nearSubcommand(word) {
  if (word.length < 3 || word in USAGE) return null;
  let best = null;
  for (const name of Object.keys(USAGE)) {
    const d = distance(word.toLowerCase(), name);
    if (d <= (name.length >= 5 ? 2 : 1) && (!best || d < best.d)) best = { name, d };
  }
  return best?.name ?? null;
}
