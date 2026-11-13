// Which folder the foreman prompt works in, and what the tab it opens runs.
// Plain functions of what the app reports, so they are tested under node
// (test/app-folder.test.js); "foreman setup" copies this file beside main.js.

// The prompt hook herdr-core puts into a PowerShell it starts as a plain shell.
// Herdr reads a terminal's live folder from the shell's working directory, which
// cd (Set-Location) leaves alone; on every prompt this moves it to where
// PowerShell is. A tab started with argv gets no hook, so foreman adds it. Its
// own variable and the guard keep it to one wrap per shell (herdr's text run
// twice would make prompt call itself); `foreman shell-hook on` puts the same
// lines in the PowerShell profile.
export const PROMPT_HOOK = "if (-not $global:__foreman_prompt) { $global:__foreman_prompt = $function:prompt; function global:prompt { $l = $ExecutionContext.SessionState.Path.CurrentLocation; if ($l.Provider.Name -eq 'FileSystem') { try { [Environment]::CurrentDirectory = $l.ProviderPath } catch {} }; & $global:__foreman_prompt } }";

// The terminal the prompt was opened from (origin: what focused() said then):
// its pane's live folder, else the folder focus reported, else where its space
// starts new terminals (space.folder). `from` says which one it is.
export function chooseFolder({ origin, panes = [], spaces = [] }) {
  const pane = origin?.pane ? panes.find((p) => p.pane === origin.pane) : null;
  if (pane?.cwd) return { folder: pane.cwd, from: "pane" };
  if (origin?.cwd) return { folder: origin.cwd, from: "focused" };
  const space = spaces.find((s) => s.id === origin?.space) ?? spaces.find((s) => s.active);
  return space?.folder ? { folder: space.folder, from: "space" } : { folder: null, from: null };
}

// The same folder, written with other slashes, letter case (Windows) or a trailing slash.
const key = (p) => String(p ?? "").replace(/\\/g, "/").replace(/(.)\/+$/, "$1").toLowerCase();
export const sameFolder = (a, b) => Boolean(a) && Boolean(b) && key(a) === key(b);

// The folder of the last PowerShell prompt ("PS C:\work>") in a terminal's
// screen text, or null. A shell Herdr cannot follow still prints where it is.
export function promptFolder(screen) {
  const lines = String(screen ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^PS (?:Microsoft\.PowerShell\.Core\\FileSystem::)?([A-Za-z]:\\[^>]*|\\\\[^\\>]+\\[^>]*)>/);
    if (m) return /^[A-Za-z]:\\$/.test(m[1]) ? m[1] : m[1].replace(/\\+$/, "");
  }
  return null;
}

// The live folders of the space's terminals other than `current`, once each:
// what the folder pill offers. Worker worktrees (under `skip`) are left out.
export function folderChoices({ space, panes = [], current = null, skip = null }) {
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const out = [];
  for (const p of panes) {
    if (!tabs.has(p.tab) || !p.cwd) continue;
    if (sameFolder(p.cwd, current) || out.some((f) => sameFolder(f, p.cwd))) continue;
    if (skip && key(p.cwd).startsWith(`${key(skip)}/`)) continue;
    out.push(p.cwd);
  }
  return out;
}

// A PowerShell single-quoted string. PowerShell also ends one at the
// typographic quotes, so those are doubled as well.
export const psQuote = (s) => `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;

// The shell a Windows terminal runs, from its argv[0]: PowerShell 7 or Windows PowerShell.
export const windowsShell = (argv0) => (/(^|[\\/])pwsh(\.exe)?$/i.test(String(argv0 ?? "")) ? "pwsh.exe" : "powershell.exe");

// What the foreman tab runs. Elsewhere: node and foreman with the task. On
// Windows: a PowerShell with the prompt hook that runs foreman and stays open
// (-NoExit), so a cd there later still reaches Herdr. The task goes in taskFile
// (-f, deleted afterwards), never on the command line: Windows PowerShell drops
// the double quotes in what it hands to a program, and a command line has a
// length limit.
export function startArgv({ windows = false, shell = "powershell.exe", nodePath, binPath, flags = [], task, taskFile = null }) {
  if (!windows) return [nodePath, binPath, ...flags, "--", task];
  if (!taskFile) throw new Error("on Windows the task goes in a file");
  const run = `& ${[nodePath, binPath, ...flags, "-f", taskFile].map(psQuote).join(" ")}`;
  return [shell, "-NoExit", "-Command", `${PROMPT_HOOK}; ${run}; Remove-Item -LiteralPath ${psQuote(taskFile)} -ErrorAction SilentlyContinue`];
}
