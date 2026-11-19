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

const comparisonMs = 1540;

export class CompactionAfterimage {
  current = null;

  clear() {
    this.current = null;
  }

  start(cx, comparison) {
    this.current = comparison;
    cx.timer.after(comparisonMs, (cx) => {
      if (this.current !== comparison) return;
      this.clear();
      cx.notify();
    });
  }
}
