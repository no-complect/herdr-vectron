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

test("the comparison expires once and old timers cannot clear a newer comparison", () => {
  const image = new CompactionAfterimage();
  const timers = [];
  const cx = { notify() {}, timer: { after: (_ms, callback) => timers.push(callback) } };
  const flush = () => timers.splice(0).forEach((callback) => callback(cx));

  image.start(cx, { before: 800, after: 100 });
  image.start(cx, { before: 900, after: 200 });
  const next = image.current;
  timers.shift()(cx);
  assert.equal(image.current, next);
  timers.shift()(cx);
  assert.equal(image.current, null);

  image.start(cx, { before: 900, after: 200 });
  image.clear();
  flush();
  assert.equal(image.current, null);
});

test("the Context caption compares estimates only in the live Since compact view", async () => {
  const noop = () => {};
  const theme = { surface: "#081022", accent: "#f2f54a", ansi6: "#72dac0" };
  const { default: ContextInspector } = await loadMod("vectron-context", "main.js", {
    herdr: {
      appHome: noop, exec: noop, focused: noop, panes: noop, terminals: noop,
      layout: noop, props: noop, theme: () => theme, settings: noop, shared: noop,
      openOverlay: noop, closeOverlay: noop,
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
  const showsComparison = () =>
    Boolean(find(view.breakdown(totals), (node) => node.nodes.includes("~800 → ~100 tokens")));
  assert.equal(showsComparison(), false);
  view.flashUpdatedCounts(cx, before, after);
  assert.equal(showsComparison(), true);

  view.replayCutoff = 90;
  assert.equal(showsComparison(), false);
  view.replayCutoff = null;
  view.showWholeHistory = true;
  assert.equal(showsComparison(), false);
  view.afterimage.clear();
  view.flashUpdatedCounts(cx, before, after);
  assert.equal(view.afterimage.current, null);
});
