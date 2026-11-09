import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitForKey } from '../src/pause.js';

test('waits for one key press on a terminal', async () => {
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, readableEnded: false, raw: null, setRawMode(v) { this.raw = v; }, resume() {}, pause() {} });
  let out = '';
  const done = waitForKey({ stdin, stdout: { write: (s) => { out += s; } }, sleep: async () => assert.fail('no sleep') });
  assert.equal(stdin.raw, true);
  stdin.emit('data', Buffer.from('x'));
  await done;
  assert.equal(stdin.raw, false);
  assert.match(out, /Press any key/);
});

test('without a terminal it waits a fixed time instead', async () => {
  const slept = [];
  await waitForKey({ stdin: { isTTY: false }, stdout: { write() {} }, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(slept, [10000]);
});
