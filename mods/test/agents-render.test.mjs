import assert from "node:assert/strict";
import test from "node:test";
import { find, loadMod } from "./support/herdr.mjs";

const noop = () => {};
const startTime = 1_800_000_000_000;
const settleTasks = () => new Promise(setImmediate);

async function agentsPanel({ overlay = false, storage = {}, nextCommand = noop } = {}) {
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
  const clock = { now: startTime };
  const tasks = [];
  const timers = [];
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
    setShared: (key, value) => {
      if (key !== "agents.sort") return;
      state.sort = value;
      calls.push(["sort", value]);
    },
    closeOverlay: (id) => calls.push(["close", id]),
    setAgentOrder: (addresses) => calls.push(["order", Array.from(addresses)]),
    run: (name, args) => calls.push([name, { ...args }]),
    window: () => ({ platform: "macos" }),
    openOverlay: noop,
    nextCommand,
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
      Date: { now: () => clock.now },
      Math: Object.create(Math, { random: { value: () => 0 } }),
    },
  );
  const cx = {
    spawn: (task) => {
      tasks.push(task);
      calls.push(["spawn"]);
    },
    timer: {
      every: (ms, callback) => {
        timers.push({ ms, callback });
        calls.push(["timer", ms]);
      },
    },
    stop_propagation: () => calls.push(["stop"]),
    notify: () => calls.push(["redraw"]),
  };
  const view = new Agents();
  view.init({}, cx);
  return { calls, state, list, view, cx, clock, tasks, timers, render: () => view.render(cx) };
}

const elementWithId = (tree, id) => find(tree, (node) => node.calls.id?.[0] === id);

test("Agents publishes one pinned and priority order before drawing labels", async () => {
  const panel = await agentsPanel({ storage: { pins: '["parent"]' } });
  const priority = panel.render();
  assert.deepEqual(panel.calls, [
    ["spawn"],
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
    ["redraw"],
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
    ["redraw"],
  ]);
  assert.equal(elementWithId(panel.render(), "pin-parent"), undefined);
});

test("the Agents sort popup leaves commands and the timer with the panel", async () => {
  const popup = await agentsPanel({ overlay: true });
  const tree = popup.render();
  const grouped = elementWithId(tree, "sort-grouped");
  assert.ok(grouped);
  popup.render();
  assert.deepEqual(popup.calls, []);

  grouped.calls.on_click[0]();
  assert.deepEqual(popup.calls, [
    ["sort", "grouped"],
    ["close", "sort"],
  ]);
  assert.equal(popup.tasks.length, 0);
  assert.equal(popup.timers.length, 0);
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

test("Agents waits for one command at a time and redraws after routing it", async () => {
  const waiting = [];
  const panel = await agentsPanel({
    nextCommand: () => {
      const command = Promise.withResolvers();
      waiting.push(command);
      return command.promise;
    },
  });
  panel.render();
  panel.render();
  assert.equal(panel.tasks.length, 1);

  const closed = new Error("fixture channel closed");
  const listener = panel.tasks[0](panel.cx).catch((error) => error);
  try {
    panel.calls.length = 0;
    assert.equal(waiting.length, 1);
    assert.deepEqual(panel.calls, []);

    waiting.shift().resolve("select-1");
    await settleTasks();
    assert.equal(waiting.length, 1);
    assert.deepEqual(panel.calls, [["agent.focus", { terminal: "active" }], ["redraw"]]);

    // Herdr can remove the first agent between publishing the order and dispatch.
    panel.list.pop();
    panel.calls.length = 0;
    waiting.shift().resolve("select-1");
    await settleTasks();
    assert.equal(waiting.length, 1);
    assert.deepEqual(panel.calls, [["agent.focus", { terminal: "parent" }], ["redraw"]]);
  } finally {
    for (const receiver of waiting) receiver.reject(closed);
    assert.equal(await listener, closed);
  }
});

test("the age timer refreshes labels on its cadence without rewriting status history", async () => {
  const panel = await agentsPanel();
  const ageLabel = (tree, age) =>
    find(elementWithId(tree, "ag-parent"), (node) => node.nodes.includes(age));
  assert.ok(ageLabel(panel.render(), "<1m"));
  const [timer] = panel.timers;
  assert.equal(timer.ms, 30_000);

  for (const age of ["<1m", "1m"]) {
    panel.clock.now += timer.ms;
    panel.calls.length = 0;
    timer.callback(panel.cx);
    assert.deepEqual(panel.calls, [["redraw"]]);

    assert.ok(ageLabel(panel.render(), age));
    assert.deepEqual(
      panel.calls.map(([name]) => name),
      ["redraw", "order", "panes", "spaces"],
    );
    assert.equal(panel.timers.length, 1);
    assert.equal(panel.tasks.length, 1);
  }
});

test("an earlier flash finishing cannot clear the currently selected agent's flash", async () => {
  const panel = await agentsPanel();
  const sleeping = [];
  panel.cx.sleep = (ms) =>
    new Promise((resolve) => sleeping.push({ at: panel.clock.now + ms, resolve }));

  async function advanceTo(ms) {
    const end = startTime + ms;
    sleeping.sort((a, b) => a.at - b.at);
    while (sleeping[0]?.at <= end) {
      const next = sleeping.shift();
      panel.clock.now = next.at;
      next.resolve();
      await settleTasks();
      sleeping.sort((a, b) => a.at - b.at);
    }
    panel.clock.now = end;
  }

  const wash = (tree, address) =>
    find(
      elementWithId(tree, `ag-${address}`),
      (node) =>
        node.calls.id?.[0]?.startsWith(`vector-flash-${address}-`) &&
        node.calls.id[0].endsWith("-wash"),
    );
  panel.render();
  panel.list[0].focused = false;
  panel.list[1].focused = true;
  panel.calls.length = 0;
  assert.equal(wash(panel.render(), "finished").calls.opacity[0], 1);
  assert.equal(
    panel.calls.some(([name]) => name === "redraw"),
    false,
  );
  const earlier = panel.tasks[1](panel.cx);
  await advanceTo(400);
  assert.equal(wash(panel.render(), "finished").calls.opacity[0], 0);

  panel.list[1].focused = false;
  panel.list[2].focused = true;
  const newest = panel.render();
  assert.equal(wash(newest, "finished"), undefined);
  assert.equal(wash(newest, "active").calls.opacity[0], 1);
  assert.equal(wash(panel.render(), "active").calls.opacity[0], 1);
  assert.equal(panel.tasks.length, 3);
  const later = panel.tasks[2](panel.cx);

  // With 150 ms gaps, the first flash's cleanup wakes at 640 ms.
  await advanceTo(639);
  panel.calls.length = 0;
  await advanceTo(640);
  await earlier;
  assert.deepEqual(panel.calls, []);
  assert.ok(wash(panel.render(), "active"));

  await advanceTo(1040);
  await later;
  assert.equal(sleeping.length, 0);
  assert.equal(wash(panel.render(), "active"), undefined);
});

test("working badges use the same native pulse in the expanded panel and rail", async () => {
  const panel = await agentsPanel();
  for (const width of [268, 76]) {
    panel.state.width = width;
    const agent = elementWithId(panel.render(), "ag-active");
    const indicator = find(agent, (node) => Boolean(node.calls.loop));
    const [property, pulse] = indicator.calls.loop;

    assert.equal(property, "opacity");
    assert.deepEqual({ ...pulse }, { from: 0.35, to: 1, period: 1200 });
  }
});
