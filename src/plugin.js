// What the herdr plugin entrypoints read from the context herdr injects.

// The repository is wherever the user was working: the focused pane's
// directory, else the workspace's.
export function repoFromContext(env) {
  try {
    const ctx = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? '');
    return ctx.focused_pane_cwd || ctx.workspace_cwd || null;
  } catch {
    return null;
  }
}

// An overlay always opens over the active pane; herdr refuses a target.
export function paneOpenArgs(env) {
  return ['plugin', 'pane', 'open', '--plugin', env.HERDR_PLUGIN_ID || 'herdr-foreman', '--entrypoint', 'ask', '--focus'];
}
