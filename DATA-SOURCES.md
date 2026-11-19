# Data sources

The code in this repository is under the [MIT licence](LICENSE). MIT covers the code and this project's own selection and arrangement of facts only. The scores, ranks and dates in `knowledge/agents.json` and `docs/research/knowledge-log.md` come from third parties and stay under their own terms, listed below. Only a small subset of facts is kept (top ranks per category, with the source link); whole leaderboards, datasets or archives are never mirrored.

Last reviewed: 2026-11-19. This is a maintainer's summary, not legal advice.

| Source | URL | Licence / terms |
|---|---|---|
| Epoch AI benchmarking hub | https://epoch.ai/benchmarks | CC BY 4.0 |
| Arena (LMArena) leaderboard dataset, `webdev` and `agent` | https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset | CC BY 4.0 |
| Terminal-Bench (Harbor Hub public API) | https://api.harborframework.com/functions/v1/leaderboard-read (docs: https://docs.harborframework.com/harbor-hub/leaderboards; code: https://github.com/harbor-framework/terminal-bench) | facts; public read API documented for display; repo Apache-2.0; no site terms (checked 2026-11-19) |
| LiveBench | https://livebench.ai/ | no licence found; facts only |
| Vals AI | https://www.vals.ai/benchmarks/ | no licence found; facts only |
| Scale SEAL leaderboards | https://scale.com/leaderboard/ | Scale's [website terms](https://scale.com/legal/terms) allow use only for your own internal purposes; SEAL is disabled as a source and its data is not republished |
| models.dev | https://models.dev | MIT |
| npm registry | https://registry.npmjs.org/ | public package metadata |

## Notes

- Epoch's external series (CursorBench, FrontierSWE, DeepSWE) keep their own terms, according to Epoch; they are not covered by Epoch's CC BY 4.0.
- LiveBench and Vals AI: no licence found, and permission has not been granted yet. Only facts are taken.
- Arena: both `lmarena-webdev` and `lmarena-agent` are read from the Hugging Face dataset viewer API at `datasets-server.huggingface.co`. That one host serves both, so if it rate-limits or fails, both sources fail together. Only the `overall` rows are requested (`/filter`, falling back to `/rows`). arena.ai and lmarena.ai are never read: their Terms of Use forbid automated access.
- When a source fails, `sourceMeta.<id>` in `knowledge/agents.json` gets `ok: false`, the `error` the refresh got and the number of `failures` in a row. `lastOk` is the date of the last successful read. The error is also printed as a warning and written to `docs/research/knowledge-log.md`. In that log, the list of facts for models no family matches is printed in full only when it differs from the last full list; otherwise one line says `unchanged since <date> (<n> models)`.
- Grace rule: a failing source keeps its facts. It is frozen (its facts are dropped) from its second failed run in a row once more than 7 days have passed since `lastOk`, and always at its third failed run in a row.
- The CC BY 4.0 attribution (`creator`, `licenceUrl`, `modified`) stays in `sourceMeta` while a source is `ok: false` or frozen, because facts read earlier may still be in the file or in its history.

## Credits

- Epoch AI, "AI Benchmarking Hub", https://epoch.ai/benchmarks, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes made: selected a few values per model and benchmark, converted to JSON, and combined with other sources.
- Arena (LMArena), `lmarena-ai/leaderboard-dataset`, https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes made: kept the latest snapshot only, matched model names, and reduced it to ranks and dates.

- Terminal-Bench (Stanford / Harbor / Laude Institute), https://www.tbench.ai/, read through the Harbor Hub public API, which the Harbor documentation describes as "Fetch a public leaderboard without authentication to display it on your website".

## Takedown and contact

If you own one of these sources and want a fact removed, a source dropped or the credit changed, open an issue at https://github.com/Kvmyk/herdr-foreman/issues. It will be handled promptly.
