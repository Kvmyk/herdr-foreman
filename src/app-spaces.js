// The spaces of the Herdr app, as the app keeps them in herdr-core: a
// document named "herdr-app" (doc.get). foreman only reads it; the app owns it
// and writes it, so a write here could undo what the person just did.
// The document holds no times, so a space counts as used when one of its
// terminals last reported a status or started (terminal.list has both).

const RPC = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The terminal addresses a tab's layout holds (a tree of rows, columns and blocks).
function layoutTerminals(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.content?.terminal === 'string') out.add(node.content.terminal);
  for (const child of Array.isArray(node.children) ? node.children : []) layoutTerminals(child, out);
  return out;
}

// spaces: the document's spaces; terminals: what terminal.list gives.
// Returns [{ id, folder, name, usedMs }], the most recently used first; a tie
// goes to the space made later (the app adds new spaces at the end).
export function rankSpaces(spaces, terminals = []) {
  const list = (Array.isArray(spaces) ? spaces : []).filter((s) => s && typeof s.id === 'string' && s.id);
  return list
    .map((s, index) => {
      const shown = new Set();
      for (const tab of Array.isArray(s.tabs) ? s.tabs : []) layoutTerminals(tab?.root, shown);
      let usedMs = 0;
      for (const t of terminals) {
        if (t?.labels?.['herdr.space'] !== s.id && !shown.has(t?.address)) continue;
        usedMs = Math.max(usedMs, Number(t.status_ms) || 0, Number(t.created_ms) || 0);
      }
      return { id: s.id, folder: typeof s.folder === 'string' && s.folder ? s.folder : null, name: s.name ?? '', usedMs, index };
    })
    .sort((a, b) => b.usedMs - a.usedMs || b.index - a.index)
    .map(({ index, ...s }) => s);
}

// One `hc connect` call: the handshake, the document, the terminals. []
// when herdr-core is missing, does not answer, or the app has no document yet.
// Never throws.
export async function appSpaces({ run, hc, timeoutMs = 10000 }) {
  if (!hc) return [];
  const input = `${[RPC(1, 'hello', { generation: 1 }), RPC(2, 'doc.get', { name: 'herdr-app' }), RPC(3, 'terminal.list', {})].join('\n')}\n`;
  const answered = (text) => {
    const replies = new Map();
    for (const line of String(text ?? '').split(/\r?\n/)) {
      const msg = parseJson(line);
      if (msg && msg.id !== undefined) replies.set(msg.id, msg.result);
    }
    return replies;
  };
  // hc connect stops at the end of its input, even with answers still to
  // come, so the input stays open until the last two have arrived.
  const done = (text) => {
    const ids = answered(text);
    return ids.has(2) && ids.has(3);
  };
  let res;
  try {
    res = await run(hc, ['connect'], { input, timeoutMs, inputOpenUntil: done });
  } catch {
    return [];
  }
  if (!res || res.code !== 0) return [];
  const replies = answered(res.stdout);
  const doc = replies.get(2)?.value;
  return rankSpaces(doc?.spaces, replies.get(3)?.terminals ?? []);
}
