import assert from "node:assert/strict";
import test from "node:test";
import { find, loadMod } from "./support/herdr.mjs";

const noop = () => {};

async function agentsPanel({ overlay = false, storage = {} } = {}) {
  const program = { key: "codex", name: "Codex", agent: true };
  const agent = (address, status, seq, options = {}) => ({
    address,
    status,
    seq,
    program,
    pane: `pane-${address}`,
    tab: `tab-${address}`,
    tab_index: seq,
    space: seq <= 2 ? "workspace" : "other",
    space_name: seq <= 2 ? "Workspace" : "Other",
    ...options,
  });
  const list = [
    agent("parent", "idle", 1, { title: "Parser", focused: true }),
    agent("finished", "done", 2),
    agent("active", "working", 3, { pinned: true }),
  ];
  const child = { address: "child", parent: "parent", state: "live", status: "error", program };
  const state = { width: 268, sort: "priority", shown: "child", descendants: [child] };
  const calls = [];
  const persisted = new Map(Object.entries(storage));
  const palette = new Proxy({}, { get: () => "#c1cede" });
  const herdr = {
    agents: () => list,
    terminals: () => [
      ...list.map((agent) => ({ ...agent, state: "live" })),
      ...state.descendants,
    ],
    panes: () => {
      calls.push(["panes"]);
      return list.map((agent) => ({ ...agent, terminal: agent.address }));
    },
    spaces: () => {
      calls.push(["spaces"]);
      return ["workspace", "other"].map((id) => ({
        tabs: list
          .filter((agent) => agent.space === id)
          .map((agent) => ({ id: agent.tab, name: String(agent.tab_index) })),
      }));
    },
    focused: () => ({ agent: state.shown }),
    layout: () => ({ children: [{ id: "sidebar", size: { px: state.width } }] }),
    props: () => (overlay ? { overlay: "sort", sortMenu: true } : {}),
    theme: () => palette,
    shared: (key) => (key === "agents.sort" ? state.sort : undefined),
    setShared: noop,
    closeOverlay: (id) => calls.push(["close", id]),
    setAgentOrder: (addresses) => calls.push(["order", Array.from(addresses)]),
    run: (name, args) => calls.push([name, { ...args }]),
    window: () => ({ platform: "macos" }),
    openOverlay: noop,
    nextCommand: noop,
    home: noop,
  };
  const localStorage = {
    getItem: (key) => persisted.get(key),
    setItem: (key, value) => {
      calls.push(["save", key]);
      persisted.set(key, value);
    },
    removeItem: (key) => persisted.delete(key),
  };
  const { default: Agents } = await loadMod(
    "vectron-agents",
    "main.js",
    { herdr },
    {
      localStorage,
      Date: { now: () => 1_800_000_000_000 },
    },
  );
  const cx = {
    spawn: () => calls.push(["listen"]),
    timer: { every: (ms) => calls.push(["timer", ms]) },
    stop_propagation: () => calls.push(["stop"]),
    notify: noop,
  };
  const view = new Agents();
  view.init({}, cx);
  return { calls, state, list, view, cx, render: () => view.render(cx) };
}

const elementWithId = (tree, id) => find(tree, (node) => node.calls.id?.[0] === id);

