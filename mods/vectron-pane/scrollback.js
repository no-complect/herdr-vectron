import { div } from "gpui-kit";

const amber = "#f8ab59";

export function historyMarker(pane) {
  if (!(pane.scroll?.from_bottom > 0)) return null;

  return div()
    .id(`pane-history-${pane.pane}`)
    .h(18)
    .px(5)
    .flex_none()
    .flex()
    .items_center()
    .border_l(1)
    .border_r(1)
    .border_color(amber)
    .bg(amber + "1a")
    .text_size(10.5)
    .font_semibold()
    .text_color(amber)
    .child("History");
}
