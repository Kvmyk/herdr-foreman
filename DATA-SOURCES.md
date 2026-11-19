# Data sources

The code in this repository is under the [MIT licence](LICENSE). MIT covers the code and this project's own selection and arrangement of facts only. The scores, ranks and dates in `knowledge/agents.json` and `docs/research/knowledge-log.md` come from third parties and stay under their own terms, listed below. Only a small subset of facts is kept (top ranks per category, with the source link); whole leaderboards, datasets or archives are never mirrored.

Last reviewed: 2026-11-19. This is a maintainer's summary, not legal advice.

| Source | URL | Licence / terms |
|---|---|---|
| Epoch AI benchmarking hub | https://epoch.ai/benchmarks | CC BY 4.0 |
| Arena (LMArena) leaderboard dataset, `webdev` and `agent` | https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset | CC BY 4.0 |
| Terminal-Bench | https://www.tbench.ai/ (code: https://github.com/harbor-framework/terminal-bench) | Apache-2.0 for the GitHub repository; the site data has no separate licence, only facts are taken |
| LiveBench | https://livebench.ai/ | no licence found; facts only |
| Vals AI | https://www.vals.ai/benchmarks/ | no licence found; facts only |
| Scale SEAL leaderboards | https://scale.com/leaderboard/ | Scale's [website terms](https://scale.com/legal/terms) allow use only for your own internal purposes; SEAL is disabled as a source and its data is not republished |
| models.dev | https://models.dev | MIT |
| npm registry | https://registry.npmjs.org/ | public package metadata |

## Credits

- Epoch AI, "AI Benchmarking Hub", https://epoch.ai/benchmarks, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes made: selected a few values per model and benchmark, converted to JSON, and combined with other sources.
- Arena (LMArena), `lmarena-ai/leaderboard-dataset`, https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes made: kept the latest snapshot only, matched model names, and reduced it to ranks and dates.

## Takedown and contact

If you own one of these sources and want a fact removed, a source dropped or the credit changed, open an issue at https://github.com/Kvmyk/herdr-foreman/issues. It will be handled promptly.
