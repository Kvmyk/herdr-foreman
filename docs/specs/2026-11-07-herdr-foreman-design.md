# herdr-foreman: specification

Status as of 2026-11-07, second session. The workflow, permissions, result of the work, and agent selection were agreed with the author. The technical decisions (section "Technical decisions") are proposals by Claude, accepted through the instruction "start the implementation", without a separate discussion. The name is a working name.

## Why

Splitting work between several agents in herdr is manual today: you have to come up with the split yourself, open panels, pick agents, send tasks out, and then collect everything. Goal: you type a task in the terminal in plain words, and a leader agent does the rest. First for the author's own use, then publication on GitHub (the herdr plugin marketplace, the awesome-herdr list).

Main use: **developing and maintaining software**. Typical tasks (from the author): testing the application (checking and looking for bugs), checking for security holes, building software, analysing how the application behaves.

## Goals, non-goals, anti-goals

- **Goals:** one command in the terminal; the leader picks the number and kind of agents itself from those installed and running; selection by strengths, which learns over time and does not go stale; it is always visible what will change before anyone touches the code; everything stays local.
- **Non-goals (for now):** push, PR, cloud work, automatic approval of PRs with knowledge updates (later), control from a phone.
- **Anti-goals:** workers changing code without the user's consent; quietly using up subscription limits; a table of strengths that is out of date after a month; requiring manual setup of every agent before the first use.

## Workflow (agreed)

1. In the repo directory, in a normal terminal: `foreman "check the security of the payment module and fix what needs fixing"`. The command also works from a herdr panel. From a normal terminal it starts the herdr server itself if it is not running, creates a workspace with this directory, starts the leader, and opens herdr. From a herdr panel it starts the leader in a new tab of the current workspace.
2. The leader reads the repo and checks which agents are installed, logged in, and on which models they run (inventory, below).
3. The leader splits the task into parts, decides the number of workers, and picks an agent for each part. The plan is shown for information only, without waiting for consent, because this stage changes nothing in the code. This is a proposal by Claude: the first session's draft assumed consent at the start.
4. Each worker examines its part **without changing anything** and returns a short list to the leader: what is wrong, where, and what it wants to change. For new features, it is a description of how it would build its part.
5. The leader removes duplicates and shows the user one numbered list with the weight and the author:
   ```
   1. [high] api/auth.ts: token never expires -> add exp and check it   (claude1)
   2. [medium] /login has no rate limit -> add one                      (gemini1)
   ```
   The user answers, for example, "1 and 3 yes, 2 no". **Only the leader gives orders to workers.**
6. The leader orders the approved changes, by default to the worker that found the problem (it has the context). Each worker that changes code works in a separate git worktree on a local branch.
7. The leader collects the changes into one local branch `foreman/<short-task-name>`, checks that the project builds and the tests pass, and reviews the result.
8. The leader shows a summary (what changed, in which files, test result) and asks whether everything is in order. The user chooses:
   - `scal` (merge): the leader merges the branch into the current one; if there are uncommitted changes, it asks first;
   - `zostaw` (leave): the branch stays, the leader gives the command to merge it and cleans up the worktrees;
   - comments in the user's own words: the leader orders fixes and comes back with the same question.
9. Nothing leaves the computer: no push and no PR.

## Workers' questions about consent (agreed)

If a worker stops at a consent question (state `blocked`), the leader asks the user whether they will answer themselves or whether the leader should accept for them. If the leader, it accepts on the user's responsibility.

Proposals by Claude:

- The leader asks once, at the first such question, and the choice applies until the end of the task.
- If the user answers themselves, the leader says which panel is waiting and what it asks.
- Even when the leader accepts, it always refuses push and PR, and it asks the user about things clearly outside the task (deleting files outside the worktree, global package installation).
- The answer is sent with `herdr agent read` (reading the screen) and `herdr agent send-keys`.

## Agent selection (agreed, details in the research)

