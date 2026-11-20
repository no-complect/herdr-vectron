import { div, svg } from "gpui-kit";

const logo = () => svg("mods/vectron-bar/vectron.svg").size(14).flex_none();
const seenKey = "vectron.cabinet-intro";
const drawMs = 230;
const sweepMs = 320;

export class CabinetIntro {
  measure(width, cx) {
    this.width = width;
    if (this.started || width <= 0 || sessionStorage.getItem(seenKey)) return;

    this.started = true;
    sessionStorage.setItem(seenKey, "1");
    this.phase = "start";
    cx.notify();

    const advance = (ms, phase) => cx.timer.after(ms, (cx) => {
      this.phase = phase;
      cx.notify();
    });
    advance(40, "draw");
    advance(40 + drawMs, "sweep");
    advance(40 + drawMs + sweepMs + 90, null);
  }

  logo(t) {
    if (!this.phase) return logo();

    // Clip a stationary glyph so the bright stroke follows the original artwork.
    return div().relative().size(14).flex_none().child(
      div()
        .id("cabinet-logo-reveal")
        .absolute().top(0).left(0).w(14)
        .h(this.phase === "start" ? 0 : 14)
        .overflow_hidden()
        .text_color(this.phase === "sweep" ? t.accent : t.foreground)
        .transition("height", { duration: drawMs, easing: "ease-out" })
        .child(logo()),
    );
  }

  sweep(t, start) {
    if (!this.phase || this.phase === "start" || this.width <= start + 24) return null;

    const moving = this.phase === "sweep";
    return div()
      .id("cabinet-sweep")
      .absolute().bottom(0).w(24).h(2)
      .left(moving ? this.width - 24 : start)
      .bg(t.accent)
      .opacity(moving ? 0 : 1)
      .transition("left", { duration: sweepMs, easing: "ease-out" })
      .transition("opacity", { duration: sweepMs, delay: 90, easing: "ease-in" });
  }
}
