import { div } from "gpui-kit";
import { focused, run } from "herdr";
import { Flash } from "./beam.js";

const amber = "#f8ab59";
const returnLight = new Map([["scrollback", amber]]);

function focusedTerminal(pane) {
  const focus = focused();
  return focus?.pane === pane ? (focus.shown ?? focus.terminal) : null;
}

export class ScrollbackIndicator {
  #terminal = null;
  #inHistory = false;
  #flash = new Flash();

  observe(pane, cx) {
    const distance = pane?.scroll?.from_bottom;
    const inHistory = distance > 0;
    const terminal = pane?.focused && pane.terminal ? focusedTerminal(pane.pane) : null;
    const sameTerminal = terminal && terminal === this.#terminal;

    if (!sameTerminal || distance !== 0) this.#flash.burst = null;
    if (sameTerminal && this.#inHistory && distance === 0) {
      this.#flash.start(cx, returnLight, { alreadyRendering: true });
    }

    this.#terminal = terminal;
    this.#inHistory = inHistory;
    return inHistory ? this.#marker(pane.pane, terminal) : null;
  }

  clear() {
    this.#terminal = null;
    this.#inHistory = false;
    this.#flash.burst = null;
  }

  layer() {
    return this.#flash.layer("scrollback");
  }

  #marker(pane, terminal) {
    const marker = div()
      .id(`pane-history-${pane}`)
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

    // Herdr exposes a pane's replacement terminal through focused().shown.
    if (!terminal) return marker.tooltip("Focus the terminal to return to live output");

    return marker
      .tooltip("Return to live output")
      .cursor_pointer()
      .hover((style) => style.bg(amber + "33"))
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => {
        cx.stop_propagation();
        if (focusedTerminal(pane) === terminal) run("terminal.scroll", { terminal, to: "bottom" });
      });
  }
}
