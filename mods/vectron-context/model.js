export const categories = [
  { id: "runtime", label: "Runtime", color: "#8494b0" },
  { id: "instructions", label: "Instructions", color: "#1683ff" },
  { id: "memory", label: "Memory", color: "#f8ab59" },
  { id: "skills", label: "Skills", color: "#e2d861" },
  { id: "tools", label: "Tool definitions", color: "#b18aff" },
  { id: "environment", label: "Environment", color: "#55b4c9" },
  { id: "user", label: "You", color: "#8ed789" },
  { id: "files", label: "File reads", color: "#f239d1" },
  { id: "calls", label: "Tool calls", color: "#a6bcff" },
  { id: "results", label: "Tool results", color: "#72dac0" },
  { id: "assistant", label: "Replies", color: "#ff8c97" },
  { id: "summary", label: "Compaction", color: "#f2f54a" },
];
export const categoryOf = (id) =>
  categories.find((category) => category.id === id) ?? categories[0];

export function formatCount(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

// "Segment" is recorded evidence since the last logged compaction, with the
// latest persistent instruction/tool snapshots. It is not a reconstructed prompt.
export function selectEvents(data, cutoff = null, history = false) {
  const through = (data?.events ?? []).filter(
    (event) => cutoff === null || Number(event.id) <= cutoff,
  );
  if (history) return through;

  const segment = through.at(-1)?.segment ?? 0;
  const latestSnapshots = new Map();
  for (const event of through) {
    if (event.persistent) latestSnapshots.set(event.persistent, event.id);
  }
  return through.filter((event) => {
    if (event.persistent) return latestSnapshots.get(event.persistent) === event.id;
    return event.segment === segment;
  });
}

export function estimatedTotals(events) {
  const counts = Object.fromEntries(categories.map((category) => [category.id, 0]));
  for (const event of events) {
    counts[event.category] = (counts[event.category] ?? 0) + event.tokens;
  }
  return { counts, sum: Object.values(counts).reduce((sum, value) => sum + value, 0) };
}

export function reportedUsageAt(data, cutoff) {
  if (cutoff === null) return data?.reported;
  const samples = data?.usage_samples ?? [];
  for (let index = samples.length - 1; index >= 0; index--) {
    if (samples[index].afterId <= cutoff) return samples[index];
  }
  return null;
}

// Reader snapshots replace their event array when the transcript changes.
// Keep only the current scope and timeline so redraws reuse data, not UI elements.
export class ContextEvents {
  capture(snapshot, replayCutoff, showWholeHistory) {
    const sourceEvents = snapshot?.events;
    const cached = this.lastCapture;
    if (
      cached &&
      cached.sourceEvents === sourceEvents &&
      cached.replayCutoff === replayCutoff &&
      cached.showWholeHistory === showWholeHistory
    ) {
      return cached;
    }

    const events = selectEvents(snapshot, replayCutoff, showWholeHistory);
    this.lastCapture = {
      sourceEvents,
      replayCutoff,
      showWholeHistory,
      events,
      totals: estimatedTotals(events),
    };
    this.lastTimeline = null;
    return this.lastCapture;
  }

  timeline(events, selectedCategory, searchQuery, order) {
    const cached = this.lastTimeline;
    if (
      cached &&
      cached.events === events &&
      cached.selectedCategory === selectedCategory &&
      cached.searchQuery === searchQuery &&
      cached.order === order
    ) {
      return cached.entries;
    }

    const entries = events.filter((event) => {
      if (selectedCategory && event.category !== selectedCategory) return false;
      if (!searchQuery) return true;

      const categoryLabel = categoryOf(event.category).label;
      return `${event.label} ${event.teaser} ${categoryLabel}`.toLowerCase().includes(searchQuery);
    });

    if (order === "largest") entries.sort((a, b) => b.tokens - a.tokens);
    else entries.sort((a, b) => Number(b.id) - Number(a.id));

    this.lastTimeline = { events, selectedCategory, searchQuery, order, entries };
    return entries;
  }
}
