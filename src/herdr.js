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
// How long herdr waits for an agent to report working after a prompt: above
// herdr's own 5000 ms, so a prompt that never started comes back as
// agent_prompt_stalled instead of a plain timeout.
export const PROMPT_WAIT_MS = 6000;
// Two reads this far apart must show the same input before enter is pressed.
export const STABLE_MS = 300;
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
// What an agent shows while it works on a turn ("esc to interrupt" and the
// like); a narrow pane cuts it short ("esc to inte…").
const BUSY = /esc to (?:int|canc)|esc interrupt|ctrl\+c to (?:interrupt|stop)/i;
// An input with nothing in it: the prompt sign alone (in a box or not), or
// the placeholder text an agent shows there. A positive sign that the prompt left.
const EMPTY_INPUT = [
  /^[\s│┃|]*[>›❯][\s│┃|]*$/,
  /^\s*›\s*(?:Ask Codex to do anything|Explain this codebase|Summarize recent commits|Implement \{feature\}|(?:Find and fix a bug|Write tests|Improve documentation) (?:in|for) @filename|Run \/review on my current changes|Use \/skills to list available skills)\b/,
  /^[\s│┃|]*>?\s*Ask anything\b/,
];
const SNIPPET = 30;
// Dialogs and the busy line sit at the bottom: older output above them is not read.
const BOTTOM = 6;

// Text without whitespace and box borders: a prompt wrapped over several rows
// of an input box still reads as one string.
const squash = (s) => String(s).replace(/[\s\u2500-\u259f]+/g, '');
// hc wraps a message in <hc from="..."> ... </hc>.
const unwrap = (s) => String(s).replace(/<\/?hc\b[^>]*>/g, '');

// Pieces of the prompt, SNIPPET long, overlapping, so any part of it that is
// on screen is found (the start may have scrolled away, the end may not be
// drawn yet). A short prompt is one piece.
function pieces(t) {
  if (t.length <= SNIPPET) return [t];
  const out = [];
  for (let i = 0; i + SNIPPET < t.length; i += SNIPPET / 2) out.push(t.slice(i, i + SNIPPET));
  out.push(t.slice(-SNIPPET));
  return out;
}

// A prompt can stay in the input unsent. True when any part of it is still
// on the last lines of the screen (wrapped, above footer lines), or the input
// shows a paste placeholder.
export function promptStuck(screen, text, lines = 15) {
  const t = squash(unwrap(text));
  if (!t) return false;
  const tail = screenTail(screen, lines, 4000);
  if (PASTE_PLACEHOLDER.test(tail)) return true;
  const flat = squash(unwrap(tail));
  return pieces(t).some((p) => flat.includes(p));
}

