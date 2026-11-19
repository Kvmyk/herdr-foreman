// Agent screens captured in the Herdr app on Windows (2026-11-19), with the
// left margin trimmed; shared by the classification and prompt tests.

// opencode 1.18.23 after it updated itself in the background: a modal over the
// input takes every key (a prompt sent then is lost), and closing it ends opencode.
export const OPENCODE_UPDATE_MODAL = [
  '         Update Complete                                      esc',
  '         Successfully updated to OpenCode v1.19.6. Please',
  '         restart the application.',
  '                                                            ok',
  '                                                   ▄',
  '                  █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█',
  '                  █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀',
  '                  ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
  '┃',
  '┃  Ask anything... "Fix a TODO in the codebase"',
  '┃',
  '┃  Build auto · DeepSeek V4.1 Flash Free OpenCode',
  '╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  'tab agents  ctrl+p commands',
  '~\\.herdr-foreman\\worktrees\\herdr-foreman-866ae5\\verify-autosubmit\\v2:wip/verify-autosubmit/v2       1.18.23',
].join('\n');

// The same opencode ready for a prompt: its input with the placeholder.
export const OPENCODE_READY = OPENCODE_UPDATE_MODAL.split('\n').slice(4).join('\n');

// agy 1.5 at its first start in auto mode (as reported from the live run).
export const AGY_AUTO_NOTICE = [
  '  Antigravity CLI 1.5.12',
  '  Gemini 3.8 Flash (Low)',
  '────────────────────────────────────────────',
  '  Auto is now the default agent mode',
  '  Press Shift+Tab to switch agent modes, or change Agent Mode in /config.',
  '  esc to dismiss',
  '────────────────────────────────────────────',
  '>',
  '? for shortcuts                         auto · Gemini 3.8 Flash · low',
].join('\n');
