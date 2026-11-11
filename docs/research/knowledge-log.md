# Knowledge log

What each refresh of `knowledge/agents.json` changed, newest last. Written by `scripts/refresh-knowledge.js`.

## 2026-11-11

- New unverified family `gemma` (google, match `gemma`) for: gemma-4-31b-it, gemma-4-26b-a4b-it.
- Needs a manual look, no stub added (only alias ids (*-latest)): gpt-daybreak-blue-latest (openai, models.dev family `gpt-sol`).
- Needs a manual look, no stub added (variant of existing family gpt): gpt-daybreak-red-latest (openai, models.dev family `gpt`).
- Needs a manual look, no stub added (variant of existing family gemini-pro): gemini-pro-latest (google, models.dev family `gemini-pro`).
- Source links needing attention (none removed automatically):
  - `vuln-diversity` error (HTTP 403): https://dl.acm.org/doi/pdf/10.1145/3786181.3788719
- Note: source links that redirect (still reachable, consider updating the URL):
  - `copilot-multipliers` moved (HTTP 200) -> https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/model-multipliers-for-annual-plans: https://docs.github.com/en/copilot/reference/copilot-billing/model-multipliers-for-annual-plans
  - `pi-review` moved (HTTP 200) -> https://urandom.io/blog/2026-03-07-pi-dev-deep-dive/: https://urandom.io/blog/2026-03-07-pi-dev-deep-dive
- Warning: part B skipped: Gemini gemini-3.8-flash returned HTTP 503
