import { div } from "gpui-kit";

const holdMs = 65;
const fadeMs = 90;
const finalFadeMs = 245;

function echoGap() {
  return 150 + Math.floor(Math.random() * 126);
}

// JavaScript starts the three flashes. GPUI animates each fade on its own.
export class Flash {
  sequence = 0;
  burst = null;

  start(cx, targets, { alreadyRendering = false } = {}) {
    if (!targets.size) return;
    const medium = echoGap();
    const stages = [
      { at: 0, opacity: 1 },
      { at: medium, opacity: 0.64 },
      { at: medium + echoGap(), opacity: 0.36 },
    ];
    const started = Date.now();
    const burst = { targets, sequence: ++this.sequence, index: 0, opacity: 1 };
    this.burst = burst;
    if (!alreadyRendering) cx.notify();

    cx.spawn(async (cx) => {
      for (const [index, stage] of stages.entries()) {
        if (index) {
          await cx.sleep(Math.max(1, started + stage.at - Date.now()));
          if (this.burst !== burst) return;
          burst.index = index;
          burst.opacity = stage.opacity;
          cx.notify();
        }
        await cx.sleep(holdMs);
        if (this.burst !== burst) return;
        burst.opacity = 0;
        cx.notify();
      }
      await cx.sleep(finalFadeMs + 30);
      if (this.burst === burst) {
        this.burst = null;
        cx.notify();
      }
    });
  }

  layer(key, shape = "control") {
    const burst = this.burst;
    const target = burst?.targets.get(key);
    if (!target) return div().absolute().w(0).h(0);
    const { color, from = 0 } = typeof target === "string" ? { color: target } : target;

    const id = "vector-flash-" + key + "-" + burst.sequence + "-" + burst.index;
    const paint = (part) =>
      div()
        .id(id + "-" + part)
        .absolute()
        .opacity(burst.opacity)
        .transition("opacity", {
          duration: burst.index === 2 ? finalFadeMs : fadeMs,
          easing: "ease-out",
        });
    const light = div().absolute().inset_0();
    if (shape === "fill") {
      return light
        .child(
          paint("color")
            .inset_0()
            .left(from)
            .bg(color + "c4"),
        )
        .child(paint("core").inset_0().left(from).bg("#f6f8ff66"));
    }
    if (shape === "frame") {
      const edges = (part, width, tint) => [
        paint(part + "-top")
          .top(0)
          .left(0)
          .right(0)
          .h(width)
          .bg(tint),
        paint(part + "-bottom")
          .bottom(0)
          .left(0)
          .right(0)
          .h(width)
          .bg(tint),
        paint(part + "-left")
          .left(0)
          .top(0)
          .bottom(0)
          .w(width)
          .bg(tint),
        paint(part + "-right")
          .right(0)
          .top(0)
          .bottom(0)
          .w(width)
          .bg(tint),
      ];
      return light
        .children(edges("halo", 7, color + "58"))
        .children(edges("color", 3, color))
        .children(edges("core", 1, "#f6f8ff"));
    }
    return light
      .child(
        paint("wash")
          .inset_0()
          .bg(color + "65"),
      )
      .child(
        paint("outline")
          .inset_0()
          .border(2)
          .border_color(color + "dd"),
      )
      .child(
        paint("halo")
          .left(0)
          .right(0)
          .bottom(0)
          .h(5)
          .bg(color + "c4"),
      )
      .child(paint("core").left(0).right(0).bottom(0).h(2).bg("#f6f8ff"));
  }
}

export function flashColor(last, theme) {
  const colors = [theme.accent, theme.ansi4, theme.ansi5, theme.ansi6].filter(
    (color) => /^#[0-9a-f]{6}$/i.test(color) && color !== last,
  );
  return colors[Math.floor(Math.random() * colors.length)] ?? "#1683ff";
}
