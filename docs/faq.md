# FAQ

Back to the [README](../README.md).

**Does it cost money?** foreman itself is free. The agents it starts use your own subscriptions or API keys, and a run uses one session for the leader plus one per worker, so more workers mean more tokens. To spend less, use fewer workers (`maxWorkers` in `config.json`), ask for `--effort low` on simple parts, and read [Token use](reference.md#token-use).

**Where do the benchmark numbers come from?** Only from public sources that a maintained organisation keeps updating and a script can read without a key (leaderboard datasets, npm, models.dev); see [the research notes](research/2026-11-11-renewable-sources.md) for what was chosen and rejected. Blog posts and papers are not used, because they never change. Your own journal still outweighs all of it once a category has 5 results.

**What does it change on my computer?** Workers edit copies of your project (git worktrees in `~/.herdr-foreman/worktrees`, on branches `wip/<name>/<worker>`), never your working folder. Your branch changes only when you agree to `foreman land`. foreman also writes `.foreman/` to the repository's `.git/info/exclude`, its own files to `~/.herdr-foreman/`, a block in herdr's `config.toml` and, for the desktop app, `mods/foreman` and one line in `keys.json` (see [what setup changes](reference.md#herdr-app-prompt-details-and-what-setup-changes)).

**What does it never do?** It never pushes and never opens a pull request, it does not land anything without asking you, and a worker does not change anything until you approved the numbered list. Each worker worktree gets a push guard as a tripwire.

**Does my code leave the computer?** foreman sends nothing anywhere. Your coding agents send what they read to their own providers, as they do when you use them yourself. foreman only downloads public data, each at most once a day: model facts (price, context size) from models.dev and the knowledge file `knowledge/agents.json` from GitHub (`knowledgeUrl`; `"knowledgeUrl": false` turns that off).

**How do I undo or remove it?** `foreman cleanup --all` removes leftover worktrees and panes; delete the run branch (`git branch -D <type>/<name>`) if you did not land it. To remove foreman from herdr, run `herdr plugin uninstall herdr-foreman` and delete the `herdr-foreman.start` block in `config.toml`; from the desktop app, delete `mods/foreman` and its line in `keys.json`. `"autoSetup": false` in `~/.herdr-foreman/config.json` stops setup from coming back.

