# herdr-foreman

Describe a task in plain words. A lead agent reads the repository, checks which coding agents you have installed and signed in, splits the work, picks the best agent and model for each part, and runs them side by side in [herdr](https://herdr.dev) panes. Workers first only investigate and propose changes; you approve a single numbered list; then they implement in separate git worktrees, and the leader collects, tests and asks before anything lands on your branch.

```
foreman "check the payment module for security holes and fix what needs fixing"
```

Nothing is pushed and no pull request is created.

## Requirements

- Node.js 20 or newer
- herdr 0.9.5 or newer
- git
- at least one coding agent herdr can start (claude, codex, opencode, agy, pi, gemini, ...), signed in

## Install

```
git clone <this repo> herdr-foreman
cd herdr-foreman
npm link
```

`npm link` puts `foreman` on your PATH. Without it, run `node /path/to/herdr-foreman/bin/foreman.js`; the leader is told which form to use.

## How a task runs

1. `foreman "<task>"` in a git repository. Outside herdr it starts the herdr server if needed, opens a workspace and attaches; inside herdr it opens a new tab.
2. The leader (default: `claude`) runs `foreman brief --json`: installed agents, whether they are signed in, their models, what is known about each harness and model family, and your own past results per task category.
3. It shows the plan, then opens workers with `foreman spawn`, each in its own git worktree and pane.
4. Workers investigate without changing anything and write proposals. The leader merges them into one numbered list; you answer, for example, "1 and 3 yes, 2 no".
5. Approved items are implemented and committed in the workers' worktrees. `foreman merge` collects them on `foreman/<task>` in a separate worktree; the leader builds, tests and reviews.
6. You choose: merge into your current branch (`foreman land`), leave the branch for later, or send comments back.
7. `foreman cleanup` closes worker panes and removes worktrees; `foreman journal add` records how each agent did. The leader then asks whether to close its own tab.

Workers write their reports to `.foreman/` inside their own worktree; foreman adds `.foreman/` to the repository's `.git/info/exclude`, so reports never show up in `git status` or a commit.

If a worker asks for permission, the leader asks you once whether you answer such questions yourself or let it answer on your behalf. It never approves a push or a pull request.

## Subcommands

| Command | What it does |
|---|---|
| `foreman agents [--json]` | Installed agent kinds: signed in?, models, default model |
| `foreman brief [--json]` | Inventory, knowledge, models.dev facts and your stats in one JSON |
| `foreman spawn --task <slug> [--new-tab] <name>=<kind>[:<model>]...` | Open workers in worktrees and panes |
| `foreman status --task <slug> [--json]` | Changes, commits and reports per worker |
| `foreman merge --task <slug> [--only a,b] [--json]` | Collect committed work on `foreman/<slug>` |
| `foreman land --task <slug>` | Merge `foreman/<slug>` into your current branch (refuses with uncommitted changes) |
| `foreman cleanup --task <slug> [--delete-branch]` | Close worker panes, remove worktrees and worker branches |
| `foreman cleanup [--all]` | List runs left behind (open workers, worktrees); `--all` cleans them. Panes are closed only if they still host that worker or work inside its worktree |
| `foreman close-leader` | Close the calling leader's pane; the leader's last step when you agree |
| `foreman journal add <file.json>` / `foreman journal stats` | Record and view results per category and agent |

A task that starts with a subcommand name still starts a leader (`foreman status page is broken` is a task). `foreman -- <words>` forces it.

## Choosing agents

Choosing is based on three layers:

1. **What works right now:** every run probes the installed agents, for example `claude auth status`, `agy models`, `opencode models`, `pi --list-models`. An agent that is not signed in is left out, with the reason.
2. **General knowledge:** `knowledge/agents.json` holds harness strengths and model family tendencies, with dates and sources. Model facts (context, price, release date) come from [models.dev](https://models.dev), fetched at most once a day.
3. **Your results:** the journal in `~/.herdr-foreman/journal.jsonl`. Once a category has 5 or more results, they outweigh the general knowledge.

## Files

Everything lives in `~/.herdr-foreman/` (set `FOREMAN_HOME` to move it):

| Path | Contents |
|---|---|
| `config.json` | Optional: `leader`, `maxWorkers` (default 6), `startTimeoutMs`, `knowledgeUrl`, `excludeKinds` |
| `knowledge.override.json` | Optional: your corrections to the knowledge file, deep-merged |
| `journal.jsonl` | Your results |
| `worktrees/` | Worker worktrees, outside your repository |
| `runs/` | One record per task, plus worker reports |

## Development

```
npm test
```

Tests use only Node's built-in test runner; git tests create throwaway repositories in the system temp directory.
