import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSteps, fit, header, hints, marker, summary } from '../src/ask-view.js';
import { createUi } from '../src/ui.js';
import { readTaskLines } from '../src/task.js';
import { Readable } from 'node:stream';

const plain = createUi({ env: { NO_COLOR: '1' } });
const color = createUi({ env: { FORCE_COLOR: '1' } });
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

test('header names the folder and branch and fits a narrow window', () => {
  const text = header(plain, { cwd: path.resolve('/code/shop'), branch: 'feat/x', columns: 40 });
  assert.match(text, /foreman · new task/);
  assert.match(text, /shop {2}⎇ feat\/x/);
  assert.ok(text.split('\n').every((l) => l.length <= 40));
  assert.doesNotMatch(text, /\x1b/);
});

test('hints list the keys; color only when asked for', () => {
  const t = hints(plain, 80);
  for (const k of ['Enter ×2', 'Ctrl+D', 'e + Enter', '@file', 'Empty first line']) assert.ok(t.includes(k), k);
  assert.doesNotMatch(t, /\x1b/);
  assert.match(hints(color, 80), /\x1b\[/);
  assert.equal(strip(marker(color)), '  ❯ ');
});

test('summary shows the first line, files found and warns about missing ones', () => {
  const text = summary(plain, { task: 'fix @a.js and @gone.js\nmore', cwd: path.resolve('/c'), exists: (p) => p.endsWith('a.js'), columns: 80 });
  assert.match(text, /fix @a.js and @gone.js {2}\(\+1 more lines\)/);
  assert.match(text, /files {2}a\.js/);
  assert.match(text, /! I could not find gone\.js/);
  assert.match(summary(color, { task: 'x @gone', cwd: '/c', exists: () => false }), /\x1b\[33m/);
});

test('steps get check marks, a failure gets a cross, and a pipe sees whole lines only', () => {
  let out = '';
  const steps = createSteps(plain, { write: (s) => { out += s; } });
  steps.step('Checking the project...');
  steps.step('Starting claude...');
  steps.finish(false);
  assert.equal(out, '  ✓ Checking the project\n  ✗ Starting claude\n');
});

test('a terminal rewrites the running step in place', () => {
  let out = '';
  const steps = createSteps(plain, { isTTY: true, write: (s) => { out += s; } });
  steps.step('A...');
  steps.finish(true);
  assert.equal(out, '  › A...\r\x1b[2K  ✓ A\n');
});

test('fit cuts long text with an ellipsis', () => {
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(fit('abc', 4), 'abc');
});

test('readTaskLines shows a marker after each continued line, not after the last', async () => {
  let n = 0;
  const task = await readTaskLines(Readable.from(['one\ntwo\n\n']), null, { afterLine: () => n++ });
  assert.equal(task, 'one\ntwo');
  assert.equal(n, 2);
});
