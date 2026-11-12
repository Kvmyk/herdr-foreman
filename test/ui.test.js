import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorEnabled, createUi, table, visibleLength } from '../src/ui.js';

test('color follows NO_COLOR, FORCE_COLOR and the terminal', () => {
  const tty = { isTTY: true };
  assert.equal(colorEnabled({ env: {}, stream: tty }), true);
  assert.equal(colorEnabled({ env: {}, stream: { isTTY: false } }), false);
  assert.equal(colorEnabled({ env: {}, stream: null }), false);
  assert.equal(colorEnabled({ env: { NO_COLOR: '1' }, stream: tty }), false);
  assert.equal(colorEnabled({ env: { NO_COLOR: '1', FORCE_COLOR: '1' }, stream: tty }), false);
  assert.equal(colorEnabled({ env: { FORCE_COLOR: '1' }, stream: { isTTY: false } }), true);
  assert.equal(colorEnabled({ env: { FORCE_COLOR: '0' }, stream: tty }), false);
  assert.equal(colorEnabled({ env: { TERM: 'dumb' }, stream: tty }), false);
});

test('helpers are plain text without color and wrap with it', () => {
  assert.equal(createUi({ env: { NO_COLOR: '1' } }).red('x'), 'x');
  const ui = createUi({ env: { FORCE_COLOR: '1' } });
  assert.equal(ui.red('x'), '\x1b[31mx\x1b[0m');
  assert.equal(visibleLength(ui.red('abc')), 3);
});

test('table sizes columns to their widest cell, colored or not', () => {
  const ui = createUi({ env: { FORCE_COLOR: '1' } });
  const rows = [['a', ui.red('failed'), 'x'], ['longname', 'ok', 'y']];
  const plain = table({ headers: ['NAME', 'STATE', 'NOTE'], rows: [['a', 'failed', 'x'], ['longname', 'ok', 'y']] });
  assert.equal(plain, ['NAME      STATE   NOTE', 'a         failed  x', 'longname  ok      y'].join('\n'));
  const colored = table({ headers: ['NAME', 'STATE', 'NOTE'], rows, ui }).replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(colored, plain);
});

test('narrow terminals get name: value blocks, unknown width stays a table', () => {
  const narrow = createUi({ stream: { columns: 40 } });
  const text = table({ headers: ['NAME', 'STATE'], rows: [['w1', 'idle'], ['w2', 'done']], ui: narrow });
  assert.equal(text, 'name: w1\nstate: idle\n\nname: w2\nstate: done');
  assert.match(table({ headers: ['NAME', 'STATE'], rows: [['w1', 'idle']], ui: createUi({ stream: { columns: 80 } }) }), /^NAME\s+STATE/);
});
