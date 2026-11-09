# Changelog

All notable changes to foreman are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Each release on GitHub uses its section from this file.

## [Unreleased]

### Changed

- The Herdr desktop prompt shows the foreman hat logo in its header instead of the letter f; "foreman setup" installs it as `mods/foreman/logo.svg` next to `main.js`.

## [0.6.0] - 2026-11-09

### Changed

- New default pane layout `stack`: the leader keeps a full-height column of about 40% on the left and the workers are stacked one under another on the right. Up to 4 workers fit beside the leader; more (or `--new-tab`) go to a new tab, stacked as well, in two columns only past 4 workers. The old layout stays available as `"layout": "grid"` in `config.json`.
- The `stack` layout works in the Herdr desktop app too: while its window is open, workers are placed one under another right of the leader (or stacked in their new tab) with equal heights and the leader at about 40%; with the window closed, or `"layout": "grid"`, the app puts them side by side as before.

### Fixed

- Claude Code's folder-trust dialog has "No, exit" preselected, but foreman answered it (and told you to answer it) with Enter, which closed the worker. The answer is now read off the screen: foreman picks the "Yes" option for claude, codex and agy, and answers the dialog while the worker starts instead of waiting 90 seconds.
- `foreman keys <name> down enter` sent the keys so fast that Enter landed on the old option; keys are now pressed one at a time.
- A message sent with `foreman prompt` right after a worker started sometimes stayed typed in its input without being sent; foreman now presses Enter once when the text is still there.
- codex was listed as ready although its sign-in had run out (it then exits with "Your access token could not be refreshed"); the probe now treats a token that expired long ago without a refresh as signed out, and such a start failure carries the hint `run "codex login"`.
- agy workers in auto mode still asked permission for every shell command; they now start with `--dangerously-skip-permissions` instead of `--mode auto` (the README auto-mode note says so).
- A cost that includes a model without a known price (for example claude haiku) showed `~$0.00`; `show`, `runs` and the journal now say "cost unknown" then.
- `foreman runs` printed "1 workers"; it now prints "1 worker".
- `foreman runs` and `foreman show` printed "landed (landed)" or "cleaned (landed)"; the phase is printed once and the outcome only when it adds something, in plain words ("landed, cleaned up").
- `foreman journal stats` with no results now says "no results yet" on a terminal (JSON output stays `{}`).
- `foreman status` counts FILES from the same diff as LINES, so committed work no longer shows 0 files next to changed lines; TIME counts from the worker's start.
- `foreman config` showed `autoSetup true` while `FOREMAN_NO_SETUP=1` was set; it now shows the value in effect and says the environment set it.
- `foreman wait` no longer counts a `proposals.md` or `report.md` left from an earlier round: after `foreman prompt` briefs a worker again, only a report written after that brief makes the worker done.

## [0.5.0] - 2026-11-09

### Added

- Herdr app prompt (Ctrl+Shift+Y), reworked: `Enter` adds a line and `Ctrl+Enter` starts, with the hint "Ctrl+Enter start · Esc cancel"; the folder is shown cut from the left; a draft is kept when you cancel and comes back next time; your last tasks are listed for reuse; `@` offers file names of the project; the configured leader is shown; Start is dimmed while the task is empty or something is wrong.
- Herdr app prompt checks before it starts and says so inline: foreman or node moved ("run foreman setup"), no folder, or the folder is not a git repository. A toast says "Started: ..." or why it could not start.
- Two options in the Herdr app prompt, "Workers answer permission questions automatically" and "Include uncommitted changes", and the matching command line flags `--auto-answer` and `--include-uncommitted` (in front of a task). The leader no longer asks the questions you already answered.
- In the Herdr app, a worker that is stuck (a trust dialog, a question) or has stopped puts its name in its tab's title (`⚠ w2 needs you`) and brings the tab forward.
- Start failures are explained in plain words, and a leader or workers open in a new tab by themselves when there is no room in the current one; hints for trust and permission dialogs say which keys to press.
- `foreman status` and a live watch of a run; `foreman runs` and `foreman show` list and describe earlier runs; `foreman resume` and `foreman respawn` continue a run or restart a worker; `foreman diff` shows what a run or a worker changed; `foreman show` and `foreman runs` give tokens and an estimated cost per worker and run.
- `foreman --version`, `foreman config` (settings in use and file paths), `foreman <command> --help`, "did you mean" for a mistyped command, and usage help for a wrong command or option (what was expected and an example) instead of a bare error.
- New settings in `config.json` or a repository's `.foreman.json`: `worktreeSetup` (a command run in each new worktree, for example an install) and `copyFiles` (ignored files such as `.env` copied into each worktree).
- Output in color on a terminal (plain when piped or with `NO_COLOR`), with aligned tables in `agents`, `status` and `runs`.
- The herdr task prompt (Ctrl+B, then F) is redrawn: a framed header with the folder and branch, key hints, a summary of the task and the `@` files found, and progress with check marks.
- The Herdr app prompt has a new look: folder and branch pills, switches with a short description, recent tasks as chips, key caps for Ctrl+Enter and Esc, and an error banner.
- README: a Quick start with a terminal path and a desktop path at the top, the desktop section next to Install, `npm install -g` plus `foreman setup` as a normal install step, a troubleshooting table, an FAQ (cost, what is changed, what is never done, how to undo), and each prompt tip marked as herdr prompt or desktop prompt. `foreman --help` lists where to start and examples.

