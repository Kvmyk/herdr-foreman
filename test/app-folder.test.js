import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './git-repo.js';
import {
  PROMPT_HOOK, chooseFolder, sameFolder, promptFolder, folderChoices, psQuote, windowsShell, startArgv,
} from '../app/foreman/folder.js';

const SPACES = [
  { id: 'sp1', folder: 'C:\\made-here', active: false, tabs: [{ id: 'tb1' }, { id: 'tb2' }] },
  { id: 'sp2', folder: 'C:\\other-space', active: true, tabs: [{ id: 'tb9' }] },
];

test('chooseFolder: the origin pane\'s live folder first, then what focus said, then where the space starts', () => {
  const panes = [
    { pane: 'p1', tab: 'tb1', cwd: 'C:\\first-pane' },
    { pane: 'p2', tab: 'tb2', cwd: 'C:\\work\\now' },
  ];
  const origin = { space: 'sp1', tab: 'tb2', pane: 'p2', terminal: 't2', cwd: 'C:\\work\\then' };
  assert.deepEqual(chooseFolder({ origin, panes, spaces: SPACES }), { folder: 'C:\\work\\now', from: 'pane' });
  // The pane reports no folder (yet): what focused() said when the prompt opened.
  const quiet = panes.map((p) => (p.pane === 'p2' ? { ...p, cwd: null } : p));
  assert.deepEqual(chooseFolder({ origin, panes: quiet, spaces: SPACES }), { folder: 'C:\\work\\then', from: 'focused' });
  // A layout terminal block (no pane) uses focused().cwd as well.
  assert.equal(chooseFolder({ origin: { ...origin, pane: null }, panes, spaces: SPACES }).folder, 'C:\\work\\then');
  // Nothing about the terminal: its space's folder, never another pane of the space.
  assert.deepEqual(chooseFolder({ origin: { ...origin, cwd: null }, panes: quiet, spaces: SPACES }), { folder: 'C:\\made-here', from: 'space' });
  // No origin at all: the shown space.
  assert.equal(chooseFolder({ origin: null, panes, spaces: SPACES }).folder, 'C:\\other-space');
  assert.deepEqual(chooseFolder({ origin: null, panes: [], spaces: [] }), { folder: null, from: null });
});

test('sameFolder ignores slashes, letter case and a trailing slash', () => {
  assert.ok(sameFolder('C:\\Work\\App\\', 'c:/work/app'));
  assert.ok(sameFolder('/home/a/', '/home/a'));
  assert.ok(sameFolder('C:\\', 'c:/'));
  assert.ok(!sameFolder('C:\\work\\app', 'C:\\work\\app2'));
  assert.ok(!sameFolder(null, null));
});

test('promptFolder: the folder of the last PowerShell prompt on the screen', () => {
  const screen = [
    'PS C:\\Users\\kuba\\Desktop\\pipe> cd ..',
    'PS C:\\Users\\kuba\\Desktop> cd \'.\\PROJEKTY\\my app\\\'',
    'PS C:\\Users\\kuba\\Desktop\\PROJEKTY\\my app>',
    '',
  ].join('\r\n');
  assert.equal(promptFolder(screen), 'C:\\Users\\kuba\\Desktop\\PROJEKTY\\my app');
  // Something typed after the prompt does not matter.
  assert.equal(promptFolder('PS D:\\code> git status'), 'D:\\code');
  assert.equal(promptFolder('PS C:\\> '), 'C:\\');
  assert.equal(promptFolder('PS Microsoft.PowerShell.Core\\FileSystem::\\\\server\\share\\repo>'), '\\\\server\\share\\repo');
  // Output of a program after the last prompt: still that prompt's folder.
  assert.equal(promptFolder('PS C:\\a> claude\n  Claude Code\n  > what next?\n'), 'C:\\a');
  for (const none of ['', null, 'user@box:~/code$ ', 'PS HKLM:\\Software>', 'not a PS C:\\x> prompt']) assert.equal(promptFolder(none), null, String(none));
});

test('folderChoices: the space\'s live folders, each once, without the current one and worker worktrees', () => {
  const panes = [
    { pane: 'p1', tab: 'tb1', cwd: 'C:\\repo' },
    { pane: 'p2', tab: 'tb1', cwd: 'C:\\other' },
    { pane: 'p3', tab: 'tb2', cwd: 'c:/other/' },
    { pane: 'p4', tab: 'tb2', cwd: 'C:/Users/k/.herdr-foreman/worktrees/repo-1/task/w1' },
    { pane: 'p5', tab: 'tb9', cwd: 'C:\\elsewhere' },
    { pane: 'p6', tab: 'tb2', mod: 'files', cwd: null },
  ];
  assert.deepEqual(folderChoices({ space: SPACES[0], panes, current: 'c:/repo', skip: 'C:/Users/k/.herdr-foreman/worktrees' }), ['C:\\other']);
  assert.deepEqual(folderChoices({ space: null, panes }), []);
});

