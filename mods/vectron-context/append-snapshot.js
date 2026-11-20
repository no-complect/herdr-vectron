export function appendSnapshot(base, delta) {
  const { delta_base: _signature, ...snapshot } = delta;
  const events = [...base.events, ...delta.events];
  if (delta.recorded_events > 5000) {
    // The previous snapshot already preserves the exact groups needed here.
    const largest = [...events].sort((left, right) => right.tokens - left.tokens).slice(0, 1000);
    const kept = new Map(
      [...events.slice(-3500), ...largest, ...events.slice(0, 500)].map((event) => [event.id, event]),
    );
    snapshot.events = [...kept.values()].sort((left, right) => Number(left.id) - Number(right.id));
  } else {
    snapshot.events = events;
  }

  snapshot.all_totals = Object.fromEntries(
    Object.entries(delta.all_totals).map(([category, tokens]) => [category, base.all_totals[category] + tokens]),
  );
  snapshot.persistent = { ...base.persistent, ...delta.persistent };
  snapshot.usage_samples = [...base.usage_samples, ...delta.usage_samples].slice(-2000);
  return snapshot;
}
