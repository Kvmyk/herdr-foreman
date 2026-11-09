import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { quietPipes } from '../src/epipe.js';

test('EPIPE on stdout or stderr exits quietly with 0', () => {
  const out = new EventEmitter();
  const err = new EventEmitter();
  const codes = [];
  quietPipes([out, err], (c) => codes.push(c));
  out.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  err.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.deepEqual(codes, [0, 0]);
});

test('other stream errors are not swallowed', () => {
  const out = new EventEmitter();
  quietPipes([out], () => assert.fail('must not exit'));
  assert.throws(() => out.emit('error', Object.assign(new Error('disk'), { code: 'EIO' })), /disk/);
});
