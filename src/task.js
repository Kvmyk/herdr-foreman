// Getting the task text from the user: friendly hints, multi-line input,
// an editor, and @path mentions of files.
import path from 'node:path';
import { createInterface } from 'node:readline';

export const EXAMPLE = 'Fix the login page so it shows an error for a wrong password. See @src/login.js and https://github.com/me/app/issues/12';

export const HINT = `Describe what you want done, in your own words.
  Example: ${EXAMPLE}
  Point at files with @ and the file name; links work too.`;

// Bracketed paste: while it is on, the terminal wraps pasted text in markers,
// so a paste can be told from typing.
export const PASTE_ON = '\x1b[?2004h';
export const PASTE_OFF = '\x1b[?2004l';

// Read lines until an empty line (after some text) or the end of input. An
// empty first line gives an empty task. Returns the lines joined by newlines.
// With editKey, a first line that is just that key finishes at once and returns it.
// With command, a first line it accepts (returns true or a promise of true) is
// a setting such as "/leader codex", not part of the task; lines are handled in order.
//
// On a terminal (input and output are TTYs, or terminal: true) the line is
// edited by node's readline and bracketed paste is on while reading: a pasted
// block, blank lines included, is one task that the next Enter starts. Lines
// that arrive within burstMs of each other count as a paste too, for
// terminals that send no paste markers. Both are switched back on the way out.
//   prompt: the marker in front of each line (already on screen for the first)
//   single: Enter starts a typed line at once; an empty line is ignored
//   escape: Esc clears what was typed or pasted so far
//   interrupt: called on Ctrl+C; true keeps reading, anything else cancels
export function readTaskLines(input, output = null, options = {}) {
  const reader = createTaskReader(input, output, options);
  return reader.next().then((text) => {
    reader.close();
    return text;
  });
}

// The same reading, for a program that takes one task after another (the
// launcher): next() gives the next task, close() ends the reading. The
// terminal stays in one mode from the first task to the last, so nothing typed
// or pasted between two tasks is lost or seen half; what arrives early waits
// for the next next(). After the input has ended, next() gives '' and `ended` is true.
export function createTaskReader(input, output = null, {
  editKey = null, afterLine = null, command = null, prompt = null, single = false, escape = false, interrupt = null,
  terminal = Boolean(input.isTTY && output?.isTTY), burstMs = 50, now = Date.now,
} = {}) {
  // An input that has ended already (a pipe read to its end) never says so again.
  const gone = Boolean(input.readableEnded || input.destroyed);
  const rl = gone ? null
    : terminal ? createInterface({ input, output, terminal: true, prompt: prompt ?? '', escapeCodeTimeout: 50, historySize: 0 })
      : createInterface({ input, terminal: false });
  if (rl && terminal) output.write(PASTE_ON);

  let lines = [];
  let ended = gone; // no more input will come
  let closed = false; // close() was called
  let pasting = false; // between the paste markers
  let pasteLines = 0;
  let startedEmpty = false;
  let afterPaste = false; // a paste holds the task: the next Enter starts it
  let lastAt = -Infinity;
  let received = 0;
  const results = []; // finished tasks nobody asked for yet
  let waiting = null; // the next() that waits for one

  const deliver = (text) => {
    if (waiting) {
      const give = waiting;
      waiting = null;
      give(text);
    } else {
      results.push(text);
    }
  };
  // One task is complete: hand it over, and what follows is the next one.
  const finish = () => {
    const text = lines.join('\n').trim();
    lines = [];
    afterPaste = false;
    deliver(text);
  };
  // The marker again, for the next line.
  const again = () => {
    if (ended || closed) return;
    if (terminal) rl.prompt();
    else if (prompt && output) output.write(prompt);
  };
  const keep = (line) => lines.push(line.replace(/\s+$/, ''));
  let queue = Promise.resolve();
  const later = (fn) => { queue = queue.then(fn); };

  const onKey = (_s, key) => {
    if (key?.name === 'paste-start') {
      pasting = true;
      pasteLines = 0;
      startedEmpty = rl.line === '';
    } else if (key?.name === 'paste-end') {
      pasting = false;
      // What follows the markers is typed, however soon it comes.
      lastAt = -Infinity;
      const [count, empty, tail] = [pasteLines, startedEmpty, rl.line.trim()];
      later(() => {
        // Several lines, or a paste into an empty prompt, are the whole task;
        // one line pasted into typed text is just more text.
        if (count > 0) afterPaste = lines.length > 0 || Boolean(tail);
        else if (empty && lines.length === 0 && tail) afterPaste = true;
        if (count > 0) again();
      });
    } else if (key?.name === 'escape' && escape && !pasting) {
      rl.write(null, { ctrl: true, name: 'e' });
      rl.write(null, { ctrl: true, name: 'u' });
      later(() => { lines = []; afterPaste = false; });
    }
  };

  const onLine = async (line, { pasted, quiet, index }) => {
    if (closed) return undefined;
    if (command && lines.length === 0 && line.trim() && (await command(line))) {
      afterPaste = false;
      return quiet ? undefined : again();
    }
    if (pasted) {
      // Inside a paste a blank line is text, not the end of the task.
      if (lines.length || line.trim()) keep(line);
      afterPaste = lines.length > 0;
      return quiet ? undefined : again();
    }
    if (afterPaste) {
      if (line.trim()) keep(line);
      return finish();
    }
    if (!line.trim()) return single && !lines.length ? again() : finish();
    if (editKey && lines.length === 0 && line.trim().toLowerCase() === editKey) {
      lines.push(editKey);
      return finish();
    }
    keep(line);
    if (single) {
      // The first line of a paste without markers looks typed: give the rest a moment to arrive.
      if (terminal && burstMs > 0) await new Promise((r) => setTimeout(r, burstMs));
      if (received === index) return finish();
      afterPaste = true;
      return undefined;
    }
    afterLine?.();
    return again();
  };

  if (rl) {
    if (terminal) {
      input.on('keypress', onKey);
      rl.on('SIGINT', () => {
        if (interrupt?.() === true) return again();
        return later(() => {
          lines = [];
          afterPaste = false;
          output.write('\n');
          deliver('');
        });
      });
    }
    rl.on('line', (line) => {
      const at = now();
      const pasted = terminal && (pasting || at - lastAt <= burstMs);
      lastAt = at;
      if (pasting) pasteLines++;
      const index = ++received;
      later(() => onLine(line, { pasted, quiet: pasting, index }));
    });
    rl.on('close', () => later(() => {
      // Ctrl+D leaves the cursor on the input line.
      if (terminal && !closed && !ended) output.write('\n');
      ended = true;
      if (lines.length) finish();
      if (waiting) deliver('');
    }));
  }

  return {
    get ended() { return ended; },
    next() {
      if (results.length) return Promise.resolve(results.shift());
      if (ended || closed) return Promise.resolve('');
      return new Promise((resolve) => { waiting = resolve; });
    },
    close() {
      if (closed) return;
      closed = true;
      if (rl) {
        if (terminal) {
          input.off('keypress', onKey);
          output.write(PASTE_OFF);
        }
        rl.close();
      }
      if (waiting) deliver('');
    },
  };
}

