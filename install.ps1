# Install foreman and set it up in one go, on Windows:
#   irm https://raw.githubusercontent.com/Kvmyk/herdr-foreman/main/install.ps1 | iex
# Checks Node.js and git, installs the foreman command with npm, then runs
# "foreman setup": the Herdr desktop app gets its task prompt and Ctrl+Shift+Y,
# herdr its shortcut, and you read what is left to do.
# FOREMAN_PACKAGE picks what npm installs (default: github:Kvmyk/herdr-foreman).
# Everything runs in a script block, so "return" stops it without closing the window.
& {
  $package = if ($env:FOREMAN_PACKAGE) { $env:FOREMAN_PACKAGE } else { 'github:Kvmyk/herdr-foreman' }
  function Say($text) { Write-Host "foreman: $text" }

  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Say 'Node.js is not installed. Install version 20 or newer from https://nodejs.org, open a new PowerShell window and run this again.'
    return
  }
  $major = [int]((& node.exe -p process.versions.node | Out-String).Trim().Split('.')[0])
  if ($major -lt 20) {
    Say "Node.js $(& node.exe --version) is too old. Install version 20 or newer from https://nodejs.org, then run this again."
    return
  }
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    Say 'git is not installed. Install it from https://git-scm.com, open a new PowerShell window and run this again.'
    return
  }

  # npm.cmd, not npm: PowerShell would pick npm.ps1, which a Restricted execution policy blocks.
  Say "installing $package with npm..."
  & npm.cmd install -g $package
  if ($LASTEXITCODE -ne 0) {
    Say 'npm could not install foreman; the lines above say why.'
    return
  }
  $root = (& npm.cmd root -g | Out-String).Trim()
  Write-Host ''
  & node.exe (Join-Path $root 'herdr-foreman\bin\foreman.js') setup
}
