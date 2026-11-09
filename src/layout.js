// Pane layout for workers. herdr's split ratio is the share that stays in the
// pane being split.
//   stack (default): the leader keeps a full-height column of LEADER_SHARE on
//     the left; workers are stacked in one column on the right, and in a tab
//     of their own use a second column only past MAX_ROWS.stack workers.
//   grid: equal columns, at most MAX_ROWS.grid panes per column.

export const LAYOUTS = Object.freeze(['stack', 'grid']);
export const LEADER_SHARE = 0.4;
const MAX_ROWS = Object.freeze({ stack: 4, grid: 3 });

// More workers than this beside the leader leave panes too narrow (or too
// short) to read an agent's dialogs (a trust prompt, a model picker): they get
// a tab of their own.
export const MAX_BESIDE_LEADER = Object.freeze({ stack: 4, grid: 3 });

export const layoutOf = (config) => (config?.layout === 'grid' ? 'grid' : 'stack');

export function planLayout(n, maxRows = 3) {
  const cols = Math.ceil(n / maxRows);
  const rows = Array.from({ length: cols }, (_, c) => Math.floor(n / cols) + (c < n % cols ? 1 : 0));
  return { cols, rows };
}

export function columnRatios(cols) {
  return Array.from({ length: Math.max(cols - 1, 0) }, (_, k) => 1 / (cols - (k + 1) + 1));
}

export function rowRatios(rows) {
  return Array.from({ length: Math.max(rows - 1, 0) }, (_, k) => 1 / (rows - (k + 1) + 1));
}

// Everything openPanes needs to place n workers: the ratio of the first split
// of the leader's pane (null in a new tab), the columns, and the splits inside them.
export function planPanes(n, { layout = 'stack', newTab = false } = {}) {
  const { cols, rows } = planLayout(n, MAX_ROWS[layout] ?? MAX_ROWS.stack);
  let leaderRatio = null;
  if (!newTab) leaderRatio = layout === 'grid' ? 1 / (cols + 1) : LEADER_SHARE;
  return { leaderRatio, cols, rows, colRatios: columnRatios(cols), rowRatios: rows.map(rowRatios) };
}

// The Herdr app has no split ratios: a terminal started without a pane is
// given one right or down of the focused pane (terminal.keep), which halves
// that pane's weight, and a split in the direction of its parent joins it, so
// a column is one split whose children are sized by weight (layout.resize).
// The steps below, in order, stack n workers that way:
//   { worker, anchor, place }  keep the worker right/down of anchor ('leader'
//                              or a worker index); place null: worker 0 of a
//                              new tab, shown there by its labels
//   { worker, weight }         size the worker's pane
//   { leader: weight }         size the leader's pane: alone in its tab it
//                              weighs 1 and keeps half of it after the split
export function appStackSteps(n, { newTab = false } = {}) {
  const { cols, rows } = planPanes(n, { layout: 'stack', newTab });
  const tops = rows.map((_, c) => rows.slice(0, c).reduce((s, r) => s + r, 0));
  const steps = [];
  if (newTab) {
    steps.push({ worker: 0, anchor: null, place: null });
    // Every column's top before any column is split down, then equal columns.
    for (let c = 1; c < cols; c++) steps.push({ worker: tops[c], anchor: tops[c - 1], place: 'right' });
    if (cols > 2) tops.forEach((t) => steps.push({ worker: t, weight: 1 }));
  } else {
    steps.push({ worker: 0, anchor: 'leader', place: 'right' });
  }
  rows.forEach((r, c) => {
    for (let j = 1; j < r; j++) steps.push({ worker: tops[c] + j, anchor: tops[c] + j - 1, place: 'down' });
  });
  rows.forEach((r, c) => {
    if (r > 1) for (let j = 0; j < r; j++) steps.push({ worker: tops[c] + j, weight: 1 });
  });
  if (!newTab) steps.push({ leader: LEADER_SHARE / (1 - LEADER_SHARE) / 2 });
  return steps;
}
