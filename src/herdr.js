// Thin client over the herdr CLI. Every call parses herdr's JSON reply;
// failures become HerdrError with herdr's own error code.

export class HerdrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HerdrError';
    this.code = code;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorOf(res) {
  if (res.timedOut) return new HerdrError('timeout', 'herdr did not answer in time');
  const body = parseJson(res.stdout) ?? parseJson(res.stderr);
  if (body?.error?.code) return new HerdrError(body.error.code, body.error.message ?? '');
  const text = (res.stderr || res.stdout || `exit code ${res.code}`).trim();
  return new HerdrError('herdr_failed', text);
}

export function formatRatio(ratio) {
  return String(Number(ratio.toFixed(4)));
}

export function createHerdr({ run, bin = 'herdr' }) {
  async function call(args, timeoutMs = 30000) {
    const res = await run(bin, args, { timeoutMs });
    if (res.code !== 0) throw errorOf(res);
    const body = parseJson(res.stdout) ?? {};
    return body.result ?? body;
  }

  const focusFlag = (focus) => (focus ? '--focus' : '--no-focus');

  return {
    async serverRunning() {
      const res = await run(bin, ['status', 'server'], { timeoutMs: 10000 });
      return /status:\s*running/.test(res.stdout);
    },

    async workspaceCreate({ cwd, label, focus = false }) {
      const r = await call(['workspace', 'create', '--cwd', cwd, ...(label ? ['--label', label] : []), focusFlag(focus)]);
      return { workspaceId: r.workspace.workspace_id, tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
    },

    async tabCreate({ workspaceId, cwd, label, focus = false }) {
      const r = await call([
        'tab', 'create',
        ...(workspaceId ? ['--workspace', workspaceId] : []),
        '--cwd', cwd,
        ...(label ? ['--label', label] : []),
        focusFlag(focus),
      ]);
      return { tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
    },

    async paneSplit({ pane, direction, ratio, cwd }) {
      const r = await call([
        'pane', 'split', '--pane', pane, '--direction', direction,
        '--ratio', formatRatio(ratio), '--cwd', cwd, '--no-focus',
      ]);
      return r.pane.pane_id;
    },

    async paneClose(paneId) {
      await call(['pane', 'close', paneId]);
    },

    async agentList() {
      const r = await call(['agent', 'list']);
      return r.agents ?? [];
    },

    // Never throws on a herdr error: a worker that is not ready (for example
    // stuck on a folder-trust dialog) must not stop the others.
    async agentStart({ name, kind, pane, timeoutMs, args = [] }) {
      const argv = [
        'agent', 'start', name, '--kind', kind, '--pane', pane,
        ...(timeoutMs ? ['--timeout', String(timeoutMs)] : []),
        ...(args.length ? ['--', ...args] : []),
      ];
      const res = await run(bin, argv, { timeoutMs: (timeoutMs ?? 30000) + 15000 });
      if (res.code === 0) return { ok: true };
      const err = errorOf(res);
      return { ok: false, code: err.code, message: err.message };
    },

    async agentPrompt(target, text) {
      await call(['agent', 'prompt', target, text]);
    },
  };
}
