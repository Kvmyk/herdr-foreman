import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setConfigKey } from '../src/config.js';

function files(initial = {}) {
  const fs = { ...initial };
  return {
    fs,
    file: '/s/config.json',
    readFile: (f) => {
      if (f in fs) return fs[f];
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    writeFile: (f, data) => { fs[f] = data; },
  };
}

test('setConfigKey creates config.json when it is missing or empty', () => {
  const d = files();
  setConfigKey(d, 'launcher', true);
  assert.equal(d.fs['/s/config.json'], '{\n  "launcher": true\n}\n');
  const empty = files({ '/s/config.json': '  \n' });
  setConfigKey(empty, 'launcher', false);
  assert.deepEqual(JSON.parse(empty.fs['/s/config.json']), { launcher: false });
});

test('setConfigKey adds a new key after the last one, keeping the rest of the file as it was', () => {
  const text = '{\n    "leader": "codex",\n    "leaderArgs": ["--effort", "high"],\n    "notifyCommand": null\n}\n';
  const d = files({ '/s/config.json': text });
  setConfigKey(d, 'launcher', true);
  assert.equal(d.fs['/s/config.json'], '{\n    "leader": "codex",\n    "leaderArgs": ["--effort", "high"],\n    "notifyCommand": null,\n    "launcher": true\n}\n');
  const crlf = files({ '/s/config.json': '{\r\n  "leader": "codex"\r\n}' });
  setConfigKey(crlf, 'launcher', false);
  assert.equal(crlf.fs['/s/config.json'], '{\r\n  "leader": "codex",\r\n  "launcher": false\r\n}');
  const bare = files({ '/s/config.json': '{}' });
  setConfigKey(bare, 'launcher', true);
  assert.deepEqual(JSON.parse(bare.fs['/s/config.json']), { launcher: true });
});

test('setConfigKey replaces a value in place and leaves a same-named key inside another object alone', () => {
  const text = '{ "leader": "claude",  "launcher": false, "layout": "tabs" }';
  const d = files({ '/s/config.json': text });
  setConfigKey(d, 'launcher', true);
  assert.equal(d.fs['/s/config.json'], '{ "leader": "claude",  "launcher": true, "layout": "tabs" }');
  const nested = files({ '/s/config.json': '{\n  "x": { "launcher": false },\n  "launcher": false\n}\n' });
  setConfigKey(nested, 'launcher', true);
  assert.deepEqual(JSON.parse(nested.fs['/s/config.json']), { x: { launcher: false }, launcher: true });
});

test('setConfigKey refuses a file that is not a JSON object, and writes nothing', () => {
  for (const text of ['{ "leader": ', '[1, 2]', 'null']) {
    const d = files({ '/s/config.json': text });
    assert.throws(() => setConfigKey(d, 'launcher', true), /config\.json/);
    assert.equal(d.fs['/s/config.json'], text);
  }
});
