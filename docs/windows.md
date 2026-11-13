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

With herdr in the terminal, type `herdr` and press `Ctrl+B`, then `F`; `foreman '<task>'` typed outside herdr starts it for you. In the Herdr desktop app, the prompt (`Ctrl+Shift+Y`) starts node directly, so PowerShell quoting does not matter there.