test("Agents publishes one pinned and priority order before drawing labels", async () => {
  const panel = await agentsPanel({ storage: { pins: '["parent"]' } });
  const priority = panel.render();
  assert.deepEqual(panel.calls, [
    ["listen"],
    ["timer", 30_000],
    ["terminal.pin", { terminal: "parent", pinned: true }],
    ["save", "changed"],
    ["order", ["active", "parent", "finished"]],
    ["panes"],
    ["spaces"],
  ]);
  assert.ok(elementWithId(priority, "sec-4"));
  assert.ok(elementWithId(priority, "sub-child"));

  panel.list[0].focused = false;
  panel.list[1].focused = true;
  panel.render();
  panel.list[1].status = "idle";
  const held = panel.render();
  assert.ok(elementWithId(held, "sec-3"));
  panel.list[1].focused = false;
  panel.list[0].focused = true;
  assert.equal(elementWithId(panel.render(), "sec-3"), undefined);

  panel.state.width = 76;
  const rail = panel.render();
  assert.equal(elementWithId(rail, "sub-child"), undefined);
  assert.ok(elementWithId(rail, "ag-parent"));
  assert.deepEqual(panel.calls.filter(([name]) => name === "order").at(-1), [
    "order",
    ["active", "parent", "finished"],
  ]);

  panel.state.width = 268;
  panel.state.sort = "grouped";
  assert.ok(elementWithId(panel.render(), "sp-workspace"));
  panel.view.handleCommand("select-1");
  assert.deepEqual(panel.calls.at(-1), ["agent.focus", { terminal: "active" }]);
});

test("Agents calls the original focus, peek, fold, and pin actions", async () => {
  const panel = await agentsPanel();
  const tree = panel.render();
  panel.calls.length = 0;
  elementWithId(tree, "ag-parent").calls.on_click[0]();
  elementWithId(tree, "sub-child").calls.on_click[0]();
  elementWithId(tree, "fold-parent").calls.on_click[0]({}, panel.cx);
  assert.deepEqual(panel.calls, [
    ["pane.focus", { pane: "pane-parent" }],
    ["terminal.peek", { terminal: "child" }],
    ["stop"],
  ]);
  const folded = panel.render();
  assert.equal(elementWithId(folded, "sub-child"), undefined);
  assert.ok(elementWithId(folded, "sec-4"));

  elementWithId(folded, "ag-parent").calls.on_hover[0](true, panel.cx);
  const hovered = panel.render();
  panel.calls.length = 0;
  elementWithId(hovered, "pin-parent").calls.on_click[0]({}, panel.cx);
  assert.deepEqual(panel.calls, [
    ["stop"],
    ["terminal.pin", { terminal: "parent", pinned: true }],
  ]);
  assert.equal(elementWithId(panel.render(), "pin-parent"), undefined);
});

test("the Agents sort popup leaves commands and the timer with the panel", async () => {
  const popup = await agentsPanel({ overlay: true });
  const tree = popup.render();
  assert.ok(elementWithId(tree, "sort-grouped"));
  assert.deepEqual(popup.calls, []);
});

test("deep sub-agents still affect priority in the collapsed rail", async () => {
  const panel = await agentsPanel();
  panel.state.width = 76;
  const depth = 3000;
  panel.state.descendants = Array.from({ length: depth }, (_, i) => ({
    address: `child-${i}`,
    parent: i === 0 ? "parent" : `child-${i - 1}`,
    state: "live",
    status: i === depth - 1 ? "error" : "idle",
  }));

  const tree = panel.render();
  assert.equal(elementWithId(tree, "sub-child-0"), undefined);
  assert.deepEqual(
    panel.calls.find(([name]) => name === "order"),
    ["order", ["active", "parent", "finished"]],
  );
});

test("expanded sub-agent rows keep depth-first order and branch connectors", async () => {
  const panel = await agentsPanel();
  panel.state.descendants.push(
    { address: "sibling", parent: "parent", state: "live", status: "idle" },
    { address: "grandchild", parent: "child", state: "live", status: "idle" },
  );

  const rows = elementWithId(panel.render(), "ag-list").nodes;
  const childRows = rows.filter((row) => row.calls.id?.[0]?.startsWith("sub-"));
  assert.deepEqual(
    childRows.map((row) => row.calls.id[0]),
    ["sub-child", "sub-grandchild", "sub-sibling"],
  );
  const connectors = childRows[1].nodes.filter((node) => node.calls.border_l);
  assert.equal(connectors.length, 2);
  assert.equal(connectors[0].calls.border_b, undefined);
  assert.ok(connectors[1].calls.border_b);
});