// True when "e" would open a window on the computer foreman runs on (Notepad,
// VS Code) instead of an editor in this terminal: someone reading the terminal
// from another device would never see it.
export function editorOpensWindow(env, platform = process.platform) {
  const cmd = editorCommand(env, platform).trim().toLowerCase();
  const program = /^"([^"]*)"/.exec(cmd)?.[1] ?? cmd.split(/\s+/)[0];
  const name = program.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/, '');
  return ['notepad', 'notepad++', 'code', 'code-insiders', 'cursor', 'subl', 'atom', 'zed', 'gedit', 'kate', 'mate', 'open', 'start', 'idea', 'webstorm'].includes(name);
}

const EDITOR_NOTE = `# Write your task below, then save and close the editor.
# Lines starting with # are ignored.
# Example: ${EXAMPLE}
`;

export function editorCommand(env, platform = process.platform) {
  const named = env.VISUAL || env.EDITOR;
  if (named) return named;
  return platform === 'win32' ? 'notepad' : 'nano';
}

// Let the user write the task in an editor. Returns the text, or null when no
// editor could be used (the caller falls back to typing). An editor that
// returns at once with the file untouched (code, subl without --wait) gets a
// hint through report.
export function editTask({ env, platform = process.platform, spawnSync, readFile, writeFile, removeFile, tmpdir, now = Date.now, report = () => {} }) {
  const file = path.join(tmpdir, `foreman-task-${Date.now()}.md`);
  try {
    writeFile(file, EDITOR_NOTE);
    const cmd = editorCommand(env, platform);
    const started = now();
    const res = spawnSync(`${cmd} "${file}"`, { stdio: 'inherit', shell: true });
    if (res.error || res.status) return null;
    const text = readFile(file);
    if (now() - started < 1000 && text.replace(/\r\n/g, '\n') === EDITOR_NOTE) {
      const example = platform === 'win32' ? `in PowerShell: $env:EDITOR = 'code --wait'` : `export EDITOR='code --wait'`;
      report(`Your editor (${cmd}) closed at once, before you could write anything. Set EDITOR to one that waits until you close the file, for example ${example}.`);
      return null;
    }
    return text.split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n').trim();
  } catch {
    return null;
  } finally {
    try { removeFile(file); } catch { /* temp file already gone */ }
  }
}

// @path (or @"path with spaces") tokens in a task. Emails (name@host) do not count.
export function parseMentions(task) {
  const found = [];
  const re = /(?<![\w@.\/\-])@(?:"([^"\n]+)"|([^\s"'`,;:!?()<>]+))/g;
  for (const m of task.matchAll(re)) {
    const p = (m[1] ?? m[2]).replace(/[.]+$/, '');
    if (p && !found.includes(p)) found.push(p);
  }
  return found;
}

const posix = (p) => p.split(path.sep).join('/');

// Check the mentioned files. Returns { files: [{ path, dirty }], missing: [path] };
// paths are shown relative to the repository.
export async function resolveMentions({ task, cwd, repo, exists, git }) {
  const wanted = parseMentions(task);
  const files = [];
  const missing = [];
  for (const m of wanted) {
    const abs = path.resolve(cwd, m);
    if (exists(abs)) files.push({ path: posix(path.relative(repo, abs)) || '.', abs });
    else missing.push(m);
  }
  if (files.length) {
    const changed = (await git.changedFiles(repo).catch(() => [])).map((f) => f.replace(/^.* -> /, ''));
    for (const f of files) f.dirty = changed.some((c) => c === f.path || c.startsWith(`${f.path}/`));
  }
  return { files, missing };
}
