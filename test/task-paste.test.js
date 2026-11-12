import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createTaskReader, editorOpensWindow, readTaskLines, PASTE_ON, PASTE_OFF } from '../src/task.js';

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

// ---- one reader for task after task (the launcher) ----

function reading(opts = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.columns = 40;
  let out = '';
  stdout.on('data', (d) => { out += d; });
  const reader = createTaskReader(stdin, stdout, { terminal: true, prompt: '> ', single: true, burstMs: 20, ...opts });
  return { stdin, reader, out: () => out };
}

test('createTaskReader gives task after task, and what was sent early waits for its turn', async () => {
  const r = reading();
  // Two sends that arrive while nobody is asking, as when the launcher is busy.
  r.stdin.write(`${paste('first task\n\nwith a blank line')}\r${paste('2')}\r`);
  await tick(120);
  assert.equal(await r.reader.next(), 'first task\n\nwith a blank line');
  assert.equal(await r.reader.next(), '2');
  // Then one that is typed while it waits.
  const third = r.reader.next();
  r.stdin.write('third\r');
  assert.equal(await third, 'third');
  assert.equal(r.reader.ended, false);
  // Paste mode goes on once and off once, however many tasks were read.
  r.reader.close();
  assert.equal(r.out().split(PASTE_ON).length - 1, 1);
  assert.equal(r.out().split(PASTE_OFF).length - 1, 1);
  assert.equal(await r.reader.next(), '');
});

test('createTaskReader: the end of the input ends the reading; an input that ended before is no input', async () => {
  const r = reading();
  const pending = r.reader.next();
  r.stdin.end();
  assert.equal(await pending, '');
  assert.equal(r.reader.ended, true);
  assert.equal(await r.reader.next(), '');
  const dead = new PassThrough();
  dead.destroy();
  const none = createTaskReader(dead, null);
  assert.equal(none.ended, true);
  assert.equal(await none.next(), '');
  none.close();
  assert.equal(await readTaskLines(dead, null), '');
});

test('createTaskReader without a terminal: each line of a single-mode reader is its own task', async () => {
  const stdin = new PassThrough();
  const reader = createTaskReader(stdin, null, { single: true });
  stdin.end('one\n\ntwo\n');
  assert.equal(await reader.next(), 'one');
  assert.equal(await reader.next(), 'two');
  assert.equal(await reader.next(), '');
});

test('show: an echoed line that reads differently is taken back over every row it took and written again', async () => {
  const strip = (line) => line.replace(/^<m>/, '').replace(/<\/m>$/, '');
  const t = terminal({ show: strip, single: true });
  // "> " and 50 characters take two rows of 40 columns.
  const long = `<m>${'x'.repeat(43)}</m>`;
  await t.type(`${long}\r`);
  assert.equal(await t.task, long);
  assert.ok(t.out().includes(`\x1b[2A\r\x1b[J> ${'x'.repeat(43)}\r\n`));
  const same = terminal({ show: strip, single: true });
  await same.type('plain\r');
  assert.equal(await same.task, 'plain');
  assert.ok(!same.out().includes('\x1b[J'));
});

test('show: in a pasted message only the first line had the prompt in front of it', async () => {
  const strip = (line) => line.replace(/^<m>/, '').replace(/<\/m>$/, '');
  const t = terminal({ show: strip });
  await t.type(paste('<m>one\ntwo</m>\n'));
  await t.type('\r', { after: 200 });
  assert.equal(await t.task, '<m>one\ntwo</m>');
  assert.ok(t.out().includes('\x1b[1A\r\x1b[J> one\r\n'));
  assert.ok(t.out().includes('\x1b[1A\r\x1b[Jtwo\r\n'));
});
