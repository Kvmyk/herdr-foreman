import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appSpaces, rankSpaces } from '../src/app-spaces.js';
import { fakeRun } from './helpers.js';

const tab = (id, ...terminals) => ({ id, root: { type: 'row', children: terminals.map((t) => ({ type: 'block', content: { terminal: t } })) } });
const DOC = {
  spaces: [
    { id: 'spOld', folder: '/code/shop', name: 'shop', tabs: [tab('tb1', 't1')] },
    { id: 'spNew', folder: '/code/blog', name: '', tabs: [tab('tb2', 't2', 't3')] },
    { id: 'spEmpty', folder: '/code/api', tabs: [] },
    { folder: '/no/id' },
  ],
};
const TERMINALS = [
  { address: 't1', created_ms: 100, status_ms: 900 },
  { address: 't2', created_ms: 200, status_ms: null },
  { address: 't3', created_ms: 300, status_ms: 500 },
  // Shown by its label only: not yet in the layout.
  { address: 't9', created_ms: 50, labels: { 'herdr.space': 'spNew' } },
];

test('rankSpaces: the space whose terminals were used last comes first; empty spaces last, the newer first', () => {
  const got = rankSpaces(DOC.spaces, TERMINALS);
  assert.deepEqual(got.map((s) => s.id), ['spOld', 'spNew', 'spEmpty']);
  assert.deepEqual(got[0], { id: 'spOld', folder: '/code/shop', name: 'shop', usedMs: 900 });
  assert.equal(got[1].usedMs, 500);
  assert.deepEqual(rankSpaces([{ id: 'a' }, { id: 'b' }]).map((s) => s.id), ['b', 'a']);
  assert.deepEqual(rankSpaces(null), []);
});

test('appSpaces reads the Herdr app document with one hc connect, and never writes it', async () => {
  const run = fakeRun([['hc connect', (cmd, args, opts) => {
    const asked = opts.input.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(asked.map((m) => m.method), ['hello', 'doc.get', 'terminal.list']);
    assert.deepEqual(asked[1].params, { name: 'herdr-app' });
    return {
      stdout: [
        { id: 1, jsonrpc: '2.0', result: { generation: 1 } },
        { id: 2, jsonrpc: '2.0', result: { value: DOC, version: 7 } },
        { id: 3, jsonrpc: '2.0', result: { terminals: TERMINALS } },
      ].map((m) => JSON.stringify(m)).join('\n'),
    };
  }]]);
  const got = await appSpaces({ run, hc: 'hc' });
  assert.deepEqual(got.map((s) => s.folder), ['/code/shop', '/code/blog', '/code/api']);
  assert.equal(run.calls.length, 1);
  assert.ok(!run.calls[0].opts.input.includes('doc.set'));
});

test('appSpaces is empty without herdr-core, when it fails, or before the app wrote its document', async () => {
  assert.deepEqual(await appSpaces({ run: fakeRun([]), hc: null }), []);
  assert.deepEqual(await appSpaces({ run: fakeRun([]), hc: 'hc' }), []);
  assert.deepEqual(await appSpaces({ run: fakeRun([['hc connect', { code: 1, stderr: 'no core' }]]), hc: 'hc' }), []);
  const never = fakeRun([['hc connect', { stdout: `${JSON.stringify({ id: 2, result: { value: null, version: 0 } })}\nnot json` }]]);
  assert.deepEqual(await appSpaces({ run: never, hc: 'hc' }), []);
});
