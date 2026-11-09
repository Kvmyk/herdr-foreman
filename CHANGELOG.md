# Changelog

All notable changes to foreman are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Each release on GitHub uses its section from this file.

## [Unreleased]

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

[Unreleased]: https://github.com/Kvmyk/herdr-foreman/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/Kvmyk/herdr-foreman/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Kvmyk/herdr-foreman/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Kvmyk/herdr-foreman/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Kvmyk/herdr-foreman/releases/tag/v0.2.0
