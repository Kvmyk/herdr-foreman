import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLayout, columnRatios, rowRatios } from '../src/layout.js';

test('planLayout spreads workers over columns of at most three', () => {
  assert.deepEqual(planLayout(1), { cols: 1, rows: [1] });
  assert.deepEqual(planLayout(3), { cols: 1, rows: [3] });
  assert.deepEqual(planLayout(4), { cols: 2, rows: [2, 2] });
  assert.deepEqual(planLayout(7), { cols: 3, rows: [3, 2, 2] });
});

test('ratios match agenci.ps1', () => {
  assert.deepEqual(columnRatios(3), [1 / 3, 1 / 2]);
  assert.deepEqual(columnRatios(1), []);
  assert.deepEqual(rowRatios(3), [1 / 3, 1 / 2]);
  assert.deepEqual(rowRatios(2), [1 / 2]);
});
