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
  const segment = through.at(-1)?.segment ?? 0;
  const latestSnapshots = new Map();
  for (const event of through) {
    if (event.persistent) latestSnapshots.set(event.persistent, event.id);
  }
  if (history) return through;
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
  return (data?.usage_samples ?? []).filter((sample) => sample.afterId <= cutoff).at(-1) ?? null;
}
