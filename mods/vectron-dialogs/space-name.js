import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { run, spaces, theme } from "herdr";
import { dismiss, flashingInput } from "./controls.js";
import { InputGlow } from "./input-glow.js";

export class SpaceName {
  constructor(id, cx) {
    this.handle = cx.focus_handle();
    this.space = spaces().find((space) => id == null ? space.active : space.id === id);
    if (!this.space) {
      this.handle.focus();
      return;
    }

    this.glow = new InputGlow();
    const value = this.space.named ? this.space.name : "";
    this.input = InputState.new({ value, placeholder: "Space name" });
    if (value) this.input.set_selected_range({ start: 0, end: value.length });
    this.input.on("change", (_event, cx) => this.glow.typing(cx));
    this.input.on("submit", () => this.submit());
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
  }

  submit() {
    const name = this.input.value();
    dismiss();
    run("space.rename", { id: this.space.id, name });
  }

  render() {
    const t = theme();
    const button = (id, label, primary, action) =>
      h_flex()
        .id(id)
        .h(32)
        .px(14)
        .items_center()
        .rounded(8)
        .border_1()
        .border_color(primary ? t.solid : t.input)
        .bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : t.foreground)
        .text_size(12.5)
        .cursor_pointer()
        .hover((s) => s.opacity(0.88))
        .on_click(action)
        .child(label);

    return v_flex()
      .id("rename-space-prompt")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return;
        cx.stop_propagation();
        dismiss();
      })
      .child(div().text_size(15).font_semibold().child("Rename space"))
      .when(Boolean(this.input), (el) =>
        el
          .child(flashingInput("space-name-input", this.input, this.glow, t))
          .child(
            div().text_size(11.5).text_color(t.dim).child("Leave empty to use the folder name."),
          ),
      )
      .when(!this.input, (el) =>
        el.child(div().text_size(12).text_color(t.dim).child("No space selected.")),
      )
      .child(
        h_flex()
          .pt(6)
          .gap(8)
          .justify_end()
          .child(button("cancel-rename", "Cancel", false, dismiss))
          .when(Boolean(this.input), (el) =>
            el.child(button("save-space-name", "Save", true, () => this.submit())),
          ),
      );
  }
}
