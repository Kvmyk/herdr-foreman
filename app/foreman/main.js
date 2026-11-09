// foreman: describe a task, a lead agent splits it across your coding agents.
// Installed and updated by "foreman setup"; edit a copy under another name,
// a changed file is left alone. Ctrl+Enter starts, Enter adds a line, Esc cancels.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, focused, panes, notify, exec, readTextFile, writeTextFile, home, shared, setShared } from "herdr";

// Filled in by "foreman setup" with this machine's node and foreman paths.
const NODE = "__NODE__";
const BIN = "__BIN__";

const RECENT = 4;
const HINTS = 5;

// Where the focused terminal is now, else where its space was made.
function folder() {
  const f = focused();
  if (f?.cwd) return f.cwd;
  const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space?.folder || null;
}

const forward = (p) => p.replace(/\\/g, "/");
const firstLine = (text) => text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
const readyKinds = (agents) => agents.filter((a) => a.status === "ready").map((a) => a.kind);
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// The word being typed when it starts with @, e.g. "@src/lo" at the end of the text.
function mention(text) {
  const m = text.match(/(?:^|\s)@([^\s"'`]*)$/);
  return m ? m[1] : null;
}

export default class Foreman extends View {
  init(_props, cx) {
    this.text = "";
    this.started = false;
    this.problem = null;      // why Start cannot work, shown inline
    this.leader = "claude";   // the leader for this task; configLeader is what foreman uses anyway
    this.configLeader = "claude";
    this.ready = null;        // agents that can lead (ready ones), once listed
    this.branches = null;     // local branches of the folder, once listed
    this.base = null;         // chosen base branch; null: the current branch
    this.menu = null;         // which pill's choices are open: "leader" or "branch"
    this.recent = [];
    this.files = null;        // tracked files of the folder, for @ hints
    this.drafted = null;      // what the draft file holds now (null: no file)
    // Where the prompt was opened from, kept even if focus moves while typing.
    this.origin = focused();
    this.where = folder();
    this.prefs = { answer: false, uncommitted: false, ...(shared("foreman.prefs") ?? {}) };
    this.dir = `${forward(home())}/.herdr-foreman`;

    this.input = TextareaState.new({ placeholder: "What should be done? Point at files with @name.", rows: 6 });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    // Enter adds a line; Ctrl+Enter (Cmd on a Mac) starts.
    this.input.on("submit", (e) => {
      if (e?.secondary) this.submit();
      else this.input.replace("\n");
    });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    // A switch row takes the keyboard when clicked or tabbed to; Space or Enter flips it.
    this.rowFocus = { answer: cx.focus_handle(), uncommitted: cx.focus_handle() };
    this.acx = cx;
    cx.spawn(async (cx) => { await this.load(); cx.notify(); });
    cx.spawn(async (cx) => { await this.loadBranches(); cx.notify(); });
    cx.spawn(async (cx) => { await this.loadAgents(cx); });
  }

  // Draft, recent tasks, the leader, and whether a task can start at all.
  async load() {
    const read = async (name) => (await readTextFile(`${this.dir}/${name}`).catch(() => null)) ?? null;
    const [draft, recent, config] = await Promise.all([read("draft"), read("recent.json"), read("config.json")]);
    this.drafted = draft;
    this.recentText = recent;
    try { this.recent = JSON.parse(recent ?? "[]").filter((t) => typeof t === "string").slice(0, RECENT); } catch { /* start over */ }
    try { this.configLeader = JSON.parse(config ?? "{}").leader || "claude"; } catch { /* keep the default */ }
    this.leader = this.configLeader;
    if (draft?.trim() && !this.text) { this.input.set_value(draft); this.text = draft; }
    this.problem = await this.check();
  }

  // What the pills can offer: the local branches, and the agents that are ready to
  // lead. Each comes on its own, so the branches never wait for the agents. Either
  // may stay empty (an old foreman, no git); the pills then just show the current value.
  async loadBranches() {
    if (!this.where) return;
    const r = await exec("git", ["branch", "--format=%(refname:short)"], { cwd: this.where }).catch(() => null);
    this.branches = r?.code === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("(")) : [];
  }

  // Asking every agent takes seconds (some list their models slowly), so the list
  // foreman kept last time shows at once and the fresh answer replaces it.
  async loadAgents(cx) {
    if (NODE.startsWith("__") || BIN.startsWith("__") || !this.where) return;
    const kept = await readTextFile(`${this.dir}/agents.json`).catch(() => null);
    try {
      const agents = JSON.parse(kept ?? "null")?.agents;
      if (Array.isArray(agents)) { this.ready = readyKinds(agents); cx.notify(); }
    } catch { /* asked below */ }
    const r = await exec(NODE, [BIN, "agents", "--json", "--quick"], { cwd: this.where }).catch(() => null);
    try {
      if (r?.code === 0) this.ready = readyKinds(JSON.parse(r.stdout));
    } catch { /* keep what was kept */ }
    if (!this.ready) this.ready = [];
    cx.notify();
  }

  // The leader foreman uses anyway comes first when it is not among the ready ones.
  leaderChoices() {
    if (!this.ready) return null;
    return this.ready.includes(this.configLeader) ? this.ready : [this.configLeader, ...this.ready];
  }

  async check() {
    if (NODE.startsWith("__") || BIN.startsWith("__")) return 'foreman is not set up: type "foreman setup" in a terminal.';
    if (!this.where) return "Open a terminal in your project folder first, then press the key again.";
    const node = await exec(NODE, ["--version"]).catch(() => null);
    if (node?.code !== 0 || (await readTextFile(BIN).catch(() => null)) === null) {
      return 'foreman or node moved or was removed: type "foreman setup" in a terminal to repair this prompt.';
    }
    const git = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.where }).catch(() => null);
    if (git === null) return "git is not installed or not on PATH.";
    if (git.code !== 0) return "This folder is not a git repository. Open your project folder, or run git init.";
    this.files = null;
    return null;
  }

  // Tracked files of the folder, listed once, for @ hints.
  async loadFiles() {
    if (this.files || this.loadingFiles || !this.where) return;
    this.loadingFiles = true;
    const r = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: this.where }).catch(() => null);
    this.files = r?.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
    this.loadingFiles = false;
  }

  hints() {
    const word = mention(this.text);
    if (word === null) return [];
    if (!this.files) { this.acx.spawn(async (cx) => { await this.loadFiles(); cx.notify(); }); return []; }
    const q = word.toLowerCase();
    return this.files.filter((f) => f.toLowerCase().includes(q)).slice(0, HINTS);
  }

  pick(file) {
    const text = this.text.replace(/@[^\s"'`]*$/, `@${file} `);
    this.input.set_value(text);
    this.text = text;
    this.input.focus();
  }

  // The draft survives Esc and a closed window; Start clears it.
  async saveDraft(text) {
    const next = text.trim() ? text : "";
    if (next === (this.drafted ?? "")) return;
    try {
      await writeTextFile(`${this.dir}/draft`, next, this.drafted);
      this.drafted = next;
    } catch { /* the folder is missing or the draft changed elsewhere: not worth a message */ }
  }

  async remember(task) {
    const list = [task, ...this.recent.filter((t) => t !== task)].slice(0, RECENT);
    try { await writeTextFile(`${this.dir}/recent.json`, JSON.stringify(list), this.recentText ?? null); } catch { /* not important */ }
  }

  cancel() {
    this.saveDraft(this.text);
    closeOverlay(props().overlay);
  }

  close() {
    if (!this.started) return this.saveDraft(this.text);
  }

  submit() {
    const task = this.text.trim();
    if (!task || this.problem || this.started) return;
    this.started = true;
    const f = this.origin;
    const where = this.where;
    setShared("foreman.prefs", this.prefs);
    this.remember(task);
    this.saveDraft("");
    closeOverlay(props().overlay);
    const argv = [NODE, BIN, "--backend", "app", ...(this.leader !== this.configLeader ? ["--leader", this.leader] : []), ...(this.base ? ["--base", this.base] : []), ...(this.prefs.answer ? ["--auto-answer"] : []), ...(this.prefs.uncommitted ? ["--include-uncommitted"] : []), "--", task];
    try {
      // A terminal of its own: no time limit, and foreman opens the leader tab, then ends.
      run("tab.new", { name: "foreman", space: f?.space, folder: where, argv });
      notify({ title: "foreman", body: `Started: ${clip(firstLine(task), 80)}`, level: "success" });
    } catch (err) {
      notify({ title: "foreman could not start", body: String(err?.message ?? err), level: "error", timeout: 15000 });
    }
  }

  key(e, cx) {
    if (e.key === "escape") { this.cancel(); cx.stop_propagation(); }
  }

  // The git branch of the terminal the prompt was opened from, if the app knows it.
  branch() {
    const f = this.origin;
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return pane?.branch ?? spaces().find((s) => s.id === f?.space)?.branch ?? null;
  }

  render(cx) {
    const t = theme();
    const ready = Boolean(this.text.trim()) && !this.problem;
    const lines = this.text.trim() ? this.text.split(/\r?\n/).length : 0;
    const chars = this.text.trim().length;

    const pill = (...children) => h_flex().items_center().gap(6).px(8).py(4).rounded(6).bg(t.raised).border_1().border_color(t.border)
      .text_size(11.5).text_color(t.muted).min_w(0).children(children);
    const cap = (text) => div().px(6).py(2).rounded(4).bg(t.raised).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child(text);
    const hint = (caps, text) => h_flex().items_center().gap(4).children(caps.map(cap)).child(div().pl(2).text_size(11).text_color(t.dim).child(text));
    const button = (id, text, primary, enabled, action) => h_flex().id(id).h(32).px(16).items_center().justify_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .opacity(enabled ? 1 : 0.4).cursor_pointer().hover((s) => (enabled ? s.opacity(0.88) : s))
      .on_click(() => { if (enabled) action(); }).child(text);
    // A switch row: track and knob, a title, and one line saying what it does. The
    // handlers redraw with the context they are given: the one render() got is only
    // good while rendering. Clicking anywhere on the row flips it, so does Space or Enter.
    const flip = (name, hcx) => { this.prefs = { ...this.prefs, [name]: !this.prefs[name] }; hcx.notify(); };
    const toggle = (id, title, detail, name) => {
      const on = Boolean(this.prefs[name]);
      return h_flex().id(id).track_focus(this.rowFocus[name]).items_center().gap(12).py(4).px(6).rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).focus((s) => s.bg(t.hover))
        .on_click((_e, hcx) => flip(name, hcx))
        .on_key_down((e, hcx) => { if (e.key === "space" || e.key === " " || e.key === "enter") { flip(name, hcx); hcx.stop_propagation(); } })
        .child((on ? h_flex().justify_end() : h_flex().justify_start()).w(32).h(18).p(2).flex_shrink_0().rounded_full().items_center().bg(on ? t.solid : t.input).border_1().border_color(on ? t.solid : t.border)
          .child(div().w(12).h(12).rounded_full().bg(on ? t.solid_foreground : t.muted)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12.5).text_color(t.foreground).child(title))
          .child(div().text_size(11).text_color(t.dim).child(detail)));
    };
    const chip = (id, text, color, action, chosen = false) => div().id(id).px(10).py(4).rounded_full().bg(t.raised).border_1().border_color(chosen ? t.accent : t.border)
      .text_size(11.5).text_color(color).truncate().cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action).child(text);
    // A pill that opens its choices below: a label, the value, a caret.
    const open = (name) => (_e, hcx) => { this.menu = this.menu === name ? null : name; hcx.notify(); };
    const pick = (apply) => (_e, hcx) => { apply(); this.menu = null; hcx.notify(); this.input.focus(); };
    const choice = (id, label, value, name) => pill(div().text_color(t.dim).child(label), div().text_color(t.foreground).child(value), div().text_size(9).text_color(t.dim).child(this.menu === name ? "\u25b4" : "\u25be"))
      .id(id).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(open(name));

    const branch = this.branch();
    const hints = this.hints();
    const body = v_flex().id("foreman").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().h_full().min_h(0).p(24).gap(16).bg(t.popover).text_color(t.foreground);

    // Header: mark, title with subtitle, and the leader that will run the task.
    body.child(h_flex().items_center().gap(12)
      .child(image("mods/foreman/logo.svg").w(32).h(32).flex_none())
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(15).font_semibold().child("New task"))
        .child(div().text_size(11.5).text_color(t.dim).child("A lead agent splits it across your coding agents.")))
      .child(choice("fm-leader", "leader", this.leader, "leader")));

    // Where it will run: the folder is cut from the left, its end says which project it is.
    body.child(h_flex().items_center().gap(8)
      .child(h_flex().flex_1().min_w(0).items_center().gap(6).px(8).py(4).rounded(6).bg(t.raised).border_1().border_color(this.where ? t.border : t.blocked)
        .child(div().flex_shrink_0().text_size(11.5).text_color(t.dim).child("in"))
        .child(div().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_ellipsis_start().text_size(11.5).text_color(this.where ? t.muted : t.blocked).child(this.where ?? "no folder")))
      .child(choice("fm-branch", "branch", clip(this.base ?? branch ?? "current", 28), "branch")));

    // The open pill's choices, as chips: the leader's agent, or the branch the run starts from and lands on.
    if (this.menu === "leader") {
      const choices = this.leaderChoices();
      const kinds = choices ?? [this.leader];
      body.child(v_flex().gap(6)
        .child(div().text_size(11).text_color(t.dim).child(choices ? "Which agent leads this task" : "Which agent leads this task (looking for ready agents...)"))
        .child(h_flex().flex_wrap().gap(6).children(kinds.map((k, i) => chip(`fm-kind-${i}`, k, k === this.leader ? t.foreground : t.muted, pick(() => { this.leader = k; }), k === this.leader)))));
    } else if (this.menu === "branch") {
      const current = this.base ?? branch;
      const names = [...new Set([...(current ? [current] : []), ...(this.branches ?? [])])];
      body.child(v_flex().gap(6)
        .child(div().text_size(11).text_color(t.dim).child(names.length ? "Workers start from this branch, and the result is merged back into it" : "No local branches found"))
        .child(h_flex().flex_wrap().gap(6).children(names.slice(0, 24).map((b, i) => chip(`fm-base-${i}`, clip(b, 32), b === current ? t.foreground : t.muted, pick(() => { this.base = b === branch ? null : b; }), b === current))))
        .children(names.length > 24 ? [div().text_size(11).text_color(t.dim).child(`${names.length - 24} more branches not shown`)] : []));
    }

    if (this.problem) {
      body.child(h_flex().items_start().gap(10).px(12).py(10).rounded(8).bg(t.raised).border_1().border_color(t.blocked)
        .child(div().w(18).h(18).flex_shrink_0().rounded_full().bg(t.blocked).flex().items_center().justify_center().text_size(11).font_semibold().text_color(t.background).child("!"))
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(this.problem)));
    }

    // The task box, with a quiet border that turns accent on focus, and a count.
    body.child(v_flex().flex_1().min_h(0).gap(6)
      .child(Textarea.new(this.input).w_full().flex_1().min_h(120).p(12).rounded(10).border_1().border_color(t.border)
        .focus((s) => s.border_color(t.accent)).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().items_center().px(2)
        .child(div().flex_1().text_size(11).text_color(t.dim).child(mention(this.text) !== null ? "Pick a file below, or keep typing." : "Type @ to point at a file."))
        .child(div().text_size(11).text_color(t.dim).child(`${chars} chars · ${lines} ${lines === 1 ? "line" : "lines"}`))));

    if (hints.length) {
      body.child(h_flex().flex_wrap().gap(6).children(hints.map((f, i) => chip(`fm-hint-${i}`, `@${f}`, t.accent, () => this.pick(f)))));
    } else if (!this.text && this.recent.length) {
      body.child(v_flex().gap(6)
        .child(div().text_size(11).text_color(t.dim).child("Recent"))
        .child(h_flex().flex_wrap().gap(6).children(this.recent.map((r, i) => chip(`fm-recent-${i}`, clip(firstLine(r), 44), t.muted, () => { this.input.set_value(r); this.text = r; this.input.focus(); })))));
    }

    body.child(v_flex().gap(4)
      .child(toggle("fm-answer", "Workers answer permission questions automatically", "Workers run in auto-approve mode; pushes and pull requests stay refused.", "answer"))
      .child(toggle("fm-uncommitted", "Include uncommitted changes", "Workers start from a copy that also holds what you have not committed.", "uncommitted")));

    // Footer: key caps on the left, buttons on the right.
    body.child(h_flex().items_center().gap(8).pt(8).border_t_1().border_color(t.border)
      .child(h_flex().flex_1().min_w(0).items_center().gap(12)
        .child(hint(["Ctrl", "Enter"], "start")).child(hint(["Esc"], "cancel")))
      .child(button("fm-cancel", "Cancel", false, true, () => this.cancel()))
      .child(button("fm-start", "Start", true, ready, () => this.submit())));
    return body;
  }
}