Research: `docs/research/2026-11-07-agent-selection.md`. The most important points: the result is decided by the triple program + model + access, not by the kind of agent alone. No model wins at everything. Rankings go stale. Selection works best with memory of earlier results.

Three layers of knowledge the leader gets when planning:

1. **Inventory** (at every start): for each kind from the herdr list whose program is on the PATH, the version, login state, available models and default model, permission modes, and access type (local, subscription, API) are collected. An agent without working access drops out of the pool, and the user gets one sentence explaining why.
2. **General knowledge:** strengths of the programs (a file in the plugin) and characteristics of the models (models.dev automatically, plus a short list of model family tendencies with a date and a source). Everything can be overridden in the user's configuration. The leader treats an entry older than about 90 days as uncertain.
3. **Results journal** kept by the user. After each task, the leader records for each worker the part category, program, model, approved and rejected proposals, the test and review result, the number of fixes, and whether it got stuck. When planning, the leader gets statistics per category. While a category has fewer than about 5 results, general knowledge decides; after that the journal prevails, with a small chance of trying another agent.

Part categories: behaviour analysis, security audit, testing and bug hunting, bug fix, new feature, refactoring, test writing, documentation.

Fixed rules:

- For review and security, the same area gets two different model families (different programs with the same model do not count).
- Subscription limits are treated as a budget.
- Local models get only simple tasks.

## Keeping knowledge current (agreed: route A)

Once a week a scheduled agent (a cloud routine or a GitHub Action in the plugin repo):

1. fetches data from models.dev and current rankings;
2. researches new models and looks for new sources, because old ones die (the Aider ranking has been frozen since 2025-10, and the existing Artificial Analysis API returns 410);
3. updates the knowledge file with sources and dates;
4. opens a PR.

The author approves the PR; later this can be automated. At start, foreman fetches the current knowledge file from the repo, at most once a day, with a local copy in case there is no network. A model nobody knows anything about gets the mark "new, unverified" and smaller parts of work at first.

## Technical decisions (proposals by Claude)

- **Architecture C (hybrid):** the program provides the mechanics as commands, and the model-leader makes the decisions and calls these commands.
  - Mechanics: inventory, panels and worktrees, starting and waiting for workers, collecting results, the journal.
  - Decisions: split, assignment, combining lists, review, merging.
  - Reasoning: the workflow has steps that need judgement (splitting, reviewing, answering consent questions) and mechanical steps that must be repeatable and testable.
- **Language: Node.js ≥ 20, plain JavaScript (ESM), no dependencies and no build step.**
  - Works the same on Windows, macOS and Linux, and the author works on Windows.
  - Node is almost always present for agent users, because most of them install through npm.
  - Tests on `node:test`.
  - The panel layout logic is moved from `C:\Users\Kuba\.claude\skills\agenci\agenci.ps1`.
- **Default leader:** `claude`, changeable in the configuration.
- **The leader only coordinates** and does not do part of the work. This is a proposal: it follows from the rule "the leader writes down, others carry out".
- **Instructions for the leader** are a Markdown file in the plugin, handed to the leader at start. They do not depend on the skills mechanism of a particular agent, so they work for every kind of leader.
- **State and journal:** the `~/.herdr-foreman/` directory (configuration, JSONL journal, copy of the knowledge file).
- **herdr plugin** (added 2026-11-07): `herdr-plugin.toml` in the repo root, the action `herdr-foreman.start` (the user binds it to a key, for example `prefix+f`) opens the overlay `ask` with a question about the task; the leader starts in a new tab of the same workspace. The `foreman` command keeps working on its own; both entry points use the same code.
- **Workers start right away in their own worktrees,** also in the research stage. The ban on changes in that stage comes from the instructions, and the leader checks it after the research stage (clean worktree, zero commits). A worker fixing a problem then keeps its context, and the folder trust prompt appears only once.
- **Locations:**
  - worktrees outside the repo: `~/.herdr-foreman/worktrees/<repo>-<hash>/<task>/<worker>`, branches `foreman-work/<task>/<worker>` (git does not allow `foreman/<task>` and `foreman/<task>/<worker>` to exist at the same time);
  - changes are collected in a separate `_merge` worktree on the branch `foreman/<task>`, so the branch and the user's directory stay untouched until `scal`;
  - worker reports in `<worktree>/.foreman/`, and `.foreman/` is added to the repository's `.git/info/exclude`. The reports were first kept in `~/.herdr-foreman/runs/`, but in a live test agy asked for consent on every write outside its own folder.
