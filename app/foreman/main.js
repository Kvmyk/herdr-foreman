// foreman: describe a task, a lead agent splits it across your coding agents.
// Installed and updated by "foreman setup"; edit a copy under another name,
// a changed file is left alone. Ctrl+Enter starts, Enter adds a line, Esc cancels.
import { View, div } from "gpui-kit";
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
    this.leader = "claude";
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
    cx.spawn(async (cx) => { await this.load(); cx.notify(); });
  }

  // Draft, recent tasks, the leader, and whether a task can start at all.
  async load() {
    const read = async (name) => (await readTextFile(`${this.dir}/${name}`).catch(() => null)) ?? null;
    const [draft, recent, config] = await Promise.all([read("draft"), read("recent.json"), read("config.json")]);
    this.drafted = draft;
    this.recentText = recent;
    try { this.recent = JSON.parse(recent ?? "[]").filter((t) => typeof t === "string").slice(0, RECENT); } catch { /* start over */ }
    try { this.leader = JSON.parse(config ?? "{}").leader || "claude"; } catch { /* keep the default */ }
    if (draft?.trim() && !this.text) { this.input.set_value(draft); this.text = draft; }
    this.problem = await this.check();
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
    if (!this.files) { this.loadFiles().then(() => this.cx?.notify()); return []; }
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
    const argv = [NODE, BIN, "--backend", "app", ...(this.prefs.answer ? ["--auto-answer"] : []), ...(this.prefs.uncommitted ? ["--include-uncommitted"] : []), "--", task];
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
    this.cx = cx;
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
    // A switch row: track and knob, a title, and one line saying what it does.
    const toggle = (id, title, detail, name) => {
      const on = Boolean(this.prefs[name]);
      return h_flex().id(id).items_center().gap(12).py(4).cursor_pointer()
        .on_click(() => { this.prefs = { ...this.prefs, [name]: !on }; cx.notify(); })
        .child((on ? h_flex().justify_end() : h_flex().justify_start()).w(32).h(18).p(2).flex_shrink_0().rounded_full().items_center().bg(on ? t.solid : t.input).border_1().border_color(on ? t.solid : t.border)
          .child(div().w(12).h(12).rounded_full().bg(on ? t.solid_foreground : t.muted)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12.5).text_color(t.foreground).child(title))
          .child(div().text_size(11).text_color(t.dim).child(detail)));
    };
    const chip = (id, text, color, action) => div().id(id).px(10).py(4).rounded_full().bg(t.raised).border_1().border_color(t.border)
      .text_size(11.5).text_color(color).truncate().cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action).child(text);

    const branch = this.branch();
    const hints = this.hints();
    const body = v_flex().id("foreman").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().h_full().min_h(0).p(24).gap(16).bg(t.popover).text_color(t.foreground);

    // Header: mark, title with subtitle, and the leader that will run the task.
    body.child(h_flex().items_center().gap(12)
      .child(div().w(32).h(32).flex_shrink_0().rounded(8).bg(t.solid).flex().items_center().justify_center()
        .text_size(17).font_semibold().text_color(t.solid_foreground).child("f"))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(15).font_semibold().child("New task"))
        .child(div().text_size(11.5).text_color(t.dim).child("A lead agent splits it across your coding agents.")))
      .child(pill(div().text_size(11).text_color(t.dim).child("leader"), div().text_color(t.foreground).child(this.leader))));

    // Where it will run: the folder is cut from the left, its end says which project it is.
    body.child(h_flex().items_center().gap(8)
      .child(h_flex().flex_1().min_w(0).items_center().gap(6).px(8).py(4).rounded(6).bg(t.raised).border_1().border_color(this.where ? t.border : t.blocked)
        .child(div().flex_shrink_0().text_size(11.5).text_color(t.dim).child("in"))
        .child(div().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_ellipsis_start().text_size(11.5).text_color(this.where ? t.muted : t.blocked).child(this.where ?? "no folder")))
      .children(branch ? [pill(div().text_color(t.dim).child("branch"), div().text_color(t.foreground).child(clip(branch, 28)))] : []));

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
