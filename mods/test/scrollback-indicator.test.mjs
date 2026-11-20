import assert from "node:assert/strict";
import test from "node:test";
import { find, loadMod } from "./support/herdr.mjs";

async function paneHeader() {
  const pane = { pane: "p1", terminal: "t1", title: "Shell", tab: "tab-1", focused: true };
  const state = { pane, focus: { pane: "p1", terminal: "t1", shown: null } };
  const actions = [];
  const noop = () => {};
  const cx = { spawn: noop, notify: noop, stop_propagation: () => actions.push("stop") };
  const { default: Pane } = await loadMod("vectron-pane", "main.js", {
    herdr: {
      panes: () => state.pane ? [state.pane] : [],
      focused: () => state.focus,
      props: () => ({ pane: "p1" }),
      theme: () => ({ accent: "#fcfa55", border: "#284c88", foreground: "#f6f8ff" }),
      run: (name, args) => actions.push([name, { ...args }]),
      home: noop, exec: noop, layout: noop, shared: noop, setShared: noop,
      window: noop, appHome: noop, watchFolder: noop, readTextFile: noop,
    },
  });
  const header = new Pane();
  header.init({}, cx);

  return {
    actions, cx, state, pane,
    render(distance) {
      pane.scroll = distance === null ? null : { from_bottom: distance };
      const view = header.render(cx);
      return {
        history: find(view, (node) => node.nodes.includes("History")),
        pulse: find(view, (node) => node.calls.id?.[0].startsWith("vector-flash-scrollback-")),
      };
    },
  };
}

test("terminal headers mark history and pulse only on the observed return to live output", async () => {
  const { actions, cx, render } = await paneHeader();
  assert.deepEqual(render(0), { history: undefined, pulse: undefined });
  const { history, pulse } = render(30);
  assert.equal(history.calls.text_color[0], "#f8ab59");
  assert.equal(pulse, undefined);
  assert.equal(history.calls.tooltip[0], "Return to live output");

  history.calls.on_click[0](null, cx);
  assert.deepEqual(actions, ["stop", ["terminal.scroll", { to: "bottom", terminal: "t1" }]]);
  assert.equal(render(30).pulse, undefined);
  const live = render(0);
  assert.equal(live.history, undefined);
  assert.ok(live.pulse);
  assert.equal(render(0).pulse.calls.id[0], live.pulse.calls.id[0]);
  assert.equal(render(7).pulse, undefined);
});

test("History returns a focused replacement terminal to live without restoring the original", async () => {
  const { actions, cx, state, render } = await paneHeader();
  state.focus.shown = "t-parked";
  const { history } = render(20);
  history.calls.on_click[0](null, cx);
  assert.deepEqual(actions, ["stop", ["terminal.scroll", { to: "bottom", terminal: "t-parked" }]]);
  assert.ok(render(0).pulse);
});

test("history remains visible on unfocused panes and a stale button never scrolls another terminal", async () => {
  const { actions, cx, state, pane, render } = await paneHeader();
  const stale = render(15).history;
  state.focus = { pane: "p2", terminal: "t2", shown: null };
  pane.focused = false;
  stale.calls.on_click[0](null, cx);
  assert.deepEqual(actions, ["stop"]);
  const { history, pulse } = render(15);
  assert.ok(history);
  assert.equal(history.calls.on_click, undefined);
  assert.equal(pulse, undefined);
});

test("alternate screens, replacement changes, and missing panes clear the return transition", async () => {
  const { state, pane, render } = await paneHeader();
  render(8);
  assert.deepEqual(render(null), { history: undefined, pulse: undefined });
  assert.equal(render(0).pulse, undefined);

  render(12);
  state.focus.shown = "t-parked";
  assert.equal(render(0).pulse, undefined);

  render(18);
  assert.ok(render(0).pulse);
  state.pane = null;
  assert.deepEqual(render(0), { history: undefined, pulse: undefined });
  state.pane = pane;
  assert.equal(render(0).pulse, undefined);
});
