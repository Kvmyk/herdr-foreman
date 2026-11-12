// The settings of one task that the prompts let the user change before it
// starts: the leader's agent, the base branch, and the two usual answers.
// Used by the terminal prompt (src/ask.js); the Herdr app prompt has the
// same four as pills and switches and passes them as the same start flags.

// A command line of its own, before the task text. Anything else that starts
// with a slash (a path, say) is part of the task.
export const SETTING_COMMAND = /^\/(leader|branch|auto|uncommitted)(?:\s+(\S.*?))?\s*$/i;

export const isSettingCommand = (line) => SETTING_COMMAND.test(line.trim());

// leader: agent kind; base: branch name or null for the current branch.
export const initialSettings = (config) => ({ leader: config.leader, base: null, auto: false, uncommitted: false });

// The start flags that differ from what foreman would do anyway.
export function settingsArgs(settings, { config, branch }) {
  return [
    ...(settings.leader && settings.leader !== config.leader ? ['--leader', settings.leader] : []),
    ...(settings.base && settings.base !== branch ? ['--base', settings.base] : []),
    ...(settings.auto ? ['--auto-answer'] : []),
    ...(settings.uncommitted ? ['--include-uncommitted'] : []),
  ];
}

const list = (items) => items.join(', ');

// Applies one command. Returns { settings, error } where error is a plain
// message and settings is unchanged when it is set. leaders / branches are
// arrays, or null when they could not be listed (then any value is passed on
// and foreman checks it when the task starts).
export function applySetting(line, settings, { leaders = null, branches = null, branch = null } = {}) {
  const m = SETTING_COMMAND.exec(line.trim());
  if (!m) return { settings, error: null, handled: false };
  const name = m[1].toLowerCase();
  const arg = m[2] ?? '';
  if (name === 'auto' || name === 'uncommitted') {
    if (arg) return { settings, error: `/${name} takes no value; it switches on and off`, handled: true };
    return { settings: { ...settings, [name]: !settings[name] }, error: null, handled: true };
  }
  if (!arg) {
    const choices = name === 'leader' ? leaders : branches;
    return { settings, error: `/${name} needs a name${choices?.length ? `: ${list(choices)}` : ''}`, handled: true };
  }
  if (name === 'leader') {
    if (leaders && !leaders.includes(arg)) {
      return { settings, error: `${arg} cannot lead here. Ready agents: ${leaders.length ? list(leaders) : 'none found'}`, handled: true };
    }
    return { settings: { ...settings, leader: arg }, error: null, handled: true };
  }
  if (branches && !branches.includes(arg)) {
    return { settings, error: `there is no local branch ${arg}. Branches: ${branches.length ? list(branches) : 'none found'}`, handled: true };
  }
  return { settings: { ...settings, base: arg === branch ? null : arg }, error: null, handled: true };
}

// Agent kinds that can lead: the ready ones, and the configured leader even when its probe failed.
export function leaderKinds(agents, configured) {
  const ready = agents.filter((a) => a.status === 'ready').map((a) => a.kind);
  return ready.includes(configured) ? ready : [configured, ...ready];
}

// ---- The same settings as a numbered menu, for a narrow screen and a touch
// keyboard (the launcher): a line that is only a number changes a setting.

export const MENU = Object.freeze(['project', 'leader', 'auto', 'uncommitted', 'branch']);
const MENU_LABELS = Object.freeze({ project: 'project', leader: 'leader', auto: 'auto-answer', uncommitted: 'uncommitted', branch: 'branch' });

const cut = (text, width) => (text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`);

// Which setting a line names ("3" -> "auto"), or null when it is not just a menu number.
export function menuKey(line) {
  const m = /^\s*([1-9])\s*$/.exec(line);
  return m ? MENU[Number(m[1]) - 1] ?? null : null;
}

// One line per setting: "1 project      shop". project and branch are names, or null.
export function menuLines(settings, { project = null, branch = null, columns = 40, ui = null } = {}) {
  const base = settings.base ?? branch;
  const values = {
    project: project ?? 'not chosen yet',
    leader: settings.leader,
    auto: settings.auto ? 'on' : 'off',
    uncommitted: settings.uncommitted ? 'on' : 'off',
    branch: base ?? 'current',
  };
  const pad = Math.max(...Object.values(MENU_LABELS).map((l) => l.length)) + 2;
  return MENU.map((key, i) => {
    const value = cut(String(values[key]), Math.max(4, columns - 4 - pad));
    const on = (key === 'auto' || key === 'uncommitted') && values[key] === 'on';
    return `${i + 1} ${ui ? ui.dim(MENU_LABELS[key].padEnd(pad)) : MENU_LABELS[key].padEnd(pad)}${ui ? (on ? ui.green(value) : ui.bold(value)) : value}`;
  });
}

// The choices of one setting, numbered from 1; the current one is marked.
// More than `max` choices would not fit a phone screen: the rest is counted.
export function choiceLines(items, { current = null, columns = 40, max = 9, describe = null } = {}) {
  const shown = items.slice(0, max);
  const out = shown.map((item, i) => {
    const extra = describe?.(item);
    return cut(`${i + 1} ${item}${item === current ? ' (now)' : ''}${extra ? `  ${extra}` : ''}`, Math.max(8, columns - 2));
  });
  if (items.length > shown.length) out.push(cut(`${items.length - shown.length} more not shown`, Math.max(8, columns - 2)));
  return out;
}

// The item a line picks by its number, or null.
export function pickChoice(line, items, max = 9) {
  const m = /^\s*(\d{1,2})\s*$/.exec(line);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= Math.min(items.length, max) ? items[n - 1] : null;
}
