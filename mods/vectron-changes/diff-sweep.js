import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

const hitHeight = 10;
const sweepMs = 260;

function groupMarks({ hunks, extent }, height) {
  const slots = Math.max(1, Math.floor(height / hitHeight));
  const groups = new Map();

  for (const hunk of hunks) {
    const position = (hunk.line - 1) / Math.max(1, extent - 1);
    const slot = Math.round(position * (slots - 1));
    if (!groups.has(slot)) groups.set(slot, []);
    groups.get(slot).push(hunk);
  }

  return groups;
}

export class DiffSweep {
  height = 0;
  sequence = 0;

  reset(pending) {
    this.pending = pending;
    this.motion = null;
    this.selectedRow = null;
  }

  start(cx) {
    const motion = { id: ++this.sequence, moving: false };
    this.motion = motion;
    this.pending = false;

    // One seed frame lets the native renderer interpolate the leading edge.
    cx.timer.after(40, (cx) => {
      if (this.motion !== motion) return;
      motion.moving = true;
      cx.notify();
    });
    cx.timer.after(40 + sweepMs + 130, (cx) => {
      if (this.motion !== motion) return;
      this.motion = null;
      cx.notify();
    });
  }

  render(preview, t, cx, jump) {
    const { height } = this;
    if (height >= hitHeight && this.pending) this.start(cx);
    const motion = this.motion;

    return div()
      .id("changes-diff-sweep")
      .relative()
      .w(25)
      .h_full()
      .flex_none()
      .border_l(1)
      .border_color(t.border)
      .bg(t.surface)
      .overflow_hidden()
      .on_size_change(({ height }, cx) => {
        if (this.height === height) return;
        this.height = height;
        cx.notify();
      })
      .when(height >= hitHeight, (rail) => {
        const groups = groupMarks(preview, height);
        const slots = Math.floor(height / hitHeight);
        return rail.children([...groups].map(([slot, hunks]) => {
          const fraction = slots > 1 ? slot / (slots - 1) : 0;
          return this.mark(
            hunks, fraction * (height - hitHeight), fraction, t, motion, jump,
          );
        }));
      })
      .when(Boolean(motion), (rail) => rail.child(
        div()
          .id(`changes-sweep-beam-${motion.id}`)
          .absolute().left(0).right(0)
          .top(motion.moving ? Math.max(0, height - 2) : 0).h(2)
          .bg(t.accent)
          .transition("top", { duration: sweepMs }),
      ));
  }

  mark(hunks, top, fraction, t, motion, jump) {
    const first = hunks[0];
    const last = hunks.at(-1);
    const selected = hunks.findIndex(({ row }) => row === this.selectedRow);
    const summary = hunks.length === 1
      ? `Line ${first.line} · +${first.add} −${first.del}`
      : `${hunks.length} hunks · lines ${first.line}–${last.line} · click to cycle`;
    const line = (color) => div().h(2).w_full().bg(color);

    return h_flex()
      .id(`changes-hunks-${first.row}`)
      .absolute().left(0).right(0).top(top)
      .h(hitHeight).px(4).items_center()
      .cursor_pointer()
      .tooltip(summary)
      .when(selected >= 0, (el) => el.bg(t.accent + "30"))
      .hover((style) => style.bg(t.hover))
      .on_click((_event, cx) => {
        const current = hunks.findIndex(({ row }) => row === this.selectedRow);
        const hunk = hunks[(current + 1) % hunks.length];
        if (jump(hunk)) {
          this.selectedRow = hunk.row;
          cx.notify();
        }
      })
      .child(
        v_flex()
          .id(`changes-hunk-mark-${first.row}-${motion?.id ?? "rest"}`)
          .w_full().gap(1)
          .opacity(motion && !motion.moving ? 0.36 : 1)
          .transition("opacity", { duration: 100, delay: Math.round(fraction * sweepMs) })
          .when(hunks.some(({ add }) => add > 0), (el) => el.child(line(t.ansi2)))
          .when(hunks.some(({ del }) => del > 0), (el) => el.child(line(t.ansi1))),
      );
  }
}
