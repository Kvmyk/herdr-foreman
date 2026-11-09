import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLayout, columnRatios, rowRatios, planPanes, layoutOf, MAX_BESIDE_LEADER, appStackSteps } from '../src/layout.js';
import { DEFAULT_CONFIG } from '../src/config.js';

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

test('stack: leader keeps 40%, workers stacked in one column beside it', () => {
  assert.deepEqual(planPanes(3), { leaderRatio: 0.4, cols: 1, rows: [3], colRatios: [], rowRatios: [[1 / 3, 1 / 2]] });
  assert.deepEqual(planPanes(4).rows, [4]);
  assert.equal(MAX_BESIDE_LEADER.stack, 4);
});

test('stack in a new tab: one column up to four workers, then two', () => {
  assert.deepEqual(planPanes(4, { newTab: true }), { leaderRatio: null, cols: 1, rows: [4], colRatios: [], rowRatios: [[1 / 4, 1 / 3, 1 / 2]] });
  const six = planPanes(6, { newTab: true });
  assert.deepEqual([six.cols, six.rows, six.colRatios], [2, [3, 3], [1 / 2]]);
  assert.deepEqual(planPanes(5, { newTab: true }).rows, [3, 2]);
});

test('grid keeps the old columns of three', () => {
  assert.deepEqual(planPanes(3, { layout: 'grid' }), { leaderRatio: 1 / 2, cols: 1, rows: [3], colRatios: [], rowRatios: [[1 / 3, 1 / 2]] });
  assert.deepEqual(planPanes(5, { layout: 'grid', newTab: true }).rows, [3, 2]);
  assert.equal(MAX_BESIDE_LEADER.grid, 3);
});

test('layoutOf defaults to stack', () => {
  assert.equal(layoutOf({}), 'stack');
  assert.equal(layoutOf({ layout: 'nonsense' }), 'stack');
  assert.equal(layoutOf({ layout: 'grid' }), 'grid');
  assert.equal(layoutOf(DEFAULT_CONFIG), 'stack');
});

test('appStackSteps: beside the leader, workers kept one under another, then sized', () => {
  const one = appStackSteps(1);
  assert.deepEqual(one[0], { worker: 0, anchor: 'leader', place: 'right' });
  assert.equal(one.length, 2);
  assert.ok(Math.abs(one[1].leader - 1 / 3) < 1e-9);
  const steps = appStackSteps(3);
  assert.deepEqual(steps.filter((s) => s.place), [
    { worker: 0, anchor: 'leader', place: 'right' },
    { worker: 1, anchor: 0, place: 'down' },
    { worker: 2, anchor: 1, place: 'down' },
  ]);
  assert.deepEqual(steps.filter((s) => 'weight' in s).map((s) => [s.worker, s.weight]), [[0, 1], [1, 1], [2, 1]]);
  // The leader keeps 40%: weight w against the column's 1/2.
  const w = steps.at(-1).leader;
  assert.ok(Math.abs(w / (w + 0.5) - 0.4) < 1e-9);
});

test('appStackSteps: a new tab starts from the labelled first worker, column tops first', () => {
  assert.deepEqual(appStackSteps(5, { newTab: true }).filter((s) => 'place' in s), [
    { worker: 0, anchor: null, place: null },
    { worker: 3, anchor: 0, place: 'right' },
    { worker: 1, anchor: 0, place: 'down' },
    { worker: 2, anchor: 1, place: 'down' },
    { worker: 4, anchor: 3, place: 'down' },
  ]);
  assert.ok(!appStackSteps(5, { newTab: true }).some((s) => 'leader' in s));
  assert.deepEqual(appStackSteps(1, { newTab: true }), [{ worker: 0, anchor: null, place: null }]);
  // Three columns: the tops are made equal before they are split down.
  const nine = appStackSteps(9, { newTab: true });
  const tops = nine.slice(3, 6);
  assert.deepEqual(tops, [{ worker: 0, weight: 1 }, { worker: 3, weight: 1 }, { worker: 6, weight: 1 }]);
});
