import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foremanCommand } from '../src/deps.js';

test('the leader runs foreman by name when it is on PATH', () => {
  assert.equal(foremanCommand(true, 'C:\\x\\bin\\foreman.js'), 'foreman');
});

test('otherwise through node, with forward slashes in a Windows path', () => {
  assert.equal(foremanCommand(false, 'C:\\Users\\me\\herdr-foreman\\bin\\foreman.js'), 'node "C:/Users/me/herdr-foreman/bin/foreman.js"');
  assert.equal(foremanCommand(false, '/opt/herdr-foreman/bin/foreman.js'), 'node "/opt/herdr-foreman/bin/foreman.js"');
});
