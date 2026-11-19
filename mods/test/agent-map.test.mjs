import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentMap } from "../vectron-agent-map/model.js";
import { AttentionPulses } from "../vectron-agent-map/pulses.js";
import { Element, find, loadMod } from "./support/herdr.mjs";

const space = { id: "local", name: "Current space", tabs: [{ id: "tab" }] };
const agent = (address, space = "local", status = "working") => ({ address, space, status });
const terminal = (address, parent, status = "working", state = "live") => ({
  address, parent, status, state, name: address,
});

test("the map draws only real parent links and includes current-space workers without panes", () => {
  const graph = buildAgentMap(space, [agent("lead"), agent("worker"), agent("standalone"), agent("elsewhere", "remote")], [
    terminal("lead"),
    terminal("worker", "lead"),
    terminal("nested", "worker", "error"),
    terminal("elsewhere", "lead"),
    terminal("remote/t1", "lead"),
    terminal("other-tab", "lead"),
    terminal("exited", "lead", "blocked", "exited"),
    terminal("standalone", "missing"),
    terminal("shell"),
  ], [{ tab: "remote-tab", terminal: "other-tab" }]);

  assert.deepEqual(graph.nodes.map(({ address }) => address), ["lead", "worker", "nested", "standalone"]);
  assert.deepEqual(graph.edges.map(({ parent, child }) => [parent.address, child.address]), [
    ["lead", "worker"], ["worker", "nested"],
  ]);
  assert.equal(graph.nodes.find(({ address }) => address === "nested").status, "blocked");
  assert.ok(graph.edges.every(({ parent, child }) => parent.x < child.x));
});

test("branch positions stay fixed when status changes and the layout tolerates deep or cyclic lineages", () => {
  const rows = [terminal("root"), terminal("one", "root"), terminal("two", "root")];
  const first = buildAgentMap(space, [agent("root")], rows, []);
  rows[2].status = "blocked";
  const next = buildAgentMap(space, [agent("root")], rows, []);
  const positions = (graph) => graph.nodes.map(({ address, x, y }) => [address, x, y]);
  assert.deepEqual(positions(next), positions(first));
  assert.equal(next.nodes[0].y, (next.nodes[1].y + next.nodes[2].y) / 2);

  const chain = [terminal("t0", "t11999")];
  for (let index = 1; index < 12000; index++) chain.push(terminal(`t${index}`, `t${index - 1}`));
  const long = buildAgentMap(space, [agent("t0")], chain, []);
  assert.equal(long.nodes.length, 12000);
  assert.equal(long.edges.length, 11999);
  assert.equal(long.nodes[0].address, "t0");
});

test("only a newly blocked worker sends a pulse, and old timers cannot replay on space switches", () => {
  const pulses = new AttentionPulses();
  const timers = [];
  let redraws = 0;
  const cx = { notify: () => redraws++, timer: { after: (_ms, fire) => timers.push(fire) } };
  const statuses = (status) => [
    { address: "lead", status: "working", parent: null },
    { address: "worker", status, parent: "lead" },
  ];

  pulses.update(space.id, statuses("blocked"), cx);
  assert.equal(pulses.get("worker"), undefined);
  pulses.update(space.id, statuses("working"), cx);
  pulses.update(space.id, statuses("blocked"), cx);
  const signal = pulses.get("worker");
  assert.equal(signal.phase, "start");
  pulses.update(space.id, statuses("blocked"), cx);
  assert.equal(pulses.get("worker"), signal);
  timers.shift()(cx);
  assert.equal(signal.phase, "travel");
  timers.shift()(cx);
  assert.equal(signal.phase, "fade");
  timers.shift()(cx);
  assert.equal(pulses.get("worker"), undefined);
  assert.equal(redraws, 3);

  pulses.update(space.id, statuses("idle"), cx);
  pulses.update(space.id, statuses("blocked"), cx);
  pulses.update("different-space", statuses("blocked"), cx);
  timers.splice(0).forEach((fire) => fire(cx));
  assert.equal(pulses.get("worker"), undefined);
  assert.equal(redraws, 3);
});

test("the overlay renders the live path, moves the pulse, and peeks at the clicked worker", async () => {
  const root = terminal("lead");
  const worker = terminal("worker", root.address);
  const calls = [];
  const timers = [];
  const { default: AgentMap } = await loadMod("vectron-agent-map", "main.js", {
    herdr: {
      agents: () => [agent(root.address)],
      terminals: () => [root, worker],
      spaces: () => [space],
      panes: () => [],
      focused: () => ({ space: space.id, terminal: root.address }),
      theme: () => ({ border: "#1b5592", blocked: "#ff5775" }),
      props: () => ({ overlay: "map" }),
      closeOverlay: (id) => calls.push(["close", id]),
      run: (command, args) => calls.push([command, args.terminal]),
    },
    "gpui-kit": {
      PathBuilder: {
        stroke: () => ({
          move_to() { return this; },
          line_to() { return this; },
          build() { return "path"; },
        }),
      },
    },
  }, {
    window: { paint_path: () => new Element("cable") },
  });
  const cx = { notify() {}, timer: { after: (_ms, fire) => timers.push(fire) } };
  const view = new AgentMap();
  const byId = (frame, id) => find(frame, (node) => node.calls.id?.[0] === id);

  const initial = view.render(cx);
  assert.ok(find(initial, (node) => node.kind === "cable"));
  assert.equal(byId(initial, "agent-map-pulse-1"), undefined);
  worker.status = "blocked";
  const attention = view.render(cx);
  const start = byId(attention, "agent-map-pulse-1");
  assert.equal(byId(attention, "agent-map-node-worker").calls.border_color[0], "#ff5775");
  timers.shift()(cx);
  const end = byId(view.render(cx), "agent-map-pulse-1");
  assert.ok(end.calls.left[0] > start.calls.left[0]);

  byId(attention, "agent-map-node-worker").calls.on_click[0]();
  assert.deepEqual(calls, [["close", "map"], ["terminal.peek", "worker"]]);
});
