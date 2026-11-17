// Thin client over the herdr CLI. Every call parses herdr's JSON reply;
// failures become HerdrError with herdr's own error code.
import { screenTail } from './wait.js';
import { classifyScreen } from './blocked.js';
import { submitStrategy } from './inventory/kinds.js';

export class HerdrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HerdrError';
    this.code = code;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorOf(res) {
  if (res.timedOut) return new HerdrError('timeout', 'herdr did not answer in time');
  const body = parseJson(res.stdout) ?? parseJson(res.stderr);
  if (body?.error?.code) return new HerdrError(body.error.code, body.error.message ?? '');
  const text = (res.stderr || res.stdout || `exit code ${res.code}`).trim();
  return new HerdrError('herdr_failed', text);
}

export const KEY_PAUSE_MS = 150;
// How long herdr waits for an agent to report working after a prompt.
export const PROMPT_WAIT_MS = 4000;
export const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Keys go one at a time: sent together, enter can land before the selection moved.
export async function sendKeys(send, keys, sleep) {
  for (const [i, key] of keys.entries()) {
    if (i) await sleep(KEY_PAUSE_MS);
    await send(key);
  }
}

// How agents show a long or multi-line paste in their input instead of the
// text: codex "[Pasted Content 1520 chars]", opencode "[Pasted ~12 lines]",
// pi "[paste #1 +12 lines]", agy "[Pasted Text: 12 lines]".
export const PASTE_PLACEHOLDER = /\[(?:pasted|paste)\b[^\]\n]*\]/i;
// What an agent shows while it works on a turn ("esc to interrupt" and the like).
const BUSY = /esc to (?:interrupt|cancel)|esc interrupt|ctrl\+c to (?:interrupt|stop)/i;
const SNIPPET = 30;
// Dialogs and the busy line sit at the bottom: older output above them is not read.
const BOTTOM = 6;

// Text without whitespace and box borders: a prompt wrapped over several rows
// of an input box still reads as one string.
const squash = (s) => String(s).replace(/[\s\u2500-\u259f]+/g, '');
// hc wraps a message in <hc from="..."> ... </hc>.
const unwrap = (s) => String(s).replace(/<\/?hc\b[^>]*>/g, '');

// A prompt can stay in the input unsent. True when its first or last words are
// still on the last lines of the screen (wrapped, above footer lines), or the
// input shows a paste placeholder.
export function promptStuck(screen, text, lines = 15) {
  const t = squash(unwrap(text));
  if (!t) return false;
  const tail = screenTail(screen, lines, 4000);
  if (PASTE_PLACEHOLDER.test(tail)) return true;
  const flat = squash(unwrap(tail));
  return flat.includes(t.slice(0, SNIPPET)) || flat.includes(t.slice(-SNIPPET));
}

// The last lines of the screen that are not the prompt itself, so words in
// the prompt are not taken for a dialog or for the agent working.
export function otherLines(screen, text, lines = 15) {
  const t = squash(unwrap(text));
  return screenTail(screen, lines, 4000).split('\n').filter((line) => {
    const s = squash(unwrap(line)).replace(/^[>›❯]+/, '');
    return !(s && t.includes(s)) && !PASTE_PLACEHOLDER.test(line);
  }).join('\n');
}

// After a prompt: press enter while its text still sits in the input, up to
// as many times as the kind's strategy has delays (see submitStrategy). Mode
// "enter" presses once after the first delay even when the text is not seen.
// Stops when the agent reports or shows work, and never presses into a dialog.
// True when the prompt went in (or the screen cannot tell), false when it
// still sits in the input or a dialog stopped it.
export async function submitIfStuck({ read, press, sleep, text, kind = null, strategy = submitStrategy(kind), status = async () => null }) {
  const { mode, delays, lines, verify } = strategy;
  const look = async () => {
    if (['working', 'blocked'].includes(await status().catch(() => null))) return 'busy';
    let screen;
    try {
      screen = await read();
    } catch {
      return 'unknown'; // the screen is only a safety check
    }
    const rest = otherLines(screen, text, lines).split('\n').slice(-BOTTOM).join('\n');
    if (BUSY.test(rest)) return 'busy';
    if (classifyScreen(kind ?? 'agent', rest)) return 'dialog';
    return promptStuck(screen, text, lines) ? 'stuck' : 'sent';
  };
  for (const [i, ms] of delays.entries()) {
    await sleep(ms);
    const seen = await look();
    if (seen === 'busy' || seen === 'unknown') return true;
    if (seen === 'dialog') return false;
    if (seen === 'sent' && !(mode === 'enter' && i === 0)) return true;
    try {
      await press();
    } catch {
      return true;
    }
  }
  if (!verify) return true;
  await sleep(delays.at(-1));
  const seen = await look();
  return seen !== 'stuck' && seen !== 'dialog';
}

