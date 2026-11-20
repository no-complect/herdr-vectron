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

test("an amber History marker appears only while the terminal is scrolled back", async () => {
  const { render } = await paneHeader();
  assert.equal(render(0).history, undefined);
  assert.equal(render(5).history.calls.text_color[0], "#f8ab59");
  assert.ok(render(30).history);
  assert.equal(render(null).history, undefined);
});
