// Tell what a blocked agent screen is asking, and the exact foreman command
// that answers it.

const KINDS = [
  { type: 'trust', re: /trust (the files in |the contents of |this |the )?(this )?(folder|workspace|directory|project)|do you trust|I trust this/i, label: 'asks to trust this folder' },
  { type: 'login', re: /sign in|log ?in|authenticat|api key|not logged in/i, label: 'needs you to sign in' },
  { type: 'update', re: /update available|new version|upgrade to|press .* to update/i, label: 'offers an update' },
  { type: 'permission', re: /\(y\/n\)|\[y\/n\]|do you want to|allow .*\?|approve|permission/i, label: 'asks for permission' },
];

// Which option of a folder-trust dialog is highlighted differs per agent (claude
// preselects No, agy and codex Yes), so the answer is read off the screen.
const OPTION = /^\s*([❯>›])?\s*(?:(\d+)[.)]\s*)?(yes|no)\b/i;
const KEYS = { update: ['esc'], permission: ['enter'] };

// The keys that choose "yes" in a trust dialog; null when the screen does not
// show which option is highlighted. Never presses enter on a highlighted "no".
export function trustKeys(screen) {
  const options = String(screen ?? '').split(/\r?\n/).map((l) => OPTION.exec(l)).filter(Boolean)
    .map((m) => ({ marked: Boolean(m[1]), number: m[2] ?? null, yes: m[3].toLowerCase() === 'yes' }));
  const yes = options.findIndex((o) => o.yes);
  const at = options.findIndex((o) => o.marked);
  if (yes < 0 || at < 0) return null;
  if (options[yes].number) return [options[yes].number];
  if (at === yes) return ['enter'];
  return [...Array(Math.abs(yes - at)).fill(yes > at ? 'down' : 'up'), 'enter'];
}

export function classifyScreen(kind, screen) {
  const text = String(screen ?? '');
  // A narrow pane wraps a sentence over several lines: match on the joined
  // text, but read the options line by line (trustKeys) from the original.
  const flat = text.replace(/\s+/g, ' ');
  const hit = KINDS.find((k) => k.re.test(flat));
  if (!hit) return null;
  const keys = hit.type === 'trust' ? trustKeys(text) : KEYS[hit.type] ?? null;
  return {
    type: hit.type,
    label: `${kind} ${hit.label}`,
    keys,
    // Foreman may answer a trust dialog itself in its own worktrees.
    safeToAnswer: hit.type === 'trust' && Boolean(keys),
  };
}

export function keysCommand({ foremanCmd = 'foreman', task, name, keys }) {
  return `${foremanCmd} keys --task ${task} ${name} ${keys.join(' ')}`;
}

// One sentence for a person or a leader: what it asks and what to run.
export function describeBlocked({ kind, screen, task, name, foremanCmd }) {
  const c = classifyScreen(kind, screen);
  if (!c) return null;
  if (c.type === 'login') return `${c.label}; sign in with ${kind} in a terminal, then run foreman spawn again`;
  const how = c.keys ? `; answer it with: ${keysCommand({ foremanCmd, task, name, keys: c.keys })}` : '';
  return `${c.label}${how}`;
}
