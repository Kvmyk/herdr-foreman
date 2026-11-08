// foreman: describe a task, a lead agent splits it across your coding agents.
// Installed and updated by "foreman setup"; edit a copy under another name,
// a changed file is left alone. Enter or Ctrl+Enter starts, Esc cancels.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, focused, panes, notify } from "herdr";

// Filled in by "foreman setup" with this machine's node and foreman paths.
const NODE = "__NODE__";
const BIN = "__BIN__";

// Where the focused terminal is now, else where its space was made.
function folder() {
  const f = focused();
  if (f?.cwd) return f.cwd;
  const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space?.folder || null;
}

export default class Foreman extends View {
  init(_props, cx) {
    this.text = "";
    this.input = TextareaState.new({ placeholder: "What should be done?", rows: 6 });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  submit() {
    const task = this.text.trim();
    const p = props();
    if (!task) { closeOverlay(p.overlay); return; }
    const f = focused();
    const where = folder();
    closeOverlay(p.overlay);
    if (!where) { notify({ title: "foreman", body: "Open a terminal in your project folder first.", level: "warning" }); return; }
    // A terminal of its own: no time limit, and foreman opens the leader tab, then ends.
    run("tab.new", { name: "foreman", space: f?.space, folder: where, argv: [NODE, BIN, "--backend", "app", "--", task] });
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("foreman").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("foreman: new task"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(6).pb(10).text_size(11.5).text_color(t.dim).child(folder() ?? ""))
      .child(Textarea.new(this.input).h(150).p(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(16).gap(8).justify_end()
        .child(button("fm-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("fm-start", "Start", true, () => this.submit())));
  }
}
