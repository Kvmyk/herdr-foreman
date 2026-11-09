// Colors and tables for what a person reads in the terminal. --json output
// never goes through here.

const CODES = { red: 31, green: 32, yellow: 33, cyan: 36, dim: 2, bold: 1 };
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export const visibleLength = (text) => String(text).replace(ANSI, '').length;

// NO_COLOR (set, not empty) turns color off, FORCE_COLOR (not "0") turns it on,
// otherwise color follows whether the stream is a terminal.
export function colorEnabled({ env = {}, stream = null } = {}) {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0';
  return Boolean(stream?.isTTY) && env.TERM !== 'dumb';
}

export function createUi({ env = {}, stream = null } = {}) {
  const color = colorEnabled({ env, stream });
  const ui = { color };
  for (const [name, code] of Object.entries(CODES)) {
    ui[name] = (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  }
  return ui;
}

const pad = (cell, width) => `${cell}${' '.repeat(Math.max(0, width - visibleLength(cell)))}`;

// Left-aligned columns as wide as their widest cell; the last column is not padded.
// headers: strings; rows: arrays of strings (may hold color codes).
export function table({ headers, rows, ui = createUi() }) {
  const all = headers ? [headers, ...rows] : rows;
  const widths = headers ? headers.map((_, c) => Math.max(...all.map((r) => visibleLength(r[c] ?? '')))) : [];
  if (!headers) for (const r of rows) r.forEach((cell, c) => { widths[c] = Math.max(widths[c] ?? 0, visibleLength(cell ?? '')); });
  const line = (cells, style = (s) => s) => cells.map((cell, c) => (c === cells.length - 1 ? style(cell ?? '') : `${pad(style(cell ?? ''), widths[c])}`)).join('  ').trimEnd();
  const out = [];
  if (headers) out.push(line(headers.map((h) => ui.dim(h)).map((h, c) => pad(h, widths[c])).slice(0, -1).concat(ui.dim(headers.at(-1)))));
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}
