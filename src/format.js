// What a person reads for each command (JSON stays the machine format).
import { table } from './ui.js';

const dur = (s) => {
  if (s === null || s === undefined) return '-';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

export function formatAgents(agents, ui) {
  if (!agents.length) return 'No agent kinds known to herdr were found on PATH.';
  const rows = agents.map((a) => [
    a.kind,
    a.status === 'ready' ? ui.green(a.status) : ui.yellow(a.status),
    String(a.version ?? ''),
    [a.models.length ? `${a.models.length} models` : '', a.defaultModel ? `default ${a.defaultModel}` : '', a.reason].filter(Boolean).join('; '),
  ]);
  return table({ headers: ['AGENT', 'STATUS', 'VERSION', 'DETAILS'], rows, ui });
}

// The first line of an error; the pane tail that follows is shown below the table.
const firstLine = (text) => String(text).split(/\r?\n/)[0];

export function formatSpawn(v, ui) {
  const out = [];
  const rows = v.workers.map((w) => [
    w.name, w.kind, String(w.paneId ?? '-'),
    w.status === 'ready' ? ui.green('ready') : ui.red(w.status),
  ]);
  out.push(table({ headers: ['WORKER', 'AGENT', 'PANE', 'STATUS'], rows, ui }));
  for (const w of v.workers.filter((x) => x.status !== 'ready')) {
    if (w.exited) out.push(ui.red(`${w.name}: failed to start: ${firstLine(w.error)}; pane ${w.paneId ?? '-'} left open`));
    else out.push(ui.yellow(`${w.name}: not ready: ${firstLine(w.error)}`));
    const tail = String(w.error ?? '').split(/\r?\n/).slice(1).filter(Boolean);
    for (const l of tail.slice(-6)) out.push(ui.dim(`    ${l}`));
  }
  if (v.snapshot) out.push('workers start from a copy that includes your uncommitted changes');
  for (const warning of v.warnings) out.push(ui.yellow(`warning: ${warning}`));
  return out.join('\n');
}

export function formatStatus(list, ui) {
  const rows = list.map((s) => [
    s.name,
    s.state ?? '-',
    dur(s.ageS),
    s.missing ? ui.red('missing') : s.dirty ? 'changed' : 'clean',
    `${s.files ?? s.changedFiles?.length ?? 0}`,
    `${ui.green(`+${s.added ?? 0}`)} ${ui.red(`-${s.removed ?? 0}`)}`,
    String(s.commitsAhead),
    s.report ? 'report' : s.proposals ? 'proposals' : '-',
    s.pushGuardArmed ? 'armed' : ui.red('MISSING'),
  ]);
  return table({ headers: ['WORKER', 'AGENT', 'TIME', 'TREE', 'FILES', 'LINES', 'COMMITS', 'WRITTEN', 'GUARD'], rows, ui });
}

export function formatWait(res, ui) {
  const out = [`${res.result} after ${dur(res.elapsedS)}`];
  for (const [name, w] of Object.entries(res.workers)) {
    const state = typeof w === 'string' ? w : w.state;
    const color = state === 'done' ? ui.green : ['working', 'starting'].includes(state) ? ui.cyan : ui.red;
    out.push(`  ${name.padEnd(12)}${color(state)}${w.note ? ` (${w.note})` : ''}`);
    if (w.hint) out.push(`      ${w.hint}`);
    if (w.screen) for (const l of String(w.screen).split(/\r?\n/).slice(-5)) out.push(ui.dim(`      ${l}`));
  }
  return out.join('\n');
}

export function formatBrief(b, ui) {
  const out = [];
  out.push(ui.bold('Agents ready'));
  for (const a of b.agents ?? []) {
    out.push(`  ${a.kind.padEnd(10)}${a.models?.length ?? 0} models${a.defaultModel ? `, default ${a.defaultModel}` : ''}${a.note ? ` (${a.note})` : ''}`);
  }
  if (!b.agents?.length) out.push('  none');
  if (b.unavailable?.length) {
    out.push('', ui.bold('Not available'));
    for (const u of b.unavailable) out.push(`  ${u.kind.padEnd(10)}${ui.yellow(u.status)}${u.reason ? `: ${u.reason}` : ''}`);
  }
  for (const w of b.warnings ?? []) out.push('', ui.yellow(`warning: ${w}`));
  if (b.repoDirty) out.push('', ui.yellow('Your working tree has uncommitted changes; workers start from the last commit.'));
  out.push('', ui.dim('Add --json for the full brief.'));
  return out.join('\n');
}

export function formatKnowledge(k, ui) {
  const from = { builtin: 'the copy installed with foreman', cache: `${k.url} (cached today)`, remote: k.url }[k.source] ?? k.source;
  const out = [
    `${ui.bold('Knowledge')} from ${from}, updated ${k.updated}`,
    `  ${k.harnesses} harnesses, ${k.families} model families${k.url ? '' : ' (knowledgeUrl is off)'}`,
  ];
  if (k.stale.length) out.push(`  stale: ${k.stale.map((f) => f.id).join(', ')}`);
  if (k.auto.length) out.push(`  added automatically, no data yet: ${k.auto.join(', ')}`);
  for (const w of k.warnings ?? []) out.push(ui.yellow(`warning: ${w}`));
  return out.join('\n');
}

const pct = (x) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);

export function formatStats(stats, ui) {
  const cats = Object.keys(stats);
  if (!cats.length) return 'no results yet; the leader adds them with "foreman journal add"';
  const out = [];
  for (const cat of cats) {
    out.push(ui.bold(cat));
    const rows = stats[cat].map((r) => [r.kind, r.model ?? '-', String(r.n), pct(r.approvalRate), pct(r.firstPassRate), pct(r.stuckRate), r.trusted ? '' : ui.dim('few samples')]);
    out.push(table({ headers: ['AGENT', 'MODEL', 'RUNS', 'APPROVED', 'FIRST PASS', 'STUCK', ''], rows, ui }));
  }
  return out.join('\n');
}
