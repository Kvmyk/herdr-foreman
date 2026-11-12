import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { editorOpensWindow, readTaskLines, PASTE_ON, PASTE_OFF } from '../src/task.js';

const ESC = '\x1b';
const paste = (text) => `${ESC}[200~${text}${ESC}[201~`;
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// A terminal as readTaskLines sees it: what is written to `stdin` is what the
// person typed or pasted, `clock.t` is the time lines arrive at.
function terminal(opts = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.columns = 40;
  let out = '';
  stdout.on('data', (d) => { out += d; });
  const clock = { t: 1000 };
  const task = readTaskLines(stdin, stdout, { terminal: true, prompt: '> ', now: () => clock.t, burstMs: 50, ...opts });
  const type = async (text, { after = 1000 } = {}) => {
    clock.t += after;
    stdin.write(text);
    await tick();
  };
  return { stdin, task, type, clock, out: () => out };
}

test('a pasted block with a blank line is one task, started by the next Enter', async () => {
  const t = terminal();
  await t.type(paste('fix the login\n\nsee the notes below'));
  await t.type('\r', { after: 200 });
  assert.equal(await t.task, 'fix the login\n\nsee the notes below');
});

test('bracketed paste is switched on while reading and off again afterwards', async () => {
  const t = terminal();
  await t.type('one\r');
  await t.type('\r');
  assert.equal(await t.task, 'one');
  assert.ok(t.out().startsWith(PASTE_ON));
  assert.ok(t.out().includes(PASTE_OFF));
  assert.ok(t.out().lastIndexOf(PASTE_OFF) > t.out().lastIndexOf(PASTE_ON));
});

test('typed lines still end with an empty line, and an empty first line cancels', async () => {
  const t = terminal();
  await t.type('one\r');
  await t.type('two\r');
  await t.type('\r');
  assert.equal(await t.task, 'one\ntwo');
  const none = terminal();
  await none.type('\r');
  assert.equal(await none.task, '');
});

test('lines that arrive within 50 ms are a paste too: the blank line stays, the next Enter starts', async () => {
  const t = terminal();
  // A terminal without paste markers: the text comes at once, the Enter a moment later.
  await t.type('first\n\nthird');
  await t.type('\r', { after: 200 });
  assert.equal(await t.task, 'first\n\nthird');
});

test('one line pasted into an empty prompt starts with one Enter; pasted into typed text it is just text', async () => {
  const whole = terminal();
  await whole.type(paste('fix the login'));
  await whole.type('\r', { after: 200 });
  assert.equal(await whole.task, 'fix the login');
  const part = terminal();
  await part.type('see \r');
  await part.type('and ');
  await part.type(paste('src/login.js'));
  await part.type('\r', { after: 200 });
  await part.type('\r');
  assert.equal(await part.task, 'see\nand src/login.js');
});

test('a setting is a setting when it is pasted too, and does not start anything', async () => {
  const seen = [];
  const t = terminal({ command: async (line) => { if (!line.startsWith('/')) return false; seen.push(line); return true; } });
  await t.type(paste('/auto'));
  await t.type('\r', { after: 200 });
  await t.type('fix it\r');
  await t.type('\r');
  assert.equal(await t.task, 'fix it');
  assert.deepEqual(seen, ['/auto']);
});

test('single: Enter starts a typed line at once, an empty line is ignored, a paste is one task', async () => {
  const typed = terminal({ single: true });
  await typed.type('\r');
  await typed.type('fix the login\r');
  await tick(80);
  assert.equal(await typed.task, 'fix the login');
  const pasted = terminal({ single: true });
  await pasted.type(paste('a\n\nb'));
  await pasted.type('\r', { after: 200 });
  assert.equal(await pasted.task, 'a\n\nb');
  // No paste markers: the first line looks typed, the rest arrives with it.
  const burst = terminal({ single: true });
  await burst.type('a\n\nb');
  await tick(80);
  await burst.type('\r', { after: 200 });
  assert.equal(await burst.task, 'a\n\nb');
});

test('escape: Esc clears what was typed; without it Esc changes nothing', async () => {
  const t = terminal({ single: true, escape: true });
  await t.type('wrong');
  await t.type(ESC);
  await tick(120);
  await t.type('right\r');
  await tick(80);
  assert.equal(await t.task, 'right');
});

test('Ctrl+C cancels, unless interrupt asks to stay', async () => {
  const gone = terminal();
  await gone.type('half a task\r');
  await gone.type('\x03');
  assert.equal(await gone.task, '');
  let presses = 0;
  const stay = terminal({ single: true, interrupt: () => { presses++; return presses < 2; } });
  await stay.type('\x03');
  await stay.type('fix it\r');
  await tick(80);
  assert.equal(await stay.task, 'fix it');
  assert.equal(presses, 1);
});

test('without a terminal nothing changes: a blank line ends the task and no paste mode is touched', async () => {
  const stdin = new PassThrough();
  let out = '';
  const task = readTaskLines(stdin, { write: (s) => { out += s; } }, { prompt: '> ' });
  stdin.write('one\ntwo\n\nnot read\n');
  assert.equal(await task, 'one\ntwo');
  assert.equal(out, '> > ');
});

test('editorOpensWindow: Notepad and VS Code open a window, nano and vim do not', () => {
  assert.equal(editorOpensWindow({}, 'win32'), true);
  assert.equal(editorOpensWindow({}, 'linux'), false);
  assert.equal(editorOpensWindow({ EDITOR: 'code --wait' }, 'linux'), true);
  assert.equal(editorOpensWindow({ VISUAL: '"C:\\Program Files\\Notepad++\\notepad++.exe" -multiInst' }, 'win32'), true);
  assert.equal(editorOpensWindow({ EDITOR: 'vim' }, 'win32'), false);
});
