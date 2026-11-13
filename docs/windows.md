# Windows and PowerShell

Back to the [README](../README.md).

foreman works in PowerShell like any other command; a few things are different from the examples in the README.

- **Finding the command:** `npm install -g github:Kvmyk/herdr-foreman` puts `foreman` in `%APPDATA%\npm`. Open a new PowerShell window after installing Node.js and foreman, so it sees the new PATH. `Get-Command foreman` should find it.
- **"running scripts is disabled on this system":** PowerShell blocks npm's `foreman.ps1`. Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or type `foreman.cmd` instead of `foreman`.
- **Quote the task with single quotes:** `foreman 'fix the $price rounding in @src/cart.js'`. Inside double quotes PowerShell replaces `$price` with a variable and treats a backtick as an escape.
- **Long tasks:** use `foreman -f task.md`. In Windows PowerShell 5.1, `Get-Content task.md | foreman` turns letters such as ą, é or ß into `?`; if you want to pipe, first run `$OutputEncoding = [Text.UTF8Encoding]::new()`. PowerShell 7.4 and newer pipe correctly.
- **Tasks with `&`, `|`, `<`, `>`, `^` or `%`:** through `foreman.cmd` they go through cmd.exe, which can cut the task short. Put such a task in a file and use `-f`.
- **An editor for the task:** the herdr prompt opens Notepad. For VS Code, set `$env:EDITOR = 'code --wait'` (without `--wait` the editor returns at once and foreman tells you so).
- **From a clone, without npm:** `node C:\path\to\herdr-foreman\bin\foreman.js 'your task'`.
- **Where things are:** herdr's settings in `%APPDATA%\herdr\config.toml`, the Herdr app folder in `%USERPROFILE%\.config\herdr-app`, foreman's own files in `%USERPROFILE%\.herdr-foreman`. To look at herdr's settings: `notepad $env:APPDATA\herdr\config.toml`.

With herdr in the terminal, type `herdr` and press `Ctrl+B`, then `F`; `foreman '<task>'` typed outside herdr starts it for you. In the Herdr desktop app, the prompt (`Ctrl+Shift+Y`) hands the task to foreman in a file, so PowerShell quoting does not matter there.

## The desktop prompt shows an old folder after `cd`

The Herdr app learns a terminal's folder from the shell's working directory, and `cd` (`Set-Location`) in PowerShell does not change it. Herdr adds a small prompt hook to the PowerShell it opens as a plain terminal, so `cd` there is seen. A PowerShell tab started with a command (the tab named foreman that the prompt opens, an agent's tab) did not get the hook: after a `cd` there, the prompt (`Ctrl+Shift+Y`) still showed and used the folder the tab started in.

foreman now:

- starts its own tab as a PowerShell with the same hook, so a `cd` in it later reaches the app;
- reads the last `PS C:\...>` line of the terminal you opened the prompt from and uses that folder when the app reports another one;
- lets you click the folder (`in ...`) in the prompt to pick a folder one of the space's terminals is in, or any folder.

To give every PowerShell the hook, also tabs started with a command by other tools, type:

```
foreman shell-hook on
```

It adds a few lines between `# >>> foreman shell-hook >>>` and `# <<< foreman shell-hook <<<` to your PowerShell profile (`$PROFILE.CurrentUserAllHosts`, for Windows PowerShell and for PowerShell 7 when it is installed) and saves the previous profile as `profile.ps1.foreman-backup`. Only new PowerShell windows and tabs get it. `foreman shell-hook` shows whether it is there; `foreman shell-hook off` removes the lines again. foreman never adds them on its own: `foreman setup` only mentions the command. When PowerShell runs no profile scripts (execution policy `Restricted`), run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` first.
