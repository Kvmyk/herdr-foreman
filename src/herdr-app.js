// Client for the Herdr desktop app, with the same methods as createHerdr.
// The app runs no herdr server: every terminal and agent lives in herdr-core
// (hc), and the app shows an hc terminal labelled herdr.space=<id> and
// herdr.tab=<id> in that space and tab; an id it does not know becomes a new
// space or tab. A "pane" here is an hc terminal, and its address (t7) is the
// pane id. Failures become HerdrError with hc's error kind as code.
import { randomBytes } from 'node:crypto';
import { HerdrError, realSleep, sendKeys, submitIfStuck } from './herdr.js';
import { appArgv } from './inventory/kinds.js';
import { appStackSteps } from './layout.js';

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

  // The reply of an app command; null when it failed or the window is closed.
  // A terminal hc has just started is not known to the window for a moment:
  // until it is, the command is tried again (every 200 ms, up to 5 s).
  async function appCall(command, args) {
    for (let tries = 0; ; tries++) {
      let res;
      try {
        res = await run(app, ['do', command, JSON.stringify(args)], { timeoutMs: 10000 });
      } catch {
        return null;
      }
      if (res.code === 0) return parseJson(res.stdout) ?? {};
      if (tries >= 25 || !/no running terminal/.test(`${res.stdout}${res.stderr}`)) return null;
      await sleep(200);
    }
  }

  // Where the open window shows a terminal: { pane, tab }, or null.
  async function shownAt(terminal) {
    let res;
    try {
      res = await run(app, ['ls'], { timeoutMs: 10000 });
    } catch {
      return null;
    }
    for (const sp of parseJson(res.code === 0 ? res.stdout : '')?.spaces ?? []) {
      for (const tab of sp.tabs ?? []) {
        const t = (tab.terminals ?? []).find((x) => x.terminal === terminal);
        if (t?.pane) return { pane: t.pane, tab };
      }
    }
    return null;
  }

  // Runs the steps of appStackSteps as the workers' terminals come up, in
  // order. A worker that cannot be given its pane gets the labels instead, so
  // the window still shows it, beside the others.
  function stacker({ steps, count, leader, leaderPane, space, tab }) {
    const terms = new Array(count); // undefined until its hc run has returned; null when it failed
    const panes = new Array(count).fill(null);
    let pos = 0;
    let busy = Promise.resolve();

    const label = (i) => call('label', [terms[i], `herdr.space=${space}`, `herdr.tab=${tab}`]).catch(() => {});

    async function step(s) {
      if ('leader' in s) {
        if (leaderPane) await appCall('layout.resize', { id: leaderPane, weight: s.leader });
        return;
      }
      const t = terms[s.worker];
      if (!t) return;
      if ('weight' in s) {
        if (panes[s.worker]) await appCall('layout.resize', { id: panes[s.worker], weight: s.weight });
        return;
      }
      if (s.place === null) {
        // Shown by its labels; the window picks it up a moment later.
        for (let tries = 0; tries < 20 && !panes[s.worker]; tries++) {
          panes[s.worker] = (await shownAt(t))?.pane ?? null;
          if (!panes[s.worker]) await sleep(250);
        }
        return;
      }
      const anchor = s.anchor === 'leader' ? leader : panes[s.anchor] && terms[s.anchor];
      const kept = anchor && await appCall('pane.focus', { terminal: anchor })
        && await appCall('terminal.keep', { terminal: t, place: s.place });
      if (kept?.pane) panes[s.worker] = kept.pane;
      else await label(s.worker);
    }

    async function pump() {
      while (pos < steps.length) {
        const s = steps[pos];
        const needs = [s.worker, typeof s.anchor === 'number' ? s.anchor : undefined].filter((i) => i !== undefined);
        if (needs.some((i) => terms[i] === undefined)) return;
        pos++;
        await step(s).catch(() => {});
      }
      if (pos === steps.length && leader) {
        pos++;
        await appCall('pane.focus', { terminal: leader });
      }
    }

    return {
      // Worker 0 of a new tab is shown by its labels; the others start hidden.
      labelled: (i) => steps.some((s) => s.worker === i && s.place === null),
      // The worker's terminal (null: it did not start); resolves when the
      // steps that could run so far are done. Never rejects.
      add(i, terminal) {
        terms[i] = terminal ?? null;
        busy = busy.then(pump);
        return busy;
      },
    };
  }

  // Tabs whose title already says a worker needs the person.
  const needsYou = new Set();

  // Pins a worker that needs the person to the top of every Herdr client's
  // agent list (herdr.pinned is shared by the desktop and the phone app).
  // foreman.pinned marks the pin as foreman's, so a pin the person set is
  // never taken away; its value is the tab title to put back, or 1.
  async function pin(terminal, restore) {
    await call('label', [terminal, 'herdr.pinned=1', `foreman.pinned=${restore || '1'}`]).catch(() => {});
  }

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

    // A terminal's size now (that of its last active viewer) and its labels;
    // null when hc does not know it.
    async terminalInfo(terminal) {
      const t = await call('get', [terminal]).catch(() => null);
      return t?.address ? { cols: t.cols ?? null, rows: t.rows ?? null, labels: t.labels ?? {} } : null;
    },

    // A worker was answered: take foreman's pin off again and, when the tab
    // is the worker's own, give the tab its title back. A pin the person set
    // (no foreman.pinned beside it) stays.
    async answered(terminal) {
      const t = await call('get', [terminal]).catch(() => null);
      const restore = t?.labels?.['foreman.pinned'];
      if (!restore) return false;
      await call('label', [t.address ?? terminal, 'herdr.pinned=', 'foreman.pinned=']).catch(() => {});
      const tab = t.labels['herdr.tab'];
      if (restore !== '1' && tab) {
        needsYou.delete(tab);
        await appDo('tab.rename', { id: tab, name: restore });
      }
      return true;
    },

    // Stacks a spawn's workers in the open window: in the leader's tab right
    // of the leader, or in a new tab (newTab). Null when the window is closed or
    // does not show the leader; the workers then come up by their labels and
    // the app puts them side by side.
    async stackLayout({ leader = null, space, tab, newTab = false, count }) {
      if (!(await this.appRunning())) return null;
      let leaderPane = null;
      if (!newTab) {
        const at = leader ? await shownAt(leader) : null;
        if (!at) return null;
        // The leader's weight is known only when it is alone in its tab.
        if (at.tab.terminals.length === 1) leaderPane = at.pane;
      }
      return stacker({ steps: appStackSteps(count, { newTab }), count, leader, leaderPane, space, tab });
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
    // parent (a worker's leader): every Herdr client then lists the worker
    // under its leader. --outlive-parent keeps it running when the leader
    // ends, and --no-notify keeps hc from typing notes into the leader. A
    // leader gets no parent: the terminal that started it ends.
    // labels: more labels, such as foreman.task and foreman.role. where: the
    // words hc lists the terminal with ("<repo> / <task>"); the open desktop
    // window writes its own, so it is set only while the window is closed
    // (windowOpen false; when unknown it is asked here).
    // With stack (from stackLayout) and its index, the terminal is placed in
    // the stack instead of being shown by its labels.
    // ownTab: the tab holds this agent only (layout tabs). A worker that
    // needs the person then says so in the tab's title, but the tab is not
    // brought forward: the leader's terminal is where the person answers.
    async agentStart({ name, kind, cwd, space, tab, label, focus = false, timeoutMs, args = [], stack = null, index = 0, parent = null, labels: more = {}, where = null, windowOpen = null, ownTab = false }) {
      const shown = !stack || stack.labelled(index);
      if (where && windowOpen === null) windowOpen = await this.appRunning();
      const labels = { 'herdr.space': shown ? space : null, 'herdr.tab': shown ? tab : null, 'foreman.name': name, ...more, where: where && windowOpen === false ? where : null };
      const labelArgs = Object.entries(labels).filter(([, v]) => v).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
      let pane;
      try {
        const r = await call('run', [
          '--bg', ...(parent ? ['--parent', parent, '--outlive-parent'] : ['--no-parent']), '--no-notify', '--name', name, ...(cwd ? ['--cwd', cwd] : []), ...labelArgs,
          '--', ...appArgv(kind, args),
        ]);
        pane = r.address;
      } catch (err) {
        await stack?.add(index, null);
        return { ok: false, pane: null, code: err.code, message: err.message };
      }
      await stack?.add(index, pane);

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
      // forward (a tab of its own stays where it is, see ownTab); a later worker
      // in the same tab does not hide that. One waiting for an answer is pinned too.
      const mark = res.ok ? null : res.code === 'agent_exited' ? '✖' : res.code === 'agent_not_ready' ? '⚠' : null;
      if (mark === '⚠') await pin(pane, ownTab && tab ? label : null);
      if (tab) {
        if (mark) {
          needsYou.add(tab);
          // A tab of its own is already titled "<name> · <task>": the name is not said twice.
          const rest = ownTab && label?.startsWith(`${name} · `) ? label.slice(name.length + 3) : label;
          await appDo('tab.rename', { id: tab, name: `${mark} ${name} ${res.code === 'agent_exited' ? 'stopped' : 'needs you'}${rest ? ` · ${rest}` : ''}` });
          if (!ownTab) await appDo('tab.select', { id: tab });
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
    // A message that went in means nobody is waited for there any more (the
    // person may have answered in the terminal itself), so foreman's pin comes off.
    async agentPrompt(target, text) {
      await call('send', [target, '--', text]);
      await this.answered(target);
      await submitIfStuck({
        read: () => this.agentRead(target), press: () => call('keys', [target, 'enter']), sleep, text,
      });
    },

    // Keys answer a question, so a pin foreman set on the terminal comes off.
    async agentKeys(target, keys) {
      await sendKeys((key) => call('keys', [target, key]), keys, sleep);
      await this.answered(target);
    },
  };
}
