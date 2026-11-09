#!/bin/sh
# Install foreman and set it up in one go, on macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/Kvmyk/herdr-foreman/main/install.sh | sh
# Checks Node.js and git, installs the foreman command with npm, then runs
# "foreman setup": the Herdr desktop app gets its task prompt and its key,
# herdr its shortcut, and you read what is left to do.
# FOREMAN_PACKAGE picks what npm installs (default: github:Kvmyk/herdr-foreman).
# Everything is in main, called on the last line, so sh has read the whole
# script before anything runs (stdin is this script when it comes through a pipe).
main() {
  package="${FOREMAN_PACKAGE:-github:Kvmyk/herdr-foreman}"

  if ! command -v node >/dev/null 2>&1; then
    say "Node.js is not installed. Install version 20 or newer from https://nodejs.org, then run this again."
    return 1
  fi
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -lt 20 ]; then
    say "Node.js $(node --version) is too old. Install version 20 or newer from https://nodejs.org, then run this again."
    return 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    say "git is not installed. Install it from https://git-scm.com, then run this again."
    return 1
  fi

  say "installing $package with npm..."
  if ! npm install -g "$package"; then
    say "npm could not install foreman; the lines above say why. On EACCES see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
    return 1
  fi
  echo
  node "$(npm root -g)/herdr-foreman/bin/foreman.js" setup </dev/null
}

say() { printf 'foreman: %s\n' "$1"; }

main "$@"
