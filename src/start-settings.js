// The settings of one task that the prompts let the user change before it
// starts: the leader's agent, the base branch, and the two usual answers.
// Used by the terminal prompt (plugin/ask.js); the Herdr app prompt has the
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