test('psQuote doubles straight and typographic single quotes, which end a PowerShell string', () => {
  assert.equal(psQuote("it's"), "'it''s'");
  assert.equal(psQuote('badge’s ‘x’'), "'badge’’s ‘‘x’’'");
  assert.equal(psQuote('a "b" $c `d`\nnext'), "'a \"b\" $c `d`\nnext'");
});

test('windowsShell: PowerShell 7 when the terminal runs pwsh, else Windows PowerShell', () => {
  assert.equal(windowsShell('pwsh.exe'), 'pwsh.exe');
  assert.equal(windowsShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'pwsh.exe');
  for (const other of ['powershell.exe', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'claude', undefined]) assert.equal(windowsShell(other), 'powershell.exe');
});

test('startArgv: node and foreman with the task outside Windows', () => {
  const argv = startArgv({ windows: false, nodePath: '/usr/bin/node', binPath: '/f/bin/foreman.js', flags: ['--backend', 'app'], task: 'fix it' });
  assert.deepEqual(argv, ['/usr/bin/node', '/f/bin/foreman.js', '--backend', 'app', '--', 'fix it']);
});

test('startArgv on Windows: PowerShell with the cwd prompt hook, foreman reading the task file, the file removed', () => {
  const task = 'it\'s "quoted"\nline two; & calc';
  const file = "C:/Users/k/.herdr-foreman/prompt-task-1 o'neil.md";
  const argv = startArgv({ windows: true, shell: 'pwsh.exe', nodePath: 'C:/Program Files/nodejs/node.exe', binPath: 'C:/f/bin/foreman.js', flags: ['--backend', 'app', '--leader', "o'x"], task, taskFile: file });
  assert.deepEqual(argv.slice(0, 3), ['pwsh.exe', '-NoExit', '-Command']);
  assert.equal(argv.length, 4);
  const script = argv[3];
  assert.ok(script.startsWith(`${PROMPT_HOOK}; `));
  assert.match(PROMPT_HOOK, /\[Environment\]::CurrentDirectory = \$l\.ProviderPath/);
  assert.ok(script.includes("& 'C:/Program Files/nodejs/node.exe' 'C:/f/bin/foreman.js' '--backend' 'app' '--leader' 'o''x' '-f' 'C:/Users/k/.herdr-foreman/prompt-task-1 o''neil.md'"));
  assert.ok(script.endsWith("; Remove-Item -LiteralPath 'C:/Users/k/.herdr-foreman/prompt-task-1 o''neil.md' -ErrorAction SilentlyContinue"));
  // The task itself is never on the command line.
  assert.ok(!script.includes('quoted') && !script.includes('\n'));
  assert.throws(() => startArgv({ windows: true, nodePath: 'n', binPath: 'b', task }), /file/);
});

const hasPowerShell = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0']).status === 0;

test('PowerShell: the hook moves the working directory on cd, wraps once, and the argv runs foreman with the file', { skip: !hasPowerShell && 'needs Windows PowerShell' }, () => {
  const dir = makeTempDir('foreman-folder-');
  try {
    const inner = path.join(dir, "it's here");
    mkdirSync(inner);
    // Applied twice (Herdr's own shell and the profile): still one wrap, and the prompt still prints.
    const probe = `${PROMPT_HOOK}; ${PROMPT_HOOK}; Set-Location -LiteralPath ${psQuote(inner)}; $p = prompt; [Environment]::CurrentDirectory; $p`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], { cwd: dir, encoding: 'utf8' });
    const [cwd, prompt] = r.stdout.trim().split(/\r?\n/);
    assert.equal(cwd, inner, r.stderr);
    assert.equal(prompt, `PS ${inner}> `.trim());
    assert.equal(promptFolder(prompt), inner);

    const echo = path.join(dir, 'echo.js');
    writeFileSync(echo, 'const fs = require("fs"); const a = process.argv.slice(2); console.log(JSON.stringify({ a, task: fs.readFileSync(a[a.indexOf("-f") + 1], "utf8") }));');
    const task = 'it\'s "quoted" ’curly’ zażółć $env:PATH `tick`\nline two; & calc';
    const file = path.join(dir, "task o'neil.md").replace(/\\/g, '/');
    writeFileSync(file, task);
    const argv = startArgv({ windows: true, nodePath: process.execPath, binPath: echo, flags: ['--backend', 'app'], task, taskFile: file });
    const run = spawnSync(argv[0], ['-NoProfile', '-NonInteractive', ...argv.slice(1).filter((x) => x !== '-NoExit')], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(run.stdout.trim()), { a: ['--backend', 'app', '-f', file], task }, run.stderr);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
