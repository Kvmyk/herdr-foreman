# Agent selection: research

As of 2026-11-07. Question: how does the lead know which agent to give which part of the work, so that it still works a year from now, when the models and programs will be different.

## Key findings

1. **The kind of agent is not its capability.** Three things decide the result at once: the program (claude, opencode, pi...), the model it runs, and the access (subscription, API key, limit). The author's `opencode` recently ran GPT-5.3-Codex via Copilot, but also has a local qwen2.5-coder 7B configured; `pi` runs only on a local gpt-oss-20b. The same kind can be strong or very weak depending on the model set.
2. **No model wins at everything.** In CodeRouterBench (~10k tasks, 9 categories), the best in each category was one of five different models. Claude Opus 4.6 had the best average, but e.g. for test generation Qwen3-Max had 82.7% versus Opus's 39.2%. [1]
3. **The program changes the result of the same model by 5–17 points.** GPT-5.5: 83.4% in Codex CLI and 78.2% in Terminus 2 [3]. Claude Opus 4.6: 58.0% in Claude Code and 74.7% in Terminus-KIRA [4]. Rating the model alone is not enough; the pair program + model matters.
4. **Rankings diverge and age quickly.** For SWE-bench Pro, different sites report a different leader in the same month (Claude Opus 5.5 89.9%, Gemini 3 Pro 84.8%, Claude Opus 4.8 69.2%) [5][6][3]. The newest models (Opus 5.5, GPT-6.x, Gemini 4 Argon) have no results on the boards for weeks. A table hard-coded in the code will be wrong after a few weeks.
5. **Lack of data is a bigger problem than the lead's weak reasoning.** A router on Claude Sonnet, given per-category result statistics, improved from 41.4% to 47.7% (+15% relative). Selection that uses memory of earlier results worked best and was the only one that held up well on tasks of a different type than the training ones; fixed classifiers dropped there from 47% to 21%. [1]
6. **For review and security, diversity pays.** Models from different families find partly different flaws; combining several models gave 10–12% better detection than a single model. [7][8] Important: diversity means different model families, not different programs. `claude` and `opencode` with Claude via Copilot are the same model.
7. **Installed is not the same as working.** The author's `gemini` is installed, but has no login and no API key, and free personal access to Gemini CLI ended on 18.06.2026 (its successor is Antigravity CLI, `agy`) [9]. `pi` works only when LM Studio is running.
8. **Limits are a real constraint.** Claude Pro has a 5-hour window and a weekly limit, shared between chat and Claude Code [10]. Copilot counts models with multipliers (Claude Opus 4.6/4.7: 27×, GPT-5.5: 7.5× promotional), and from 1.06.2026 moves to credits [11]. A few workers on one subscription will use it up several times faster.

## Proposed selection mechanism

Three layers of knowledge, from the most stable to the most current. The lead gets all three when planning.

### 1. Inventory: what is available now (checked at every start)

For each kind from the herdr list whose program is on the PATH, the start command collects:

- the program version;
- whether it is logged in or has a key (probe below);
- the available models and the default model;
- whether it asks for permission and what permission modes it has;
- whether the access is local, paid per token, or part of a subscription.

An agent without working access drops out of the pool, and the user gets one sentence saying why. Probes checked locally 2026-11-07:

| Kind | Logged in? | Models |
|---|---|---|
| claude | `claude auth status` (JSON: `loggedIn`, `subscriptionType`) | choice via `--model`; Claude family |
| agy | `agy models` (works only after login) | `agy models` |
| opencode | `opencode auth list` | `opencode models` (format `provider/model`); recently used in `~/.local/state/opencode/model.json` |
| pi | `pi auth check --provider <name>` | `pi --list-models` (shows only models with working access) |
| gemini | no `~/.gemini/oauth_creds.json` and no `GEMINI_API_KEY`/`GOOGLE_API_KEY` variables = no access | — |
| codex | `codex login status` (per docs, not verified, not installed) | `-m <model>` |

For kinds whose probe is not known, the lead treats the agent as an "unknown model" and asks the user or skips it.

### 2. General knowledge: built in, updated, overridable

Two separate parts, because they age at different rates:

