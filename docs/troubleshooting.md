# Troubleshooting

Back to the [README](../README.md).

Type this in a terminal; it checks herdr, git and your coding agents, fixes what it can and tells you in plain words what is left to do:

```
foreman setup
```

(Without the `foreman` command: `herdr plugin pane open --plugin herdr-foreman --entrypoint setup`.)

| What you see | What to do |
|---|---|
| herdr: the shortcut does nothing | If `Ctrl+B, then F` was already taken, foreman picked `Ctrl+B, then Shift+F` (or `Alt+F`); `foreman setup` shows which one. |
| Desktop app: `Ctrl+Shift+Y` does nothing | Open the app once, then run `foreman setup`. It binds the first free key of `ctrl-shift-y`, `ctrl-alt-shift-f`, `ctrl-shift-f10` and prints which. A `mods/foreman` that is not foreman's, or a `main.js` you edited, is left alone. |
| Desktop prompt: "foreman is not set up" or "moved or was removed" | Run `foreman setup`; it rewrites the prompt with the right paths. |
| "This folder is not one" / "has no saved version yet" | Run `git init`, then `git add -A` and `git commit -m "first version"`. |
| Phone: nothing shows in the Inbox | The run was probably started in the Herdr terminal app. Start it with `foreman new` or the launcher; the app backend is the one the phone sees. |
| An agent is not signed in | `foreman setup` or `foreman agents` shows the exact line to type to sign in. |
| "did not report ready within ...s; it may be asking whether to trust the folder" | The worker is waiting for you. See what it asks with `foreman read --task <slug> <name>`, then answer in its pane or tab (in the app its title starts with `⚠`) or with `foreman keys --task <slug> <name> down enter`. Raise `startTimeoutMs` in `config.json` if the agent is only slow. |
| A worker exits right after starting, or an agent crashes | `foreman read --task <slug> <name>` shows its last screen. Update that agent, or leave it out with `"excludeKinds": ["<kind>"]` in `config.json`; the leader then picks others. |
| With many workers the panes are only a few columns wide | Lower `maxWorkers` in `config.json` (3 or 4 fits most screens), or give foreman a larger window. |
| Runs left behind after a crash or a closed window | `foreman cleanup` lists them, `foreman cleanup --all` removes their worktrees and panes. |
| To undo the herdr shortcut | foreman saved your previous herdr settings as `config.toml.foreman-backup`, and the app's keys as `keys.json.foreman-backup`. |
