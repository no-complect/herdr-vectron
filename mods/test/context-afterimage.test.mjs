import assert from "node:assert/strict";
import test from "node:test";
import { find, loadMod } from "./support/herdr.mjs";

const { CompactionAfterimage, compactionComparison } = await loadMod("vectron-context", "afterimage.js");

const source = "/fixture/session.jsonl";
const event = (offset, category, tokens, segment, field = "", file = source) => ({
  id: String(offset), source: file, offset, category, tokens, segment, field,
});
const before = { path: source, events: [event(90, "user", 800, 0)] };
const after = {
  path: source,
  events: [...before.events, event(250, "summary", 20, 1, "compact"), event(300, "user", 80, 1)],
};

test("only newer Codex or Claude compaction records with a smaller estimate produce a comparison", () => {
  assert.deepEqual({ ...compactionComparison(before, after, 800, 100) }, { before: 800, after: 100 });
  const marker = (field, file = source, offset = 250) => ({
    path: source, events: [event(offset, "summary", 0, 1, field, file)],
  });
  assert.deepEqual({ ...compactionComparison(before, marker("claude"), 800, 0) }, { before: 800, after: 0 });
  assert.equal(compactionComparison(before, after, 800, 800), null);
  assert.equal(compactionComparison(before, { ...after, path: "/other" }, 800, 100), null);
  assert.equal(compactionComparison(before, marker("compact", "/inherited"), 800, 100), null);
  assert.equal(compactionComparison(before, marker("compact", source, 70), 800, 100), null);
  assert.equal(compactionComparison(before, marker("grok:content"), 800, 100), null);
  assert.equal(compactionComparison(before, { ...after, events: [event(300, "user", 100, 1)] }, 800, 100), null);
  assert.equal(compactionComparison(after, after, 800, 100), null);
});

test("afterimage stages finish once and timers cannot change a replacement or cleared image", () => {
  const image = new CompactionAfterimage();
  const timers = [];
  const cx = { notify() {}, timer: { after: (_ms, callback) => timers.push(callback) } };
  const flush = () => timers.splice(0).forEach((callback) => callback(cx));

  image.start(cx, { before: 800, after: 100 });
  const first = image.current;
  assert.equal(first.phase, "start");
  image.start(cx, { before: 900, after: 200 });
  const next = image.current;
  timers.splice(0, 4).forEach((callback) => callback(cx));
  assert.equal(image.current, next);
  assert.equal(next.phase, "start");
  for (const phase of ["shrink", "fade-outline", "fade-comparison"]) {
    timers.shift()(cx);
    assert.equal(image.current.phase, phase);
  }
  timers.shift()(cx);
  assert.equal(image.current, null);

  image.start(cx, { before: 900, after: 200 });
  image.clear();
  flush();
  assert.equal(image.current, null);
});

test("the Context bar shows the comparison at its original height and keeps whole-history and replay static", async () => {
  const noop = () => {};
  const theme = { surface: "#081022", accent: "#f2f54a", ansi6: "#72dac0" };
  const { default: ContextInspector } = await loadMod("vectron-context", "main.js", {
    herdr: {
      appHome: noop, exec: noop, focused: noop, panes: noop, terminals: noop,
      layout: noop, props: noop, theme: () => theme, settings: noop, shared: noop,
      openOverlay: noop, closeOverlay: noop, watchFolder: noop,
    },
  });
  const timers = [];
  const cx = { notify: noop, timer: { after: (_ms, callback) => timers.push(callback) } };
  const view = new ContextInspector();
  view.controlsFlash = { layer: noop };
  view.dataFlash = { layer: noop, start: noop };
  view.showWholeHistory = false;
  view.replayCutoff = null;
  view.width = 450;
  const totals = { counts: { user: 80, summary: 20 }, sum: 100 };
  const byId = (tree, id) => find(tree, (node) => node.calls.id?.[0] === id);
  const initial = view.breakdown(totals);
  byId(initial, "context-category-bar").calls.on_size_change[0]({ width: 280 }, cx);

  view.flashUpdatedCounts(cx, before, after);
  const start = view.breakdown(totals);
  assert.equal(byId(start, "context-category-bar").calls.h[0], 18);
  assert.equal(byId(start, "context-afterimage-fill-1").calls.w[0], 280);
  assert.ok(find(start, (node) => node.nodes.includes("~800 → ~100 tokens")));
  timers.shift()(cx);
  const shrink = view.breakdown(totals);
  assert.equal(byId(shrink, "context-afterimage-fill-1").calls.w[0], 35);
  assert.equal(byId(shrink, "context-afterimage-outline-1").calls.opacity[0], 0.92);

  view.replayCutoff = 90;
  assert.equal(byId(view.breakdown(totals), "context-afterimage-fill-1"), undefined);
  view.replayCutoff = null;
  view.showWholeHistory = true;
  assert.equal(byId(view.breakdown(totals), "context-afterimage-fill-1"), undefined);
  view.afterimage.clear();
  view.flashUpdatedCounts(cx, before, after);
  assert.equal(view.afterimage.current, null);
});
