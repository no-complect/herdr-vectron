import { div } from "gpui-kit";
import { shared } from "herdr";
import { splitKey } from "./split-intent.js";

const drawMs = 210;
const fadeMs = 190;

export class SplitBeam {
  measure({ width, height }, cx) {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    if (this.current) cx.notify();
  }

  observe(pane, all, cx) {
    const split = shared(splitKey);
    if (!split || split.id === this.seen || split.tab !== pane.tab || split.expiresAt < Date.now()) return;
    if (split.before.includes(pane.pane) || !all.some((item) => item.pane === split.source)) return;

    this.seen = split.id;
    const current = { ...split, phase: "start" };
    this.current = current;
    const advance = (ms, phase) => cx.timer.after(ms, (cx) => {
      if (this.current !== current) return;
      if (phase) current.phase = phase;
      else this.current = null;
      cx.notify();
    });
    advance(40, "draw");
    advance(40 + drawMs, "fade");
    advance(40 + drawMs + fadeMs, null);
  }

  layer(t) {
    const beam = this.current;
    if (!beam) return null;

    const down = beam.direction === "down";
    const extent = down ? this.width : this.height;
    const length = beam.phase === "start" ? 0 : (extent ?? 0);
    return div()
      .id(`split-beam-${beam.id}`)
      .absolute()
      .left(0)
      .top(0)
      .overflow_hidden()
      .when(down, (el) => el.h(3).w(length))
      .when(!down, (el) => el.w(3).h(length))
      .bg(t.ansi6)
      .opacity(beam.phase === "fade" ? 0 : 1)
      .transition(down ? "width" : "height", { duration: drawMs, easing: "ease-out" })
      .transition("opacity", { duration: fadeMs, easing: "ease-out" })
      .child(
        div().absolute().top(0).left(0)
          .when(down, (el) => el.h(1).w_full())
          .when(!down, (el) => el.w(1).h_full())
          .bg(t.foreground),
      );
  }
}
