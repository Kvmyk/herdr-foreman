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
  // Read when used, so a resized terminal is noticed; null when not a terminal.
  Object.defineProperty(ui, 'columns', { get: () => stream?.columns ?? null, enumerable: false });
  for (const [name, code] of Object.entries(CODES)) {
    ui[name] = (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  }
  return ui;
}

const pad = (cell, width) => `${cell}${' '.repeat(Math.max(0, width - visibleLength(cell)))}`;

// Left-aligned columns as wide as their widest cell; the last column is not padded.
// headers: strings; rows: arrays of strings (may hold color codes).
export function table({ headers, rows, ui = createUi() }) {
  if (isNarrow(ui)) return blocks({ headers, rows, ui });
  const all = headers ? [headers, ...rows] : rows;
  const widths = headers ? headers.map((_, c) => Math.max(...all.map((r) => visibleLength(r[c] ?? '')))) : [];
  if (!headers) for (const r of rows) r.forEach((cell, c) => { widths[c] = Math.max(widths[c] ?? 0, visibleLength(cell ?? '')); });
  const line = (cells, style = (s) => s) => cells.map((cell, c) => (c === cells.length - 1 ? style(cell ?? '') : `${pad(style(cell ?? ''), widths[c])}`)).join('  ').trimEnd();
  const out = [];
  if (headers) out.push(line(headers.map((h) => ui.dim(h)).map((h, c) => pad(h, widths[c])).slice(0, -1).concat(ui.dim(headers.at(-1)))));
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

// A phone shows about 40 columns. Below 60 the padded tables turn into one
// "name: value" block per row. Unknown width (not a terminal) means wide.
export const NARROW_BELOW = 60;
export const isNarrow = (ui) => Number.isFinite(ui?.columns) && ui.columns > 0 && ui.columns < NARROW_BELOW;

// Breaks text at spaces so no line is longer than width where the words allow;
// continuation lines start with indent. The leading spaces of a line are kept.
export function wrap(text, width, indent = '') {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    const lead = /^ */.exec(para)[0];
    let line = '';
    for (const word of para.slice(lead.length).split(' ')) {
      if (line && visibleLength(line) + 1 + visibleLength(word) > width) {
        out.push(line);
        line = indent + word;
      } else {
        line = line ? `${line} ${word}` : lead + word;
      }
    }
    out.push(line);
  }
  return out;
}

// "label: value" lines for a narrow screen; empty values are left out.
export function kv(label, value, ui, indent = '') {
  if (value === undefined || value === null || value === '') return [];
  return wrap(`${indent}${label}: ${value}`, ui.columns, `${indent}  `);
}

// One block per row on a narrow screen: "header: value" lines, a blank line between rows.
function blocks({ headers, rows, ui }) {
  return rows.map((r) => r.flatMap((cell, c) => {
    const label = String(headers?.[c] ?? '').toLowerCase();
    return label ? kv(label, cell, ui) : wrap(String(cell ?? ''), ui.columns, '  ').filter(Boolean);
  }).join('\n')).join('\n\n');
}
