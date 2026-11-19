import assert from "node:assert/strict";
import test from "node:test";
import { selectEvents, estimatedTotals, reportedUsageAt } from "../vectron-context/model.js";

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
