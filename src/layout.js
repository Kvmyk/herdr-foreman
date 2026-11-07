// Pane layout for workers: equal columns, at most maxRows panes per column.
// herdr's split ratio is the share that stays in the pane being split.

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
