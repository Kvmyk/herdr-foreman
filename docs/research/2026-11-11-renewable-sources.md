# Renewable sources for the knowledge file

As of 2026-11-11. Follows `2026-11-07-agent-selection.md`, whose one-off sources (blogs, aggregators, papers) never change, so the knowledge could not renew itself. Rule from now on: a claim stays in `knowledge/agents.json` only as a dated fact from a source that a maintained organisation keeps updating, that a script can read, and that is free (no key, or a free key). Every candidate below was fetched on 2026-11-11.

## Chosen

| Source | What it gives | Format, terms |
|---|---|---|
| npm registry (`@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli`, `@earendil-works/pi-coding-agent`, `opencode-ai`) | `harnesses.<kind>.release` (version and publish date); `agy` has no package | JSON, no key |
| models.dev `api.json` | `families[].latest`, new-model stubs | JSON, MIT, updated daily |
| OpenRouter `/api/v1/models` | second signal for new and retiring models (not used yet) | JSON, no key |
| LMArena dataset on Hugging Face (`webdev`, `agent`) | preference ranks of current models | JSON via datasets-server, CC-BY-4.0 |
| Terminal-Bench leaderboard (tbench.ai) | harness + model scores | HTML with embedded JSON, Apache-2.0 repository, data licence not stated |
| Epoch AI benchmark data | `deepswe` and model metadata | CSV in a zip, CC-BY-4.0 |
| LiveBench, Vals, Scale SEAL | extra leaderboards (adapters in `scripts/knowledge-sources/`) | see the adapters |
| Vendor documentation (Claude Code, Codex, opencode, Antigravity, Gemini CLI discussion) | `permissions` and the Gemini end-of-access fact; links only, not read by the script | HTML or Markdown |

Facts become frozen, and are dropped, when a source has not changed for more than its `ttlDays` or the source failed twice in a row.

## Rejected

- Aider polyglot leaderboard: fetched, frozen (newest entry 2025-10-03). SWE-bench leaderboards: newest 2026-02-26. SWE-rebench: newest 2026-07-24, 7.8 MB of HTML. Epoch `terminalbench` and `swe_bench_verified`: newest runs in June 2026.
- Artificial Analysis API: HTTP 410.
- Single-author blogs and aggregators (danielvaughan, tembo, morphllm, ianlpaterson, urandom.io, aibuilderclub, benchlm, augmentcode): not maintained as a data source, and some contain errors.
- arXiv and ACM papers: one-off by nature (ACM also answers 403).
- Copilot multipliers page: the current URL is the legacy billing page; HTML only.
- Subscription limits (claude.com/pricing, support articles, Codex pricing): prose with no machine-readable form, so they are no longer stated as facts.
- Antigravity changelog: 1.2 MB of HTML without JSON, so `agy` has no release fact.
