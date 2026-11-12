import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { which, run } from '../src/run.js';

test('which finds .cmd shim via PATHEXT on win32', () => {
  const exists = (p) => p === 'C:\\npm\\opencode.CMD';
  const found = which('opencode', {
    platform: 'win32',
    env: { PATH: 'C:\\bin;C:\\npm', PATHEXT: '.EXE;.CMD' },
    exists,
  });
  assert.equal(found, 'C:\\npm\\opencode.CMD');
});

test('which uses the bare name on posix', () => {
  const found = which('claude', {
    platform: 'linux',
    env: { PATH: '/usr/bin:/home/k/.local/bin' },
    exists: (p) => p === '/home/k/.local/bin/claude',
  });
  assert.equal(found, '/home/k/.local/bin/claude');
});

test('which returns null when missing', () => {
  assert.equal(which('nope', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => false }), null);
});

test('which finds a program by listing its PATH folder, ignoring case on Windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-which-'));
  const name = process.platform === 'win32' ? 'Tool.CMD' : 'tool';
  writeFileSync(join(dir, name), '');
  const env = { PATH: [join(dir, 'missing'), dir].join(process.platform === 'win32' ? ';' : ':'), PATHEXT: '.EXE;.CMD' };
  const found = which('tool', { env });
  assert.equal(found?.toLowerCase(), join(dir, process.platform === 'win32' ? 'tool.CMD' : 'tool').toLowerCase());
  assert.equal(which('nothing-here', { env }), null);
});

test('run captures stdout and exit code', async () => {
  const res = await run(process.execPath, ['-e', "console.log('hi'); process.exit(3)"]);
  assert.equal(res.code, 3);
  assert.equal(res.stdout.trim(), 'hi');
  assert.equal(res.timedOut, false);
});

test('run keeps the input open until the answers it waits for have come (a program that stops at the end of its input)', async () => {
  // Answers each line after a while, and stops at once when its input ends.
  const program = "process.stdin.on('data', (d) => setTimeout(() => process.stdout.write('got ' + d), 100)); process.stdin.on('end', () => process.exit(0));";
  const early = await run(process.execPath, ['-e', program], { input: 'one\n' });
  assert.equal(early.stdout, '');
  const res = await run(process.execPath, ['-e', program], { input: 'one\n', inputOpenUntil: (out) => out.includes('got one') });
  assert.equal(res.stdout, 'got one\n');
  assert.equal(res.code, 0);
});

test('run times out', async () => {
  const res = await run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 });
  assert.equal(res.timedOut, true);
  assert.equal(res.code, null);
});

test('run rejects a missing program with ENOENT', async () => {
  await assert.rejects(run('definitely-not-a-program-xyz'), (err) => err.code === 'ENOENT');
});

test('run rejects unsafe arg for cmd shim', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-run-'));
  const shim = join(dir, 'x.cmd');
  writeFileSync(shim, '@echo %*\r\n');
  await assert.rejects(run(shim, ['a&b']), (err) => err.code === 'UNSAFE_ARG');
});

test('run passes simple args through a cmd shim', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-run-'));
  const shim = join(dir, 'echoer.cmd');
  writeFileSync(shim, '@echo %1 %2\r\n');
  const res = await run(shim, ['auth', 'list']);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), 'auth list');
});
