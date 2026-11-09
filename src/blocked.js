// Tell what a blocked agent screen is asking, and the exact foreman command
// that answers it.

const KINDS = [
  { type: 'trust', re: /trust (the files in |the contents of |this |the )?(this )?(folder|workspace|directory|project)|do you trust|I trust this/i, label: 'asks to trust this folder' },
  { type: 'login', re: /sign in|log ?in|authenticat|api key|not logged in/i, label: 'needs you to sign in' },
  { type: 'update', re: /update available|new version|upgrade to|press .* to update/i, label: 'offers an update' },
  { type: 'permission', re: /\(y\/n\)|\[y\/n\]|do you want to|allow .*\?|approve|permission/i, label: 'asks for permission' },
];

// Kinds whose trust dialog has "yes" preselected: Enter accepts it.
const TRUST_ENTER = new Set(['claude', 'codex']);
const KEYS = { trust: ['enter'], update: ['esc'], permission: ['enter'] };

export function classifyScreen(kind, screen) {
  const text = String(screen ?? '');
  const hit = KINDS.find((k) => k.re.test(text));
  if (!hit) return null;
  return {
    type: hit.type,
    label: `${kind} ${hit.label}`,
    keys: KEYS[hit.type] ?? null,
    // Foreman may answer this itself in its own worktrees.
    safeToAnswer: hit.type === 'trust' && TRUST_ENTER.has(kind),
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