// True when the prompt's end is on the last lines (or a paste placeholder):
// all of it has been taken into the input.
function promptEndShown(screen, text, lines) {
  const tail = screenTail(screen, lines, 4000);
  if (PASTE_PLACEHOLDER.test(tail)) return true;
  return squash(unwrap(tail)).includes(squash(unwrap(text)).slice(-SNIPPET));
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

// A status as the backends give it: a word, or { state, turn }.
const stateOf = (s) => (typeof s === 'string' ? s : s?.state ?? null);

// A screen that tells, from anywhere on it, that the agent cannot take a
// prompt now: opencode's modal after it updated itself (in the middle of the
// screen, above an input that looks empty), or a notice to close first.
const MODAL_TYPES = ['restart', 'notice'];
export function modalShown(screen, kind = null, text = '') {
  const c = classifyScreen(kind ?? 'agent', otherLines(screen, text, 40));
  return MODAL_TYPES.includes(c?.type) ? c : null;
}

// True when one of the last lines is an empty input (the prompt sign alone,
// or the placeholder an agent shows there).
export function inputEmpty(screen, lines = BOTTOM) {
  return screenTail(screen, lines, 4000).split('\n').some((line) => EMPTY_INPUT.some((re) => re.test(line)));
}

// After a prompt: press enter while its text still sits in the input, up to
// as many times as the kind's strategy has delays (see submitStrategy in
// inventory/kinds.js; mode no longer presses blindly: an enter pressed while
// the agent still takes in the paste becomes a newline). Enter is pressed only
// when the text is seen, and on Windows only once two reads STABLE_MS apart
// show the same input with the prompt's end in it (no bracketed paste there:
// the agent gets the text as keys and is still reading them).
// Submitted only on evidence: the agent reports or shows work, its turn moved
// past turn, or its input is empty after the text was seen in it. An input
// that stays empty without the text ever showing means the paste was lost
// (opencode drops it while a modal is open). Never presses into a dialog.
// { submitted: true }: it went in; false: it still sits in the input, it was
// lost (reason 'lost') or a dialog stopped it (reason 'dialog', label);
// null: the screen cannot tell (or a press failed).
export async function checkSubmit({
  read, press, sleep, text, kind = null, strategy = submitStrategy(kind),
  status = async () => null, turn = null, platform = process.platform,
}) {
  const { delays, lines, verify } = strategy;
  let textSeen = false;
  const look = async () => {
    const s = await Promise.resolve().then(status).catch(() => null);
    if (['working', 'blocked'].includes(stateOf(s))) return { seen: 'busy' };
    if (turn !== null && typeof s?.turn === 'number' && s.turn > turn) return { seen: 'busy' };
    let screen;
    try {
      screen = await read();
    } catch {
      return { seen: 'unknown' };
    }
    const rest = otherLines(screen, text, lines).split('\n').slice(-BOTTOM);
    if (BUSY.test(rest.join('\n'))) return { seen: 'busy' };
    const dialog = modalShown(screen, kind, text) ?? classifyScreen(kind ?? 'agent', rest.join('\n'));
    if (dialog) return { seen: 'dialog', label: dialog.label };
    if (rest.some((line) => EMPTY_INPUT.some((re) => re.test(line)))) return { seen: textSeen ? 'sent' : 'empty' };
    if (promptStuck(screen, text, lines)) {
      textSeen = true;
      return { seen: 'stuck', screen };
    }
    return { seen: 'unknown' };
  };
  const done = ({ seen, label }) => {
    if (seen === 'busy' || seen === 'sent') return { submitted: true };
    if (seen === 'dialog') return { submitted: false, reason: 'dialog', label };
    return null;
  };
  // The input has settled: the same screen twice, with the prompt's end in it.
  const settled = async (screen) => {
    if (platform !== 'win32') return true;
    await sleep(STABLE_MS);
    let again;
    try {
      again = await read();
    } catch {
      return false;
    }
    return screenTail(again, lines, 4000) === screenTail(screen, lines, 4000) && promptEndShown(again, text, lines);
  };
  let last = 'unknown';
  for (const ms of delays) {
    await sleep(ms);
    const seen = await look();
    const end = done(seen);
    if (end) return end;
    if (seen.seen !== 'stuck' || !(await settled(seen.screen))) {
      last = seen.seen;
      continue;
    }
    try {
      await press();
    } catch {
      return { submitted: null };
    }
    last = 'pressed';
  }
  if (!verify) {
    if (last === 'pressed') return { submitted: true };
    if (last === 'stuck') return { submitted: false };
    return last === 'empty' ? { submitted: false, reason: 'lost' } : { submitted: null };
  }
  await sleep(delays.at(-1));
  const seen = await look();
  const end = done(seen);
  if (end) return end;
  if (seen.seen === 'stuck') return { submitted: false };
  if (seen.seen === 'empty') return { submitted: false, reason: 'lost' };
  return { submitted: null };
}

// Before a prompt: a screen that cannot take one now. A notice is closed
// (esc) and the prompt goes ahead; opencode's restart modal would take the
// paste and lose it, so the prompt is not sent: the result to return then.
export const NOTICE_PAUSE_MS = 500;
export async function clearForPrompt({ read, keys, sleep, kind = null }) {
  let screen;
  try {
    screen = await read();
  } catch {
    return null;
  }
  const c = modalShown(screen, kind);
  if (!c) return null;
  if (c.type !== 'notice') return { submitted: false, reason: 'dialog', label: c.label };
  await keys(['esc']);
  await sleep(NOTICE_PAUSE_MS);
  return null;
}

// checkSubmit's answer alone: true, false or null.
export async function submitIfStuck(opts) {
  return (await checkSubmit(opts)).submitted;
}

export function formatRatio(ratio) {
  return String(Number(ratio.toFixed(4)));
}

export function createHerdr({ run, bin = 'herdr', sleep = realSleep, platform = process.platform }) {
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
    // decides whether enter is pressed, with herdr's agent status as the first
    // sign of work. { submitted: false } when the prompt still sits in the
    // input, or a dialog came up; null when it cannot be told.
    async agentPrompt(target, text, { kind = null } = {}) {
      const strategy = submitStrategy(kind);
      const held = await clearForPrompt({ read: () => this.agentRead(target), keys: (k) => this.agentKeys(target, k), sleep, kind });
      if (held) return held;
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
      return checkSubmit({
        read: () => this.agentRead(target), press: () => call(['agent', 'send-keys', target, 'enter']), sleep, text, kind, strategy, platform,
        status: async () => (await this.agentList()).find((a) => a.name === target || a.pane_id === target)?.agent_status ?? null,
      });
    },

    async agentKeys(target, keys) {
      await sendKeys((key) => call(['agent', 'send-keys', target, key]), keys, sleep);
    },
  };
}
