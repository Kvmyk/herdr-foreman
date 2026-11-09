// Client for the Herdr desktop app, with the same methods as createHerdr.
// The app runs no herdr server: every terminal and agent lives in herdr-core
// (hc), and the app shows an hc terminal labelled herdr.space=<id> and
// herdr.tab=<id> in that space and tab; an id it does not know becomes a new
// space or tab. A "pane" here is an hc terminal, and its address (t7) is the
// pane id. Failures become HerdrError with hc's error kind as code.
import { randomBytes } from 'node:crypto';
import { HerdrError, realSleep, sendKeys, submitIfStuck } from './herdr.js';
import { appArgv } from './inventory/kinds.js';

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorOf(res) {
  if (res.timedOut) return new HerdrError('timeout', 'herdr-core did not answer in time');
  const body = parseJson(res.stderr) ?? parseJson(res.stdout);
  if (body?.error?.kind) return new HerdrError(body.error.kind, body.error.message ?? '');
  const text = (res.stderr || res.stdout || `exit code ${res.code}`).trim();
  return new HerdrError('hc_failed', text);
}

// Ids shaped like the app's own (sp<hex>, tb<hex>).
const randomId = (prefix) => `${prefix}${randomBytes(16).toString('hex')}`;

export function createHerdrApp({ run, hc = 'hc', app = 'herdr-app', newId = randomId, sleep = realSleep }) {
  // Options go before positionals: hc takes none after them.
  async function call(command, args, timeoutMs = 30000) {
    const res = await run(hc, [command, '--json', ...args], { timeoutMs });
    if (res.code !== 0) throw errorOf(res);
    return parseJson(res.stdout) ?? {};
  }

  // App commands only work while its window is open; they are never required.
  async function appDo(command, args) {
    try {
      return (await run(app, ['do', command, JSON.stringify(args)], { timeoutMs: 10000 })).code === 0;
    } catch {
      return false;
    }
  }

  // Tabs whose title already says a worker needs the person.
  const needsYou = new Set();

  async function terminals() {
    return (await call('ls', [])).terminals ?? [];
  }

  return {
    kind: 'app',
    appBin: app,

    async serverRunning() {
      const res = await run(hc, ['server', 'status', '--json'], { timeoutMs: 10000 }).catch(() => null);
      return res?.code === 0;
    },

    async appRunning() {
      const res = await run(app, ['status'], { timeoutMs: 10000 }).catch(() => null);
      return res?.code === 0;
    },

    // The space and tab the app shows a terminal in; null outside the app.
    async here(terminal) {
      const t = await call('get', [terminal]).catch(() => null);
      const space = t?.labels?.['herdr.space'];
      return space ? { space, tab: t.labels['herdr.tab'] ?? null } : null;
    },

    // Spaces and tabs come into being with their first terminal, so these
    // only make ids; agentStart puts the terminal there.
    async workspaceCreate() {
      return { workspaceId: newId('sp'), tabId: newId('tb'), paneId: null };
    },

    async tabCreate({ workspaceId } = {}) {
      return { workspaceId: workspaceId ?? newId('sp'), tabId: newId('tb'), paneId: null };
    },

    // Closing a pane ends its terminal; then the finished terminal is removed.
    async paneClose(terminal) {
      try {
        await call('kill', [terminal]);
      } catch (err) {
        if (err.code === 'not_found') throw new HerdrError('pane_not_found', err.message);
        if (err.code !== 'finished') throw err;
      }
      await call('rm', [terminal]).catch(() => {});
    },

    async paneList() {
      return (await terminals()).map((t) => ({ pane_id: t.address, cwd: t.cwd }));
    },

    // Named live terminals, in herdr's agent shape. Names are unique among
    // live hc terminals, foreman's or not, like agent names in herdr.
    async agentList() {
      return (await terminals())
        .filter((t) => t.name)
        .map((t) => ({ name: t.name, pane_id: t.address, agent_status: t.status ?? 'unknown', cwd: t.cwd }));
    },

    // Starts the agent in a new terminal in that space and tab, then waits
    // until it is ready. Never throws: a worker that is not ready (for example
    // stuck on a folder-trust dialog) must not stop the others.
    // --no-parent: workers must not end with the leader, nor hc type notes into it.
    async agentStart({ name, kind, cwd, space, tab, label, focus = false, timeoutMs, args = [] }) {
      const labels = { 'herdr.space': space, 'herdr.tab': tab, 'foreman.name': name };
      const labelArgs = Object.entries(labels).filter(([, v]) => v).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
      let pane;
      try {
        const r = await call('run', [
          '--bg', '--no-parent', '--no-notify', '--name', name, ...(cwd ? ['--cwd', cwd] : []), ...labelArgs,
          '--', ...appArgv(kind, args),
        ]);
        pane = r.address;
      } catch (err) {
        return { ok: false, pane: null, code: err.code, message: err.message };
      }

      const secs = Math.ceil((timeoutMs ?? 30000) / 1000);
      let res;
      try {
        const w = await call('wait', ['--timeout', String(secs), pane], (secs + 15) * 1000);
        if (w.ended && ['idle', 'done'].includes(w.status)) res = { ok: true, pane };
        else if (w.reason === 'exit') res = { ok: false, pane, code: 'agent_exited', message: `${kind} exited (code ${w.exit_code})` };
        else if (w.status === 'blocked') res = { ok: false, pane, code: 'agent_not_ready', message: `${kind} is waiting for an answer` };
        // A folder-trust dialog comes before the agent reports any status.
        else res = { ok: false, pane, code: 'agent_not_ready', message: `${kind} did not report ready within ${secs}s; it may be asking whether to trust the folder` };
      } catch (err) {
        res = { ok: false, pane, code: err.code, message: err.message };
      }
      // By now the window has picked the terminal up, if it is open. A worker
      // that needs the person puts its name in the tab's title and brings the tab
      // forward; a later worker in the same tab does not hide that.
      if (tab) {
        const mark = res.ok ? null : res.code === 'agent_exited' ? '✖' : res.code === 'agent_not_ready' ? '⚠' : null;
        if (mark) {
          needsYou.add(tab);
          await appDo('tab.rename', { id: tab, name: `${mark} ${name} ${res.code === 'agent_exited' ? 'stopped' : 'needs you'}${label ? ` · ${label}` : ''}` });
          await appDo('tab.select', { id: tab });
        } else {
          if (label && !needsYou.has(tab)) await appDo('tab.rename', { id: tab, name: label });
          if (focus && !needsYou.has(tab)) await appDo('tab.select', { id: tab });
        }
      }
      return res;
    },

    // Plain text of the visible screen; with lines, that much history above it too.
    async agentRead(target, { lines = null } = {}) {
      const res = await run(hc, ['read', '--lines', String(lines ?? 0), target], { timeoutMs: 15000 });
      if (res.code !== 0) throw errorOf(res);
      return res.stdout;
    },

    // hc refuses to type into a blocked agent: answer its question with keys first.
    async agentPrompt(target, text) {
      await call('send', [target, '--', text]);
      await submitIfStuck({
        read: () => this.agentRead(target), press: () => call('keys', [target, 'enter']), sleep, text,
      });
    },

    async agentKeys(target, keys) {
      await sendKeys((key) => call('keys', [target, key]), keys, sleep);
    },
  };
}
