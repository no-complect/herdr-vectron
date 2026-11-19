import { div } from "gpui-kit";
import { h_flex, Input } from "gpui-base";
import { closeOverlay, props } from "herdr";

export function dismiss() {
  const id = props()?.overlay;
  if (id) closeOverlay(id);
}

export function flashingInput(id, input, glow, theme) {
  return h_flex()
    .id(id)
    .relative()
    .h(36)
    .flex_none()
    .px(10)
    .items_center()
    .rounded(9)
    .border_1()
    .border_color(theme.accent)
    .bg(theme.background)
    .child(glow.layer())
    .child(Input.new(input).flex_1().h_full().text_size(12.8).text_color(theme.foreground));
}

export function menuRow(t, id, icon, label, choose, { hint = "", enabled = true, selected = false } = {}) {
  return h_flex()
    .id(id)
    .h(31)
    .px(9)
    .gap(10)
    .rounded(7)
    .items_center()
    .flex_none()
    .text_color(enabled ? t.foreground : t.dim)
    .when(selected, (el) => el.bg(t.selected))
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)))
    .on_click(() => {
      if (enabled) choose();
    })
    .child(icon)
    .child(div().flex_1().min_w(0).truncate().child(label))
    .child(div().text_size(11).text_color(t.dim).child(hint));
}
