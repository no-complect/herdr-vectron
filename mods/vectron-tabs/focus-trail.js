// Herdr loads each mod independently. Keep the pane and tab copies in sync.
import { div } from "gpui-kit";

const holdMs = 40;
const fadeMs = 680;

export class FocusTrail {
  scope = null;
  target = null;
  entries = [];
  sequence = 0;

  clear() {
    this.scope = null;
    this.target = null;
    this.entries = [];
  }

  update(scope, target) {
    if (!scope) {
      this.clear();
      return;
    }
    if (scope !== this.scope) {
      this.clear();
      this.scope = scope;
      this.target = target;
      return;
    }

    const now = Date.now();
    this.entries = this.entries.filter((entry) => entry.expiresAt > now);
    // A popup can temporarily hold focus while the pane or tab is still current.
    if (!target || target === this.target) return;
    const departed = this.target;
    this.target = target;
    this.entries = this.entries.filter((entry) => entry.target !== target);
    if (!departed) return;

    this.entries.unshift({
      target: departed,
      sequence: ++this.sequence,
      expiresAt: now + holdMs + fadeMs,
      fading: false,
      scheduled: false,
    });
    this.entries = this.entries.slice(0, 2);
  }

  layer(target, color, cx) {
    const now = Date.now();
    const entry = this.entries.find((entry) => entry.target === target && entry.expiresAt > now);
    if (!entry) return null;

    if (!entry.scheduled) {
      entry.scheduled = true;
      cx.timer.after(Math.max(1, entry.expiresAt - fadeMs - now), (cx) => {
        if (!this.entries.includes(entry)) return;
        entry.fading = true;
        cx.notify();
      });
      cx.timer.after(entry.expiresAt - now, (cx) => {
        if (!this.entries.includes(entry)) return;
        this.entries = this.entries.filter((candidate) => candidate !== entry);
        cx.notify();
      });
    }

    return div()
      .id(`focus-trail-${target}-${entry.sequence}`)
      .absolute()
      .left(0)
      .right(0)
      .bottom(0)
      .h(4)
      .opacity(entry.fading ? 0 : 0.8)
      .transition("opacity", { duration: fadeMs, easing: "ease-out" })
      .child(div().absolute().inset_0().bg(color + "40"))
      .child(div().absolute().left(0).right(0).bottom(0).h(1).bg(color));
  }
}