- **Program traits** (change rarely): sandbox, permission modes, headless mode, JSON output, whether it asks for permission, the program's own strengths. A file in the plugin, overridden in the user's config.
- **Model traits** (change weekly): context, price, reasoning, release date, pulled automatically from models.dev (`https://models.dev/api.json`, the same catalog opencode uses) [12]. Plus a short, manually maintained list of model family tendencies with a date and source. An entry older than ~90 days is treated by the lead as uncertain.

### 3. Experience: the user's own results journal

This is meant to be the main source of knowledge after a few weeks of use (finding 5). After each task, the lead records for each worker:

- the part category (list below), program, model;
- how many of its proposals the user approved and how many it rejected (a free signal from the approval step);
- whether the changes passed tests and the lead's review on the first try, and how many fixes were needed;
- whether it got stuck (`blocked`, timeout exceeded) and how long it ran.

When planning, the lead gets a summary: for each category, which program + model pair did best. Selection rule: while a category has fewer than ~5 results, general knowledge decides. After that the journal prevails, with a small chance that the lead gives the part to another agent, so new models get a chance to prove themselves.

Part categories (from the uses the author named): app behavior analysis, security audit, testing and bug hunting, bug fix, new feature, refactoring, writing tests, documentation.

### Fixed rules (independent of rankings)

- **Review and security:** the same area goes to two different model families, and the lead merges and filters the findings.
- **Limits as a budget:** expensive models for decisions and hard changes, cheaper and local ones for mechanical work (searching, summarizing files). The lead does not give two workers the same subscription if there is an alternative.
- **Local models:** gpt-oss-20b suits simple tool-using tasks [13]; qwen2.5-coder 7B (57.9% in Aider's edit benchmark, context set to 32K) is practically only good for small things [13].

## Current state: agents on the author's machine (checked 2026-11-07)

| Agent | Version | Access | Models | Permission prompts | Headless mode |
|---|---|---|---|---|---|
| claude | 2.1.286 | claude.ai, Pro plan | Claude family | asks by default; `--permission-mode` (acceptEdits, auto, bypassPermissions, manual, dontAsk, plan), `--dangerously-skip-permissions` | `-p`, `--output-format json`, `--json-schema` |
| agy | 1.1.3 | logged in (Google) | `agy models`: Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking), GPT-OSS 120B; the settings select "Gemini 3.1 Pro (High)", which the list does not show | `--mode accept-edits/auto/plan`, `--dangerously-skip-permissions`; `auto` mode on Windows per guide from v1.4.4 [14] | `-p`, `--output-format json`, `--json-schema` |
| opencode | 1.3.3 | GitHub Copilot (oauth), Google (API), OpenRouter (API), free `opencode/*`, local Ollama | via Copilot, among others Claude Opus 5.5 / Sonnet 5.5 / Fable 5.1, GPT-5.3-Codex, GPT-6.x, Gemini 4 Argon, Grok 4.7, Kimi K3; recently used GPT-5.3-Codex | `opencode run --auto`; per-tool permissions | `opencode run`, `--format json` |
| pi | 1.5.0 | local LM Studio only | gpt-oss-20b (128K) | per pi's descriptions it does not ask for permission by design [15] (to verify) | `-p`, `--mode json/rpc` |
| gemini | 0.11.3 | **none** | — | — | — |

What follows from this for the author today:

- **opencode via Copilot gives the most diversity:** GPT, Gemini, Grok and Claude models in one program. It is a natural second voice for review and security next to `claude`. Keep an eye on Copilot's multipliers.
- **agy** gives a second access to Claude 4.6 and GPT-OSS 120B, outside the Claude Pro limit.
- **pi** suits simple tasks, if LM Studio is running.
- **gemini** must be disabled or given an API key.
- **Folder trust:** `agy` has `C:\Users\Kuba` as a trusted folder. Check whether worktrees in subfolders trigger a trust prompt, separately for `agy` and `claude`.

## Current state: programs and models (snapshot, will go stale)

