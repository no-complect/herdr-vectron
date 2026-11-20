import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { find, loadMod } from "./support/herdr.mjs";

const noop = () => {};
const theme = {
  ansi6: "#72dac0", accent: "#f2f54a", foreground: "#e2e8f0", border: "#1b5592",
};
const clock = (time) => ({ Date: { now: () => time.now } });
const byId = (tree, id) => find(tree, (node) => node.calls.id?.[0] === id);

function timeline() {
  const timers = [];
  const cx = {
    notify: noop, spawn: noop,
    timer: { after: (_ms, callback) => timers.push(callback), every: noop },
  };
  return { cx, timers };
}

test("both mod bundles use the same focus trail behavior", async () => {
  const load = (mod) => readFile(new URL(`../${mod}/focus-trail.js`, import.meta.url), "utf8");
  const [pane, tabs] = await Promise.all([load("vectron-pane"), load("vectron-tabs")]);
  assert.equal(pane, tabs);
});

test("the trail remembers the last two departures, clears on scope changes, and ignores non-pane focus", async () => {
  const time = { now: 1000 };
  const { FocusTrail } = await loadMod("vectron-pane", "focus-trail.js", {}, clock(time));
  const trail = new FocusTrail();
  const ids = () => Array.from(trail.entries, ({ target }) => target);
  trail.update("tab-1", "p1");
  trail.update("tab-1", null);
  assert.deepEqual(ids(), []);

  trail.update("tab-1", "p2");
  trail.update("tab-1", "p3");
  trail.update("tab-1", "p4");
  assert.deepEqual(ids(), ["p3", "p2"]);
  trail.update("tab-1", "p2");
  assert.deepEqual(ids(), ["p4", "p3"]);
  trail.update("tab-1", "p2");
  assert.deepEqual(ids(), ["p4", "p3"]);

  time.now += 800;
  trail.update("tab-1", "p2");
  assert.deepEqual(ids(), []);
  trail.update("tab-1", "p3");
  trail.update("tab-2", "other-pane");
  assert.deepEqual(ids(), []);
});

test("the trace fades once and an old timer cannot change a newer trace for the same frame", async () => {
  const { FocusTrail } = await loadMod("vectron-tabs", "focus-trail.js", {}, clock({ now: 1000 }));
  const trail = new FocusTrail();
  const { cx, timers } = timeline();
  trail.update("space-1", "t1");
  trail.update("space-1", "t2");
  const first = trail.layer("t1", theme.ansi6, cx);
  assert.ok(first.calls.opacity[0] > 0);
  assert.equal(trail.layer("t2", theme.ansi6, cx), null);
  trail.layer("t1", theme.ansi6, cx);
  assert.equal(timers.length, 2);

  trail.update("space-1", "t1");
  trail.update("space-1", "t3");
  const replacement = trail.layer("t1", theme.ansi6, cx);
  assert.notEqual(first.calls.id[0], replacement.calls.id[0]);
  timers.splice(0, 2).forEach((callback) => callback(cx));
  assert.equal(trail.layer("t1", theme.ansi6, cx).calls.opacity[0], replacement.calls.opacity[0]);
  timers.shift()(cx);
  assert.equal(trail.layer("t1", theme.ansi6, cx).calls.opacity[0], 0);
  timers.shift()(cx);
  assert.equal(trail.layer("t1", theme.ansi6, cx), null);
});

test("pane headers paint a trail for departed focus within their tab and clear it across tabs", async () => {
  const time = { now: 1000 };
  const { cx } = timeline();
  let focus = { pane: "p1", tab: "tab-1" };
  const pane = { pane: "p1", tab: "tab-1", terminal: "t1", title: "First pane" };
  const { default: Pane } = await loadMod("vectron-pane", "main.js", {
    herdr: {
      panes: () => [{ ...pane, focused: focus.pane === pane.pane }],
      focused: () => focus,
      props: () => ({ pane: pane.pane }),
      theme: () => theme,
      home: () => "/fixture",
      run: noop, exec: noop, layout: noop, shared: noop, setShared: noop,
      window: noop, appHome: noop, watchFolder: noop, readTextFile: noop,
    },
  }, clock(time));
  const header = new Pane();
  header.init({}, cx);
  assert.equal(byId(header.render(cx), "focus-trail-p1-1"), undefined);
  focus = { pane: "p2", tab: "tab-1" };
  assert.ok(byId(header.render(cx), "focus-trail-p1-1"));
  focus = { pane: "x", tab: "tab-2" };
  assert.equal(byId(header.render(cx), "focus-trail-p1-1"), undefined);
});

