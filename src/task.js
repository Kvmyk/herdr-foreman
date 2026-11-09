// Getting the task text from the user: friendly hints, multi-line input,
// an editor, and @path mentions of files.
import path from 'node:path';
import { createInterface } from 'node:readline';

export const EXAMPLE = 'Fix the login page so it shows an error for a wrong password. See @src/login.js and https://github.com/me/app/issues/12';

export const HINT = `Describe what you want done, in your own words.
  Example: ${EXAMPLE}
  Point at files with @ and the file name; links work too.`;

// Read lines until an empty line (after some text) or the end of input. An
// empty first line gives an empty task. Returns the lines joined by newlines.
// With editKey, a first line that is just that key finishes at once and returns it.
export function readTaskLines(input, output = null, { editKey = null, afterLine = null } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output: output ?? undefined, terminal: false });
    const lines = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      rl.close();
      resolve(lines.join('\n').trim());
    };
    rl.on('line', (line) => {
      if (!line.trim()) return finish();
      if (editKey && lines.length === 0 && line.trim().toLowerCase() === editKey) {
        lines.push(editKey);
        return finish();
      }
      lines.push(line.replace(/\s+$/, ''));
      afterLine?.();
    });
    rl.on('close', finish);
  });
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
