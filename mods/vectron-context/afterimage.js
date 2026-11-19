import { div } from "gpui-kit";

export function compactionComparison(previous, current, before, after) {
  const path = current?.path;
  if (!path || previous?.path !== path) return null;
  if (!Number.isFinite(before) || !Number.isFinite(after) || after < 0 || after >= before) return null;

  // Offsets in the selected transcript identify newly appended boundaries.
  // A fork's inherited history and Grok's rewritten summaries are separate.
  const oldEvents = previous.events ?? [];
  let lastOffset = null;
  for (let index = oldEvents.length - 1; index >= 0; index--) {
    const event = oldEvents[index];
    if (event.source === path && Number.isSafeInteger(event.offset)) {
      lastOffset = event.offset;
      break;
    }
  }
  if (lastOffset === null) return null;

  const boundary = (current.events ?? []).some(
    (event) =>
      event.source === path &&
      Number.isSafeInteger(event.offset) &&
      event.offset > lastOffset &&
      event.category === "summary" &&
      (event.field === "compact" || event.field === "claude"),
  );
  return boundary ? { before, after } : null;
}

const shrinkMs = 280;
const outlineFadeMs = 950;
const comparisonFadeMs = 270;

export class CompactionAfterimage {
  current = null;
  sequence = 0;

  clear() {
    this.current = null;
  }

  start(cx, comparison) {
    const image = { ...comparison, sequence: ++this.sequence, phase: "start" };
    this.current = image;
    const advance = (at, phase) =>
      cx.timer.after(at, (cx) => {
        if (this.current !== image) return;
        if (phase) image.phase = phase;
        else this.clear();
        cx.notify();
      });

    // Seed the old width in a frame, then let native motion shrink and fade it.
    const firstFrameMs = 40;
    const shrinkEnd = firstFrameMs + shrinkMs;
    const outlineEnd = shrinkEnd + outlineFadeMs;
    advance(firstFrameMs, "shrink");
    advance(shrinkEnd, "fade-outline");
    advance(outlineEnd, "fade-comparison");
    advance(outlineEnd + comparisonFadeMs, null);
  }
}

export function afterimageLayer(image, width, theme) {
  const ratio = image.phase === "start" ? 1 : image.after / image.before;
  const fillWidth = width ? width * ratio : `${ratio * 100}%`;
  const fading = image.phase === "fade-comparison";
  const outlineOpacity = image.phase === "start" || image.phase === "shrink" ? 0.92 : 0;
  return div()
    .id(`context-afterimage-${image.sequence}`)
    .absolute()
    .inset_0()
    .bg(theme.surface)
    .opacity(fading ? 0 : 1)
    .transition("opacity", { duration: comparisonFadeMs, easing: "ease-out" })
    .child(
      div()
        .id(`context-afterimage-fill-${image.sequence}`)
        .absolute()
        .left(0)
        .top(3)
        .bottom(3)
        .w(fillWidth)
        .bg(theme.ansi6)
        .transition("width", { duration: shrinkMs, easing: "ease-out" }),
    )
    .child(
      div()
        .id(`context-afterimage-outline-${image.sequence}`)
        .absolute()
        .inset_0()
        .rounded(3)
        .border(1)
        .border_color(theme.accent)
        .opacity(outlineOpacity)
        .transition("opacity", { duration: outlineFadeMs, easing: "ease-out" }),
    );
}