test("tab switches leave a trail and pane focus changes keep the current tab’s accent", async () => {
  const { cx } = timeline();
  let active = "t1";
  let shell = "pane-1";
  let space = "s1";
  const model = () => [{
    id: space, active: true,
    tabs: ["t1", "t2", "t3"].map((id) => ({ id, name: id, active: id === active })),
  }];
  const { default: Tabs } = await loadMod("vectron-tabs", "main.js", {
    herdr: {
      spaces: model,
      panes: () => model()[0].tabs.map(({ id }) => ({
        tab: id, terminal: `${id}-shell`, title: "Shell", program: { name: "Shell", shell: true },
      })),
      terminals: () => [],
      focused: () => ({ terminal: shell }),
      props: () => ({}), theme: () => theme,
      run: noop, layout: noop, shared: noop, setShared: noop, openOverlay: noop,
      exec: noop, readTextFile: noop, home: noop, appHome: noop, nextCommand: noop, notify: noop,
    },
  }, { localStorage: { getItem: () => null }, ...clock({ now: 1000 }) });
  const tabs = new Tabs();
  tabs.init({}, cx);
  tabs.render(cx);
  shell = "pane-2";
  assert.equal(byId(tabs.render(cx), "focus-trail-t1-1"), undefined);
  active = "t2";
  const strip = tabs.render(cx);
  assert.ok(byId(strip, "focus-trail-t1-1"));
  assert.ok(find(byId(strip, "tab-t2"), (node) => node.calls.bg?.[0] === theme.accent));
  space = "s2";
  assert.equal(byId(tabs.render(cx), "focus-trail-t1-1"), undefined);
});

test("a split lights the new header in its requested direction and ignores existing panes", async () => {
  const { cx, timers } = timeline();
  const time = { now: 1000 };
  const values = new Map();
  const calls = [];
  const source = { pane: "p1", tab: "t1", terminal: "s1", focused: true };
  const added = { pane: "p2", tab: "t1", terminal: "s2", focused: false };
  const panes = [source];
  let current = source;
  const { default: Pane } = await loadMod("vectron-pane", "main.js", {
    herdr: {
      panes: () => panes, focused: () => current, props: () => current,
      theme: () => theme, home: () => "/fixture",
      run: (command, args) => calls.push([command, { ...args }]),
      shared: (key) => values.get(key), setShared: (key, value) => values.set(key, value),
      exec: noop, layout: noop, window: noop, appHome: noop, watchFolder: noop, readTextFile: noop,
    },
  }, clock(time));

  const header = new Pane();
  header.init({}, cx);
  header.hovered = true;
  const view = header.render(cx);
  const beam = (tree) => find(tree, (node) => node.calls.id?.[0].startsWith("split-beam-"));
  const initialTimers = timers.length;
  byId(view, "ph-d-p1").calls.on_click[0](null, { ...cx, stop_propagation: noop });
  assert.deepEqual(calls, [["pane.split", { direction: "down", pane: "p1" }]]);
  assert.equal(beam(header.render(cx)), undefined);
  panes.push(added);
  current = added;
  const newHeader = new Pane();
  newHeader.init({}, cx);
  const first = newHeader.render(cx);
  assert.equal(beam(first)?.calls.w[0], 0);
  first.calls.on_size_change[0]({ width: 320, height: 30 }, cx);
  timers[initialTimers](cx);
  assert.equal(beam(newHeader.render(cx))?.calls.w[0], 320);
  timers.slice(initialTimers + 1).forEach((fire) => fire(cx));
  assert.equal(beam(newHeader.render(cx)), undefined);
});
