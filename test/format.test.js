import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgents, formatBrief, formatStats, formatStatus, formatWait } from '../src/format.js';
import { createUi } from '../src/ui.js';

const plain = createUi();

test('agents table has a header and columns sized to the longest cell', () => {
  const text = formatAgents([
    { kind: 'claude', status: 'ready', version: '2.1', models: [{}, {}], defaultModel: 'opus', reason: null },
    { kind: 'mastracode', status: 'unavailable', version: null, models: [], defaultModel: null, reason: 'not signed in' },
  ], plain);
  const [head, a, b] = text.split('\n');
  assert.match(head, /^AGENT\s+STATUS\s+VERSION\s+DETAILS$/);
  assert.equal(a.indexOf('ready'), b.indexOf('unavailable'));
  assert.match(a, /2 models; default opus/);
});

test('status marks a missing push guard and shows lines changed', () => {
  const text = formatStatus([{ name: 'w1', state: 'idle', ageS: 3700, dirty: false, changedFiles: [], added: 0, removed: 0, commitsAhead: 2, report: true, pushGuardArmed: true }], plain);
  assert.match(text, /w1\s+idle\s+1h01m\s+clean\s+0\s+\+0 -0\s+2\s+report\s+armed/);
});

test('wait shows each worker, the screen tail and the hint', () => {
  const text = formatWait({ result: 'attention', elapsedS: 5, workers: { a: 'working', b: { state: 'idle', note: 'finished without report.md', screen: 'one\ntwo' } } }, plain);
  assert.match(text, /^attention after 5s/);
  assert.match(text, /b\s+idle \(finished without report.md\)/);
  assert.match(text, /two/);
});

test('brief and stats summarise instead of dumping JSON', () => {
  const b = formatBrief({ agents: [{ kind: 'claude', models: [{ id: 'opus' }], defaultModel: 'opus' }], unavailable: [{ kind: 'codex', status: 'start_failed', reason: 'boom' }] }, plain);
  assert.match(b, /claude\s+1 models, default opus/);
  assert.match(b, /codex\s+start_failed: boom/);
  const s = formatStats({ bugfix: [{ kind: 'claude', model: null, n: 2, approvalRate: 0.5, firstPassRate: null, stuckRate: 0, trusted: false }] }, plain);
  assert.match(s, /claude\s+-\s+2\s+50%\s+-\s+0%\s+few samples/);
  assert.match(formatStats({}, plain), /^no results yet/);
});
