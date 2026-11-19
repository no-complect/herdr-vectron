import assert from "node:assert/strict";
import test from "node:test";
import { ContextEvents, selectEvents, estimatedTotals, reportedUsageAt } from "../vectron-context/model.js";

const session = {
  events: [
    { id: "0", category: "instructions", tokens: 20, segment: 0, persistent: "guidance" },
    { id: "1", category: "results", tokens: 100, segment: 0 },
    { id: "2", category: "instructions", tokens: 30, segment: 0, persistent: "guidance" },
    { id: "3", category: "summary", tokens: 10, segment: 1 },
    { id: "4", category: "user", tokens: 5, segment: 1 },
  ],
  reported: { input: 800, cached: 600, window: 1000 },
  usage_samples: [
    { afterId: 1, input: 500 },
    { afterId: 4, input: 800 },
  ],
};

test("compaction retains only the latest persistent snapshot", () => {
  assert.deepEqual(
    selectEvents(session).map((event) => event.id),
    ["2", "3", "4"],
  );
  assert.equal(estimatedTotals(selectEvents(session)).sum, 45);
});

test("historical replay uses only evidence recorded by its cutoff", () => {
  assert.deepEqual(
    selectEvents(session, 1).map((event) => event.id),
    ["0", "1"],
  );
  assert.equal(reportedUsageAt(session, 2).input, 500);
  assert.equal(reportedUsageAt(session, 0), null);
});

test("whole history includes earlier segments", () => {
  assert.equal(estimatedTotals(selectEvents(session, null, true)).sum, 165);
});

test("reported usage stays independent of category estimates and cached input", () => {
  const estimate = estimatedTotals(selectEvents(session)).sum;
  assert.notEqual(estimate, reportedUsageAt(session, null).input);
  assert.equal(reportedUsageAt(session, null).input, 800);
});

test("captured totals are reused until events, replay point, or history scope changes", () => {
  const context = new ContextEvents();
  const live = context.capture(session, null, false);
  const metadataRefresh = { ...session, match: "Session identifier" };
  assert.equal(context.capture(metadataRefresh, null, false), live);

  const replay = context.capture(session, 0, false);
  assert.deepEqual(replay.events.map(({ id }) => id), ["0"]);
  assert.equal(replay.totals.sum, 20);

  const history = context.capture(session, null, true);
  assert.equal(history.totals.sum, 165);
  const updated = { ...session, events: session.events.slice(0, 2) };
  assert.equal(context.capture(updated, null, true).totals.sum, 120);
});

test("timeline reuses unchanged results and reacts to filters, ordering, and new events", () => {
  const events = [
    { id: "2", tokens: 12, category: "files", label: "Read source", teaser: "sample" },
    { id: "9", tokens: 12, category: "files", label: "Read more", teaser: "sample" },
    { id: "10", tokens: 5, category: "user", label: "Sample prompt", teaser: "question" },
  ];
  const context = new ContextEvents();
  const largest = context.timeline(events, null, "", "largest");
  assert.deepEqual(largest.map(({ id }) => id), ["2", "9", "10"]);
  assert.equal(context.timeline(events, null, "", "largest"), largest);
  assert.deepEqual(
    context.timeline(events, null, "", "timeline").map(({ id }) => id),
    ["10", "9", "2"],
  );
  assert.deepEqual(
    context.timeline(events, "files", "file reads", "timeline").map(({ id }) => id),
    ["9", "2"],
  );
  assert.deepEqual(context.timeline(events, "files", "question", "timeline"), []);
  assert.deepEqual(context.timeline(events.slice(2), null, "sample", "timeline"), [events[2]]);
});
