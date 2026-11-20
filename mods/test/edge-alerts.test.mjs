import assert from "node:assert/strict";
import test from "node:test";
import { find, loadMod } from "./support/herdr.mjs";

function agent(address, status, seq = 0) {
  return { address, status, seq, title: address, pane: address + "-pane", tab: "tab", space: "other", space_name: "Other space" };
}

async function topBar(agents) {
  const state = { agents, focus: { terminal: "shell", shown: null } };
  const shared = new Map();
  const session = new Map();
  const timers = [];
  const actions = [];
  const noop = () => {};
  const cx = {
    spawn: noop,
    notify: noop,
    stop_propagation: noop,
    timer: { after: (_ms, callback) => timers.push(() => callback(cx)) },
  };
  const { default: Bar } = await loadMod("vectron-bar", "main.js", {
    herdr: {
      agents: () => state.agents,
      focused: () => state.focus,
      layout: () => state.layout, window: () => state.window,
      home: noop, readTextFile: noop, appHome: noop, exec: noop,
      spaces: () => [{ id: "other", active: true, name: "Other space", tabs: [] }],
      props: () => ({ part: "left" }),
      theme: () => ({ blocked: "#ff5775", done: "#7ab5ff" }),
      shared: (key) => shared.get(key), setShared: (key, value) => shared.set(key, value),
      run: (name, args) => actions.push([name, { ...args }]),
    },
  }, {
    sessionStorage: { getItem: (key) => session.get(key), setItem: (key, value) => session.set(key, value) },
    window: { viewport_size: () => ({ width: 1400 }) },
  });
  const bar = new Bar();
  bar.init({}, cx);
  return {
    actions, state, timers, cx, shared, start: () => new Bar(),
    frame: () => bar.render(cx),
    render() {
      const view = bar.render(cx);
      return {
        blocked: find(view, (node) => node.calls.id?.[0] === "edge-alert-blocked"),
        done: find(view, (node) => node.calls.id?.[0] === "edge-alert-done"),
        pulse: find(view, (node) => node.calls.id?.[0].startsWith("edge-pulse-")),
      };
    },
  };
}

test("the top edge groups pending states and opens the newest background agent", async () => {
  const { render, frame, actions, cx, state, timers, shared } = await topBar([
    agent("latest-block", "blocked", 10),
    agent("old-block", "blocked", 1),
    agent("completed", "done", 12),
    agent("visible", "blocked", 13),
    agent("running", "working", 14),
  ]);
  state.focus.shown = "visible";
  const { blocked, done, pulse } = render();
  assert.match(blocked.calls.tooltip[0], /2 agents need input.*latest-block/s);
  assert.match(done.calls.tooltip[0], /completed/);
  assert.equal(pulse, undefined);
  assert.equal(timers.length, 0);

  blocked.calls.on_click[0](null, cx);
  done.calls.on_click[0](null, cx);
  assert.equal(shared.get("vectron.edge-arrival")?.terminal, "completed");
  assert.deepEqual(actions, [
    ["agent.focus", { terminal: "latest-block" }],
    ["agent.focus", { terminal: "completed" }],
  ]);

  state.focus = { terminal: "completed", space: "other", tab: "tab", pane: "completed-pane" };
  const arrival = (tree) => find(tree, (node) => node.calls.id?.[0].startsWith("edge-arrival-space-"));
  assert.deepEqual(arrival(frame())?.nodes, ["✓"]);
  timers[0]();
  timers[1]();
  assert.ok(arrival(frame()), "an earlier click cannot remove the newer marker");
  timers.at(-1)();
  assert.equal(arrival(frame()), undefined);

  state.agents = [agent("latest-block", "working"), agent("old-block", "blocked")];
  blocked.calls.on_click[0](null, cx);
  assert.equal(actions.length, 2);
  assert.match(render().blocked.calls.tooltip[0], /old-block/);
  assert.equal(render().done, undefined);
});

test("only a new background attention state pulses, with no replay on redraw or focus change", async () => {
  const { render, state, timers } = await topBar([agent("agent", "working")]);
  assert.deepEqual(render(), { blocked: undefined, done: undefined, pulse: undefined });
  state.agents = [agent("agent", "blocked", 2)];
  const first = render();
  assert.ok(first.pulse);
  assert.equal(render().pulse.calls.id[0], first.pulse.calls.id[0]);
  assert.equal(timers.length, 2);
  timers[0]();
  assert.equal(render().pulse.calls.opacity[0], 0);
  timers[1]();
  assert.ok(render().blocked);

  state.focus.terminal = "agent";
  assert.equal(render().blocked, undefined);
  state.focus.terminal = "shell";
  assert.ok(render().blocked);
  assert.equal(render().pulse, undefined);
});

test("a resolved alert and its timers cannot clear a more recent pulse", async () => {
  const { render, state, timers } = await topBar([agent("a", "working"), agent("b", "working")]);
  render();
  state.agents[0] = agent("a", "done", 1);
  const firstId = render().pulse.calls.id[0];
  state.agents[0] = agent("a", "idle", 2);
  state.agents[1] = agent("b", "done", 3);
  const secondId = render().pulse.calls.id[0];
  assert.notEqual(firstId, secondId);
  timers[0]();
  timers[1]();
  assert.equal(render().pulse.calls.id[0], secondId);
  assert.equal(render().pulse.calls.opacity[0], 1);

  state.agents = [];
  assert.deepEqual(render(), { blocked: undefined, done: undefined, pulse: undefined });
  assert.doesNotThrow(() => timers.slice(2).forEach((fire) => fire()));
});

test("cabinet starts on the first measured bar, draws the logo, then sweeps once per session", async () => {
  const { cx, frame, timers, start } = await topBar([]);
  const byId = (tree, id) => find(tree, (node) => node.calls.id?.[0] === id);
  const measure = (tree) => tree.calls.on_size_change[0]({ width: 400 }, cx);
  measure(frame());
  assert.equal(byId(frame(), "cabinet-logo-reveal")?.calls.h[0], 0);
  timers.shift()();
  assert.equal(byId(frame(), "cabinet-logo-reveal")?.calls.h[0], 14);
  const startX = byId(frame(), "cabinet-sweep").calls.left[0];
  timers.shift()();
  assert.ok(byId(frame(), "cabinet-sweep").calls.left[0] > startX);
  timers.shift()();
  assert.equal(byId(frame(), "cabinet-sweep"), undefined);
  const other = start();
  measure(other.render(cx));
  assert.equal(byId(other.render(cx), "cabinet-logo-reveal"), undefined);
});

test("the usage meter gives up only the width needed for window controls", async () => {
  const { cx, frame, state, actions } = await topBar([]);
  state.layout = { children: [{ id: "bar-right", size: { weight: 3 } }] };
  state.window = { platform: "macos", buttons: false };
  const measure = () => frame().calls.on_size_change[0]({ width: 590 }, cx);
  measure();
  assert.deepEqual(actions.pop(), ["layout.resize", { id: "bar-right", px: 0 }]);

  state.layout.children[0].size = { px: 0 };
  state.window.buttons = true;
  measure();
  assert.deepEqual(actions.pop(), ["layout.resize", { id: "bar-right", px: 90 }]);
});
