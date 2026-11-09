// What the task prompt window (plugin/ask.js) shows: header, key hints,
// input marker, confirmation summary and progress steps. Pure text; colors
// come from ui.js, so NO_COLOR is respected.
import path from 'node:path';
import { EXAMPLE, parseMentions } from './task.js';
import { visibleLength } from './ui.js';

const INDENT = '  ';

export function fit(text, width) {
  const s = String(text);
  return s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`;
}

// "─ foreman · new task ───────" with the folder and branch under it.
export function header(ui, { cwd, branch = null, columns = 80 }) {
  const width = Math.max(24, Math.min(columns - 4, 72));
  const title = ` foreman · new task `;
  const rule = '─'.repeat(Math.max(2, width - title.length - 2));
  const where = `${path.basename(cwd) || cwd}${branch ? `  ⎇ ${branch}` : ''}`;
  return [
    '',
    `${INDENT}${ui.dim('──')}${ui.bold(ui.cyan(title))}${ui.dim(rule)}`,
    `${INDENT}${ui.dim(fit(`${where}`, width))}`,
    `${INDENT}${ui.dim(fit(cwd, width))}`,
    '',
  ].join('\n');
}

const key = (ui, k, text) => `${INDENT}${ui.cyan(k.padEnd(18))}${ui.dim(text)}`;

export function hints(ui, columns = 80) {
  return [
    `${INDENT}${ui.dim(fit('Describe what you want done, in your own words.', columns - 4))}`,
    `${INDENT}${ui.dim(fit(`e.g. ${EXAMPLE}`, columns - 4))}`,
    '',
    key(ui, 'Enter ×2', 'an empty line starts the task'),
    key(ui, 'Ctrl+D', 'start right away'),
    key(ui, 'e + Enter', 'write it in an editor instead'),
    key(ui, '@file', 'point at files; links work too'),
    key(ui, 'Empty first line', 'cancel'),
    '',
  ].join('\n');
}

export const marker = (ui) => `${INDENT}${ui.cyan(ui.bold('❯'))} `;

// What foreman understood: the first line of the task, files found, warnings.
export function summary(ui, { task, cwd, exists, columns = 80 }) {
  const lines = task.split(/\r?\n/);
  const out = ['', `${INDENT}${ui.bold(fit(lines[0], columns - 6))}${lines.length > 1 ? ui.dim(`  (+${lines.length - 1} more lines)`) : ''}`];
  const found = [];
  const missing = [];
  for (const m of parseMentions(task)) (exists(path.resolve(cwd, m)) ? found : missing).push(m);
  if (found.length) out.push(`${INDENT}${ui.dim('files')}  ${found.map((f) => ui.green(f)).join(ui.dim(', '))}`);
  for (const m of missing) out.push(`${INDENT}${ui.yellow(`! I could not find ${m}`)}`);
  out.push('');
  return out.join('\n');
}

// Progress steps: the running step stays on one line (rewritten in a
// terminal), finished ones get a check mark.
export function createSteps(ui, stdout) {
  let pending = null;
  const clean = (m) => m.replace(/\.\.\.$/, '');
  const live = Boolean(stdout.isTTY);
  const erase = live ? '\r\x1b[2K' : '';
  return {
    step(m) {
      if (pending) stdout.write(`${erase}${INDENT}${ui.green('✓')} ${clean(pending)}\n`);
      pending = m;
      stdout.write(live ? `${INDENT}${ui.dim('›')} ${m}` : '');
    },
    finish(ok) {
      if (!pending) return;
      const mark = ok ? ui.green('✓') : ui.red('✗');
      stdout.write(`${erase}${INDENT}${mark} ${clean(pending)}\n`);
      pending = null;
    },
  };
}

export { visibleLength };