export function formatRatio(ratio) {
  return String(Number(ratio.toFixed(4)));
}

export function createHerdr({ run, bin = 'herdr', sleep = realSleep }) {
  async function call(args, timeoutMs = 30000) {
    const res = await run(bin, args, { timeoutMs });
    if (res.code !== 0) throw errorOf(res);
    const body = parseJson(res.stdout) ?? {};
    return body.result ?? body;
  }

  const focusFlag = (focus) => (focus ? '--focus' : '--no-focus');

  return {
    kind: 'herdr',

    async serverRunning() {
      const res = await run(bin, ['status', 'server'], { timeoutMs: 10000 });
      return /status:\s*running/.test(res.stdout);
    },

    async workspaceCreate({ cwd, label, focus = false }) {
      const r = await call(['workspace', 'create', '--cwd', cwd, ...(label ? ['--label', label] : []), focusFlag(focus)]);
      return { workspaceId: r.workspace.workspace_id, tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
    },

    async tabCreate({ workspaceId, cwd, label, focus = false }) {
      const r = await call([
        'tab', 'create',
        ...(workspaceId ? ['--workspace', workspaceId] : []),
        '--cwd', cwd,
        ...(label ? ['--label', label] : []),
        focusFlag(focus),
      ]);
      return { tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
    },

    async paneSplit({ pane, direction, ratio, cwd }) {
      const r = await call([
        'pane', 'split', '--pane', pane, '--direction', direction,
        '--ratio', formatRatio(ratio), '--cwd', cwd, '--no-focus',
      ]);
      return r.pane.pane_id;
    },

    async paneClose(paneId) {
      await call(['pane', 'close', paneId]);
    },

    async paneList() {
      const r = await call(['pane', 'list']);
      return r.panes ?? [];
    },

    async agentList() {
      const r = await call(['agent', 'list']);
      return r.agents ?? [];
    },

    // Never throws on a herdr error: a worker that is not ready (for example
    // stuck on a folder-trust dialog) must not stop the others.
    async agentStart({ name, kind, pane, timeoutMs, args = [] }) {
      const argv = [
        'agent', 'start', name, '--kind', kind, '--pane', pane,
        ...(timeoutMs ? ['--timeout', String(timeoutMs)] : []),
        ...(args.length ? ['--', ...args] : []),
      ];
      const res = await run(bin, argv, { timeoutMs: (timeoutMs ?? 30000) + 15000 });
      if (res.code === 0) return { ok: true };
      const err = errorOf(res);
      return { ok: false, code: err.code, message: err.message };
    },

    // Plain text of what the agent's pane shows (not JSON); with lines, its
    // recent output instead.
    async agentRead(target, { source = 'visible', lines = null } = {}) {
      const args = lines ? ['--source', 'recent', '--lines', String(lines)] : ['--source', source];
      const res = await run(bin, ['agent', 'read', target, ...args], { timeoutMs: 15000 });
      if (res.code !== 0) throw errorOf(res);
      return res.stdout;
    },

    // kind picks how the prompt is made sure to be submitted (submitStrategy).
    // Where the strategy allows, herdr waits until the agent reports working;
    // when it does not (agent_prompt_stalled, or no answer in time) the screen
    // decides whether enter is pressed. { submitted: false } when the prompt
    // still sits in the input, or a dialog came up.
    async agentPrompt(target, text, { kind = null } = {}) {
      const strategy = submitStrategy(kind);
      if (strategy.wait) {
        try {
          await call(['agent', 'prompt', target, text, '--wait', '--until', 'working', '--until', 'blocked', '--timeout', String(PROMPT_WAIT_MS)], PROMPT_WAIT_MS + 15000);
          return { submitted: true };
        } catch (err) {
          if (!['agent_prompt_stalled', 'timeout'].includes(err.code)) throw err;
        }
      } else {
        await call(['agent', 'prompt', target, text]);
      }
      const submitted = await submitIfStuck({
        read: () => this.agentRead(target), press: () => call(['agent', 'send-keys', target, 'enter']), sleep, text, kind, strategy,
      });
      return { submitted };
    },

    async agentKeys(target, keys) {
      await sendKeys((key) => call(['agent', 'send-keys', target, key]), keys, sleep);
    },
  };
}
