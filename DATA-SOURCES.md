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

## Credits

- Epoch AI, "AI Benchmarking Hub", https://epoch.ai/benchmarks, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes made: selected a few values per model and benchmark, converted to JSON, and combined with other sources.
- Arena (LMArena), `lmarena-ai/leaderboard-dataset`, https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes made: kept the latest snapshot only, matched model names, and reduced it to ranks and dates.

- Terminal-Bench (Stanford / Harbor / Laude Institute), https://www.tbench.ai/, read through the Harbor Hub public API, which the Harbor documentation describes as "Fetch a public leaderboard without authentication to display it on your website".

## Takedown and contact

If you own one of these sources and want a fact removed, a source dropped or the credit changed, open an issue at https://github.com/Kvmyk/herdr-foreman/issues. It will be handled promptly.