- **CLI output in English** (for publication). The leader talks to the user in the language of the task.
- **Implementation plan:** `docs/plans/2026-11-07-foreman-mvp.md`.
- **Start safeguards** (they came up during the build): foreman refuses when the repository is the home directory (the author's `C:\Users\Kuba` is a git repo with no commits), and when the repo has no commits yet.
- **Cleanup on Windows:** after panels are closed, the agent process keeps the folder for a few seconds, so `cleanup` waits, retries, and as a last resort deletes the folder and runs `git worktree prune`.
- **Claude Code trust prompt** has "No, exit" selected by default; the leader chooses "Yes" with the keys `down`, `enter`.
- **End of work** (agreed with the author after a live test):
  - `foreman cleanup` closes the workers in the leader's last step, also when the work is interrupted;
  - at the end the leader asks whether to close its tab, and with consent it calls `foreman close-leader`;
  - `foreman cleanup` without `--task` shows abandoned tasks, and `--all` cleans them up;
  - a panel from the saved record is closed only if this worker or a process in its worktree is still in it, because after a herdr restart the panel numbers start again.
- **Saving tokens** (a request by the author after a trial; research and measurements in `docs/research/2026-11-07-tokens.md`): the cost is the number of turns times the context per turn. Implemented:
  - `foreman wait` instead of the leader polling the workers;
  - a slimmed-down Claude Code start (without MCP, skills, and unneeded tools; `--full` and `"lean": false` turn this off);
  - `--effort` with `spawn`;
  - a concise `brief` and JSON;
  - leader instructions aimed at fewer turns (combining commands, precise briefs, short reports).
- **herdr after the last panel is closed** (checked in a separate session on 2026-11-07): the tab and the workspace disappear, the server keeps running with zero workspaces, and new ones can be created. Not checked: the behaviour of a window (client) attached to a session where the last workspace disappears.

## What already exists (review of 2026-11-07)

herdr 0.9.5 (the latest, 2026-10-14) has no built-in orchestration, only building blocks (panels, `agent start/prompt/wait/read/send-keys`). More than 2000 repositories are tagged `herdr-plugin`, including several dozen orchestrators. The closest to the idea:

| Project | What it has | What is missing compared to foreman |
|---|---|---|
| [herdr-hive](https://github.com/pparitoshh/herdr-hive) (0★, since 2026-11-06) | a leader and N workers in worktrees, message bus, local router choosing a difficulty level (fast/regular/think), decision journal, review screen, merge/fix/reject | the user sets the programs and models for the levels; no access and model detection, no strengths per category, no knowledge updates, no "proposals and consent" workflow; Python and a Unix socket |
| [AgentCompass](https://github.com/akiiwa-games/AgentCompass) (4★, since 2026-10-27) | model × effort selection by strengths and current 5h/7d limits, detection of logged-in accounts, public data from the repo every 6 h (calibrated with LMArena, vals.ai, Artificial Analysis), Windows | it is a router called by another session, with no run in herdr panels (plan, proposals, consent, merging); very large (pool, services), one author |
| [ralfkuh-lab/herdr-orchestrator](https://github.com/ralfkuh-lab/herdr-orchestrator) | a skill: delegating to 9 kinds of agents in visible panels, answering consent questions based on the option text, reading limits | the user describes agent selection in `policy.md` |
| [oldwinter/herdr-orchestrator](https://github.com/oldwinter/herdr-orchestrator) | a catalogue of programs with strengths / best_for / avoid_for fields, deterministic coordinator with a queue | static, manual catalogue |
| [squad-devkit](https://github.com/bthanhtung/squad-devkit) | a leader and workers in worktrees, detects installed engines | worker selection without strengths per category |
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (70k★) | task categories assigned to models, maintained by its authors | its own program (omo), not orchestration in herdr |

The distinguishing feature of foreman is a combination that nobody has as a whole: one command; detection of program, model, and access; the number of agents depends on the task; selection by strengths, learning from the user's results, and weekly knowledge updates; a "proposals, consent, fixes" workflow. Risk: the market is crowded and fast, and AgentCompass or herdr-hive may add the missing parts.

Older projects from the first review: crew, herdr-claude-teams, herdr-swarm, herdr-fleet, herdr-orchestra, oh-my-herdr (fixed roles or selection by the user).

## Facts about herdr (checked on v0.9.5)

- A plugin is a TOML manifest plus any program. It has actions under keys (`[[keys.command]]` with `plugin_action`), panels `overlay`, `popup`, `split`, `tab`, `zoomed`, and hooks. It receives `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`, `HERDR_PLUGIN_CONTEXT_JSON`. Installation: `herdr plugin install owner/repo[/subdir]`, locally `herdr plugin link <path>`. The marketplace indexes public repos with the tag `herdr-plugin`. Documentation: https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/plugins.mdx
- On Windows, commands from `[[keys.command]]` go through `cmd.exe /d /c`.
- Checked while building the plugin: `HERDR_PLUGIN_CONTEXT_JSON` has `focused_pane_cwd` and `workspace_cwd`, also in a panel opened from an action; a plugin panel gets a terminal (TTY), an action does not. An overlay (`overlay`) always opens over the active panel: `--target-pane` gives an `invalid_params` error. CLI 0.9.5 does not yet know `popup` in `plugin pane open`. A tab created from an overlay with `--focus` stays active after the overlay is closed. Plugin commands inherit `HERDR_SESSION` and `HERDR_SOCKET_PATH`, so `herdr` called from them reaches the right session.
- `herdr agent start <name> --kind <kind> --pane <id> [--timeout MS] [-- <agent arguments>]` requires a panel with a shell at the prompt and returns when the agent is ready, or with `agent_not_ready`. Names: `[a-z][a-z0-9_-]{0,31}`.
- `herdr agent prompt <target> "<text>" --wait`, `herdr agent wait`, `herdr agent read --source recent-unwrapped --lines N`, `herdr agent send-keys`, states `idle`, `working`, `blocked`, `done`, `unknown`.
- Agent kinds: pi, claude, codex, gemini, cursor, devin, agy, cline, omp, mastracode, opencode, copilot, kimi, kiro, droid, amp, grok, hermes, kilo, qodercli, qwen, letta, maki, muse.
- `herdr pane split --pane <id> --direction right|down --ratio <r> --cwd <path> --no-focus`; `ratio` is the part that stays in the split panel.
- `herdr worktree create` creates a separate workspace for each worktree. To have workers next to each other, foreman runs `git worktree add` itself and opens panels with `--cwd`.
- An agent in a herdr panel has `HERDR_ENV=1`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`.
- Claude Code shows the trust prompt in every new worktree (confirmed by herdr-hive). `agy` has a `trustedWorkspaces` list in `~/.gemini/antigravity-cli/settings.json`.

## Left to the implementer

- Maximum number of workers (proposal: 6, in the configuration) and the worker time limit.
- The format of the proposal list that workers return to the leader (proposal: a JSON or Markdown file in `.foreman/` in the worktree, so the leader does not have to read the screen).
- Exact probes for kinds the author does not have (codex, copilot, cursor, kimi, and others); an unknown kind is treated as "unknown model".
- Final name.
