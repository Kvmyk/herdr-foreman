// Shared test doubles. Not a test file itself.

// fakeRun(table): a stand-in for run(). Keys are "cmd arg1 arg2" strings or
// RegExps matched against that line; values are partial results or functions
// returning them. Every call is recorded in fake.calls.
export function fakeRun(table = []) {
  const entries = Array.isArray(table) ? table : Object.entries(table);
  const fake = async (cmd, args = [], opts = {}) => {
    const line = [cmd, ...args].join(' ');
    fake.calls.push({ cmd, args, opts, line });
    for (const [key, value] of entries) {
      const hit = key instanceof RegExp ? key.test(line) : key === line;
      if (!hit) continue;
      const res = typeof value === 'function' ? await value(cmd, args, opts) : value;
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...res };
    }
    const err = new Error(`fakeRun: no entry for "${line}"`);
    err.code = 'ENOENT';
    throw err;
  };
  fake.calls = [];
  return fake;
}

export function json(result) {
  return { stdout: JSON.stringify({ result }) };
}

export function herdrError(code, message) {
  return { code: 1, stdout: JSON.stringify({ error: { code, message } }) };
}
