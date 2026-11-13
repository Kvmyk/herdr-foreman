# Reference

The details behind the [README](../README.md): every subcommand, the settings file, what setup changes, token use and how the agent knowledge is kept up to date.

## Subcommands

| Command | What it does |
|---|---|
| `foreman agents [--json] [--quick]` | Installed agent kinds: signed in?, models, default model. `--quick` leaves out each agent's version. The list is kept in `~/.herdr-foreman/agents.json`, so the desktop prompt shows the agents at once |
| `foreman brief [--json]` | Inventory, knowledge, models.dev facts and your stats in one JSON |
| `foreman spawn --task <slug> [--new-tab] [--effort <level>] [--full] [--auto] [--branch <type>/<name>] [--base <branch>] [--include-uncommitted] <name>=<kind>[:<model>]...` | Open workers in worktrees and panes. `--branch` (required on a task's first spawn) names the run, e.g. `feat/auto-accept-workers`; `--base` starts the run from that local branch instead of HEAD (recorded in the run; `land` merges into it; uncommitted changes belong to the checked-out branch, so `--include-uncommitted` only works when the base is the checked-out branch); `--auto` starts workers in their auto-approve mode; `--include-uncommitted` starts workers from a copy that also holds your uncommitted changes. `--effort low\|medium\|high\|xhigh\|max` (claude, agy); `--full` keeps MCP servers and all tools for claude workers |
| `foreman wait --task <slug> [--phase investigate\|implement] [--only a,b] [--timeout ms]` | Block until every worker finished (its report written) or one needs attention; returns within 9 minutes |
| `foreman status --task <slug> [--json]` | Changes, commits and reports per worker |
| `foreman watch --task <slug> [--interval seconds]` | `status`, refreshed until you press Ctrl+C |
| `foreman merge --task <slug> [--only a,b] [--json]` | Collect committed work on the run branch |
| `foreman land --task <slug> [--title <summary>]` | Merge the run branch into your current branch as `Merge <type>/<name>: <summary>` (refuses with uncommitted changes). When the run has a `--base` branch that is not checked out, `land` updates that branch in a temporary worktree and leaves your checkout alone; it refuses on a conflict and changes nothing |
| `foreman cleanup --task <slug> [--delete-branch]` | Close worker panes, remove worktrees and worker branches |
| `foreman cleanup [--all]` | List runs left behind (open workers, worktrees); `--all` cleans them. Panes are closed only if they still host that worker or work inside its worktree |
| `foreman prompt --task <slug> <name> "<text>"` | Send an agent a message |
| `foreman read --task <slug> <name> [--lines n]` | Print what an agent's pane shows (`n` lines of history too) |
| `foreman keys --task <slug> <name> <key>...` | Press keys in an agent's pane: `enter`, `esc`, `up`, `down`, `1`, ... `prompt`, `read` and `keys` also take `--backend app\|herdr` |
| `foreman close-leader` | Close the calling leader's pane; the leader's last step when you agree |
| `foreman journal add <file.json>` / `foreman journal stats` | Record and view results per category and agent |
| `foreman knowledge show\|refresh\|stale [--json]` | What foreman knows about agents: where it came from, its date, stale model families; `refresh` fetches it now |
| `foreman knowledge validate <file>` | Check a knowledge file; exits 1 when it is invalid |
| `foreman runs [--json]` | Earlier and current runs: phase, branch, workers, estimated cost |
| `foreman show --task <slug> [--json]` | One run: the task, workers, reports, tokens and estimated cost (claude and codex logs) |
| `foreman diff --task <slug> [--stat] [<worker>]` | What the run, or one worker, changed against its base; check it before `land` |
| `foreman resume --task <slug>` | Start a new leader that continues an interrupted run from its record and reports |
| `foreman respawn --task <slug> <name>[=<kind>[:<model>]]` | Restart a worker that stopped, in its existing worktree, optionally with another agent |
| `foreman new` | Open the task prompt in this terminal; plain `foreman` does the same once setup has run |
| `foreman launcher [--ensure] [--json]` | A terminal that stays open and takes one task after another, for the Herdr phone app; `--ensure` opens one when `config.json` has `"launcher": true`, in the Herdr app space used last |
| `foreman launcher on\|off [--json]` | Turn the launcher on (saved as `"launcher": true` in `config.json`, and opened now) or off (saved as `false`; the launcher terminal foreman opened is closed) |
| `foreman shell-hook [on\|off] [--json]` | Windows: whether your PowerShell profile tells the Herdr app about `cd`; `on` adds a marked block (the old profile is saved as `profile.ps1.foreman-backup`), `off` removes it. Never added by setup on its own. See [Windows and PowerShell](windows.md#the-desktop-prompt-shows-an-old-folder-after-cd) |
| `foreman config [--json]` / `foreman --version` | The settings in use with their defaults and file paths; the installed version |

A task that starts with a subcommand name still starts a leader (`foreman status page is broken` is a task). `foreman -- <words>` forces it.

## Files

Everything lives in `~/.herdr-foreman/` (set `FOREMAN_HOME` to move it):

| Path | Contents |
|---|---|
| `config.json` | Optional: `leader`, `maxWorkers` (default 6), `startTimeoutMs`, `waitTimeoutMs` (default 540000; use 240000 with an API key, whose cache lasts 5 minutes), `lean` (default true), `leaderArgs` (extra leader flags, e.g. `["--effort", "high"]`), `knowledgeUrl` (default: `knowledge/agents.json` on GitHub; `false` turns it off), `excludeKinds`, `autoSetup` (default true; false stops foreman adding or restoring its herdr and Herdr app shortcuts), `worktreeSetup` (a command run in each new worker worktree, e.g. `"npm ci"`), `copyFiles` (globs of untracked files such as `.env*` copied into each worktree), `notifyCommand` (off by default: an argv array run, without a shell, when `foreman wait` returns attention or done, with `{title}` and `{body}` filled in; failures are ignored; e.g. `["curl", "-s", "-H", "Title: {title}", "-d", "{body}", "https://ntfy.sh/my-topic"]`), `launcher` (default false; true keeps a terminal titled `foreman: new task` for starting tasks from the phone, started by `foreman setup` or `foreman launcher --ensure`; set by the answer to `foreman setup`'s one-time question, by `foreman launcher on|off` or by the desktop prompt's Phone launcher switch), `layout` (`"auto"`, the default, and `"tabs"`, each worker in its own tab, chosen automatically on narrow terminals; also `"stack"`: the leader keeps about 40% on the left and up to 4 workers are stacked on the right, more go to a new tab; `"grid"`: the earlier equal columns of up to 3 workers). A `.foreman.json` at the root of a repository can set `worktreeSetup` and `copyFiles` for that repository; it runs commands, so check it in repositories you did not write |
| `knowledge.override.json` | Optional: your corrections to the knowledge file, deep-merged; families by `id` |
| `knowledge-cache.json`, `models-dev-cache.json` | The knowledge file and models.dev facts, fetched at most once a day |
| `journal.jsonl` | Your results |
| `worktrees/` | Worker worktrees, outside your repository |
| `runs/` | One record per task, plus worker reports |

## Advanced: install as a command, or set up by hand

As a command, for use in any terminal:

```
npm install -g github:Kvmyk/herdr-foreman
```

Then run `foreman "<task>"` in any git repository: outside herdr it starts the herdr server if needed and attaches; inside herdr it opens a new tab. Run `foreman setup` (or just `foreman`) once after the npm install to add foreman to herdr and bind the shortcut. You can also clone the repository and run `npm link` in it; a clone is set up only when you run `foreman setup`. The plugin and the command run the same code. If `foreman` is not on your PATH, the leader is told to run its subcommands as `node /path/to/herdr-foreman/bin/foreman.js`.

What setup changes: it appends this block to herdr's `config.toml` (`herdr --help` prints its path; on Windows it is usually `%APPDATA%\herdr\config.toml`), after checking the result with `herdr config check`, and runs `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+f"
type = "plugin_action"
command = "herdr-foreman.start"
description = "foreman: new task"
```

It never replaces a key you bound yourself to `herdr-foreman.start`. herdr runs the same quiet setup at every server start, so the shortcut comes back after `herdr config reset-keys`; to stop all automatic setup, put `"autoSetup": false` in `~/.herdr-foreman/config.json` or set `FOREMAN_NO_SETUP=1`. If no lead agent is configured and Claude Code is not ready, setup picks one you have and saves it there as `leader`. Without any key binding: `herdr plugin action invoke herdr-foreman.start`.

## Herdr app: prompt details and what setup changes

- **Desktop prompt, below the box:** your last tasks (click one to reuse it) and two options, "Workers answer permission questions automatically" and "Include uncommitted changes". They answer in advance what the leader would otherwise ask you (they pass `--auto-answer` and `--include-uncommitted` to foreman); click anywhere on a row, or press Space or Enter on it, to switch it.
- **Desktop prompt, the two pills at the top:** click `leader` to pick another ready agent for this task, and `branch` to pick the branch the run starts from and lands on. They pass `--leader <kind>` and `--base <branch>`; without a choice foreman uses the `leader` of `config.json` and your current branch.
- **Terminal prompt:** it shows the same four settings in one line. Before you type the task, change them with a command on a line of its own: `/leader <kind>`, `/branch <name>`, `/auto` and `/uncommitted` (the last two switch on and off); the settings line is printed again after each change.
- **Desktop prompt, problems:** if the folder is not a git repository, there is no terminal to take the folder from, or foreman moved, the prompt says so in red and Start stays dimmed. A toast says "Started: ..." when the leader tab opens.

What setup changes, checked first and never forced:

- `mods/foreman/` in the app folder: the prompt. Its `main.js` starts with a `foreman-managed` line holding the version and a hash. The mod is checked with `herdr-app check` before it is written. A newer foreman updates it; a file you edited, or a `mods/foreman` that is not foreman's, is left alone and setup says so.
- one line in `keys.json`, `"ctrl-shift-y": "mod.open:foreman"` (the first of `ctrl-shift-y`, `ctrl-alt-shift-f`, `ctrl-shift-f10` that you have not bound). Your old keys are saved as `keys.json.foreman-backup`, and if the app rejects the new file (`keys.error`) your keys are put back. A missing or invalid `keys.json` is never created or replaced; open the app once and type `foreman setup` again.
- the + menu is not changed: the app replaces its own menus at every start. To use another key, change the line in `keys.json`.

Setup reruns quietly whenever herdr starts. `"autoSetup": false` in `~/.herdr-foreman/config.json` (or `FOREMAN_NO_SETUP=1`) stops that; `foreman setup` still works. To remove foreman from the app, delete `mods/foreman` and that line.

The prompt starts foreman as `node <foreman>/bin/foreman.js --backend app -- "<task>"` in a terminal tab of the app, in the folder of the focused terminal.

## Token use

Every turn an agent takes re-sends its whole conversation, so foreman cuts turns and per-turn context rather than thinking (details and measurements in [research/2026-11-07-tokens.md](research/2026-11-07-tokens.md)):

- **`foreman wait`:** the leader blocks once instead of polling workers; it gets a worker's screen only when that worker asks something.
- **Lean starts:** claude leaders and workers start without MCP servers and unused tools; your own skills (`~/.claude/skills` and plugin skills) and built-in slash commands such as `/usage` keep working. That measured about 23k instead of 44k tokens of context per turn. Use `--full` for a worker that needs them, or set `"lean": false`.
- **Effort per worker:** `--effort low` for mechanical parts, higher only where reasoning pays.
- **Compact data:** `foreman brief` carries only what planning needs (about 9k characters instead of 33k), and `--json` output has no whitespace.
- **Leader instructions:** batched commands, targeted briefs (files and test command) and short reports.

## Keeping the knowledge up to date

- **Weekly refresh on the repository:** the `.github/workflows/refresh-knowledge.yml` workflow runs `scripts/refresh-knowledge.js` once a week, with no LLM and no API key. It reads benchmark leaderboards (`scripts/knowledge-sources/`) into `families[].facts` and `harnesses.<kind>.facts` and generates the `tendencies` text from them; takes each program's newest version from the npm registry (`harnesses.<kind>.release`) and each family's newest model from models.dev (`families[].latest`); checks every source link; and adds model families that models.dev lists but the file does not know with `"auto": true` (no facts, so the leader treats them as unproven). A family's `updated` is the date of its newest fact. A source that has not changed for its `ttlDays`, or that failed two weeks in a row, is frozen: its facts are dropped and `docs/research/knowledge-log.md` says so. `sourceMeta` records each source's licence, ttl, newest record and last check. Every change is checked with `foreman knowledge validate knowledge/agents.json`.
- **Between releases:** `knowledgeUrl` defaults to `https://raw.githubusercontent.com/Kvmyk/herdr-foreman/main/knowledge/agents.json`. Foreman fetches it at most once a day into `~/.herdr-foreman/knowledge-cache.json` and uses it only when it is valid and newer than the copy installed with foreman. Set `"knowledgeUrl": false` to use only the installed copy, or point it at your own file.
- **Your corrections:** `~/.herdr-foreman/knowledge.override.json` is merged on top. Families merge by `id`, so `{"families": [{"id": "grok", "tendencies": ["fine for docs"]}]}` changes one family and keeps the rest; `rules` are added to the existing ones. An override that does not parse or makes the knowledge invalid is ignored with a warning.
- **Checking:** `foreman knowledge show` says where the knowledge came from and how old it is, `foreman knowledge stale` lists families whose newest fact is older than 90 days (or has no date), and `foreman knowledge refresh` fetches the knowledge file and models.dev now. `foreman brief` warns when the knowledge is older than 30 days or has stale families.