Terminal-Bench 2.0, terminal tasks, program + model pair [2]: NexAU-AHE + GPT-5.5 84.7%, Codex CLI + GPT-5.5 82.2%, WOZCODE + Claude Opus 4.7 80.2%, TongAgents + Gemini 3.1 Pro 80.2%, Droid + GPT-5.3-Codex 77.3%. 142 entries, median 44%.

Terminal-Bench 2.1 [3]: Codex CLI + GPT-5.5 83.4%, Claude Code + Opus 4.8 78.9%, Terminus 2 + GPT-5.5 78.2%, Gemini CLI + Gemini 3.1 Pro 70.7%. According to this source, Codex CLI uses about 4× fewer tokens than Claude Code on similar tasks.

Practitioner opinions (weak evidence, comparison blogs [16][3]), consistent across sources:

- Claude Code: multi-file changes, refactoring, planning changes across the whole repo.
- Codex: code review, terminal and CI tasks, token savings.
- Gemini: reading very large amounts of code (1M context).
- A pattern repeated in several sources: one agent writes, a second from another family reviews.

## Source quality

- **Solid:** documentation (Gemini CLI, Antigravity, opencode, models.dev), arXiv papers, probes run locally.
- **Medium:** Terminal-Bench leaderboards (results submitted by the program authors).
- **Weak:** benchmark aggregators and comparison blogs. Aggregators give contradictory numbers, and blogs contain obvious errors (e.g. GPT-5.5 attributed to Anthropic). Only tendencies that agree across several sources are taken from them.

## Proposals for the spec

1. Agent detection returns triples: program + model + access. An agent without working access drops out of the pool with a one-sentence explanation.
2. General knowledge in two parts: program traits (a file in the plugin) and model traits (models.dev + a short list of tendencies with dates). Both overridable in config.
3. A results journal kept locally by the user, and per-category statistics given to the lead when planning. Main signal: the user's approvals of proposals, plus the lead's tests and review.
4. For review and security: two different model families on the same area.
5. Subscription limits as a budget when assigning work.

## Sources

1. Agent-as-a-Router: Agentic Model Routing for Coding Tasks, arXiv 2606.22902: https://arxiv.org/html/2606.22902v1
2. Terminal-Bench 2.0 leaderboard (Snorkel): https://snorkel.ai/leaderboard/terminal-bench-2-0/
3. Terminal-Bench 2.1, June 2026, updated 2026-11-07: https://codex.danielvaughan.com/2026/06/11/terminal-bench-2-1-june-2026-benchmark-landscape-codex-cli-harness-engineering-model-scores/
4. The Harness Effect: https://codex.danielvaughan.com/2026/04/19/the-harness-effect-same-model-different-tool-different-score/
5. BenchLM, SWE-bench Pro: https://benchlm.ai/benchmarks/swe-bench-pro
6. SWE-bench Pro (aggregator): https://anotherwrapper.com/tools/llm-pricing/evals/swe-bench-pro
7. Diverse LLMs vs. Vulnerabilities: https://dl.acm.org/doi/pdf/10.1145/3786181.3788719
8. Ensembling Large Language Models for Code Vulnerability, arXiv 2509.12629: https://arxiv.org/pdf/2509.12629
9. Transitioning Gemini CLI to Antigravity CLI: https://github.com/google-gemini/gemini-cli/discussions/27274
10. Claude Code limits: https://www.morphllm.com/claude-code-usage-limits
11. Model multipliers in Copilot: https://docs.github.com/en/copilot/reference/copilot-billing/model-multipliers-for-annual-plans
12. models.dev: https://models.dev/api.json
13. Local models for code: https://ianlpaterson.com/ai/best-local-llm/
14. Antigravity CLI, modes and permissions: https://www.aibuilderclub.com/blog/antigravity-cli-guide ; headless mode: https://antigravity.google/docs/cli/headless/
15. pi.dev, overview: https://urandom.io/blog/2026-03-07-pi-dev-deep-dive
16. Codex vs Claude Code vs Gemini CLI (Tembo, July 2026): https://www.tembo.io/blog/codex-vs-claude-code-vs-gemini-cli
17. Triage: routing tasks to model tiers, arXiv 2604.07494: https://arxiv.org/pdf/2604.07494
18. opencode CLI: https://opencode.ai/docs/cli
