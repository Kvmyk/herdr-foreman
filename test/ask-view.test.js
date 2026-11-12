import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSteps, fit, header, hints, marker, summary, NARROW } from '../src/ask-view.js';
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

test('under 60 columns the hints are a few short lines that fit a 40-column phone screen', () => {
  for (const columns of [40, 59]) {
    const t = hints(plain, columns);
    const lines = t.split('\n');
    assert.ok(lines.length <= 9, `${lines.length} lines`);
    assert.ok(lines.every((l) => l.length <= 40), lines.find((l) => l.length > 40));
    for (const k of ['Paste or type', 'empty line starts', 'one Enter', '@file', '/leader', '/branch', '/auto', '/uncommitted', 'cancels']) assert.ok(t.includes(k), k);
    // Nothing that needs a hardware keyboard or an editor on the computer.
    assert.doesNotMatch(t, /Ctrl\+D|e \+ Enter|editor/);
    assert.doesNotMatch(t, /\x1b/);
  }
  assert.equal(NARROW, 60);
  assert.ok(hints(plain, 60).includes('Ctrl+D'), 'at 60 columns the full hints are back');
  assert.match(hints(color, 40), /\x1b\[/);
  // Narrower than the text: cut, never wrapped.
  assert.ok(hints(plain, 24).split('\n').every((l) => l.length <= 24));
});

test('the editor hint is left out when the editor would open a window on the computer', () => {
  assert.ok(hints(plain, 80).includes('e + Enter'));
  assert.ok(hints(plain, 80, { editor: true }).includes('e + Enter'));
  const none = hints(plain, 80, { editor: false });
  assert.ok(!none.includes('e + Enter') && !none.includes('editor'));
  for (const k of ['Enter ×2', 'Paste, Enter', 'Ctrl+D', '@file', '/leader <kind>']) assert.ok(none.includes(k), k);
});