### Fixed

- codex failed to start because foreman passed `--no-daemon`, which current codex rejects.
- `foreman` no longer ends with an unhandled EPIPE error when its output is piped into `head` or another program that closes early.
- Many workers in one tab made panes only a few columns wide, so a dialog (for example agy's trust question) could not be read; the layout now keeps the panes wide enough or opens a new tab.

## [0.4.2] - 2026-11-09

### Fixed

- `npm install -g github:Kvmyk/herdr-foreman` no longer fails with "Cannot find module ...\bin\foreman.js". The install script made npm link the global package to a temporary clone that it then deleted. The npm install no longer runs setup, so run `foreman setup` (or `foreman`) once afterwards.

## [0.4.1] - 2026-11-08

### Removed

- The README no longer links to the demo video; the demo GIF stays.

## [0.4.0] - 2026-11-08

### Added

- `CHANGELOG.md` lists the changes in every release.

### Changed

- Claude leaders and workers started by foreman can use your own skills (`~/.claude/skills` and plugin skills); the lean start still leaves out MCP servers. Other agents already load their own skills.

### Removed

- The `media/` folder (logo, banners, videos and the scripts that make them) is no longer in the repository. The README images and the demo video now come from the `assets` branch.

## [0.3.0] - 2026-11-08

### Added

- foreman runs in the Herdr desktop app: press Ctrl+Shift+Y in a terminal of your project, type the task, and the leader opens in a new tab. `foreman setup` adds the prompt and the key to the app.
- `foreman prompt`, `foreman read` and `foreman keys` subcommands and the `--backend` option, so the leader talks to workers the same way in herdr and in the Herdr app.
- README section "Windows and PowerShell": PATH, the "running scripts is disabled" error, quoting tasks, `foreman -f task.md`, Windows paths and `EDITOR='code --wait'`.
- foreman tells you when your task editor closes at once instead of waiting for you.

### Changed

- The README banner is 1280x400 with larger text, so it reads on phones; the banner and the demo GIF scale to the page width.
- All documents in `docs/` are in English. `docs/research/2026-11-07-dobor-agentow.md` is now `2026-11-07-agent-selection.md` and `2026-11-07-tokeny.md` is now `2026-11-07-tokens.md`.

### Fixed

- Lean Claude starts keep built-in slash commands such as `/usage` working.
- The leader gets the `foreman.js` path with forward slashes, which survive bash, cmd and PowerShell.
- The "leader is waiting for an answer" hint is quoted for PowerShell on Windows.

## [0.2.0] - 2026-11-08

First public release.

### Added

- `foreman "<task>"`: a lead agent reads the repository, checks which coding agents are installed and signed in, splits the work, and runs workers side by side in herdr panes, each in its own git worktree.
- Workers first propose changes; you approve one numbered list; then they implement, and the leader collects, tests and asks before anything lands on your branch.
- Subcommands `agents`, `brief`, `spawn`, `wait`, `status`, `merge`, `land`, `cleanup`, `close-leader` and `journal`.
- Agent choice from three layers: what works right now, `knowledge/agents.json` with models.dev facts, and your own results in the journal.
- Auto-accept mode for workers (`--auto`) and a push guard on every worker worktree.
- Workers can start from a copy of your uncommitted changes (`--include-uncommitted`).
- Run branches with Conventional Commits names (`<type>/<name>`) and merge messages.
- Friendlier task input: several lines, an editor, `@file` references, `-f task.md` and stdin.
- herdr plugin with automatic setup on install, on herdr server start and on npm install; `foreman setup` checks herdr, git and agents and binds Ctrl+B, F.
- Lower token use: `foreman wait` instead of polling, lean Claude starts, effort per worker and compact JSON.
- Logo, banners, demo video, GIF and LinkedIn cut, with the scripts that make them.

[Unreleased]: https://github.com/Kvmyk/herdr-foreman/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/Kvmyk/herdr-foreman/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Kvmyk/herdr-foreman/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/Kvmyk/herdr-foreman/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Kvmyk/herdr-foreman/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Kvmyk/herdr-foreman/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Kvmyk/herdr-foreman/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Kvmyk/herdr-foreman/releases/tag/v0.2.0
