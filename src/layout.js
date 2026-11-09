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
