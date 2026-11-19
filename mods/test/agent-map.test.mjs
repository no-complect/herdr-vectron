import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentMap } from "../vectron-agent-map/model.js";
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

test("the overlay renders the live path and peeks at the clicked worker", async () => {
  const root = terminal("lead");
  const worker = terminal("worker", root.address);
  const calls = [];
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
  const view = new AgentMap();
  const byId = (frame, id) => find(frame, (node) => node.calls.id?.[0] === id);

  const initial = view.render();
  assert.ok(find(initial, (node) => node.kind === "cable"));
  worker.status = "blocked";
  const attention = view.render();
  assert.equal(byId(attention, "agent-map-node-worker").calls.border_color[0], "#ff5775");

  byId(attention, "agent-map-node-worker").calls.on_click[0]();
  assert.deepEqual(calls, [["close", "map"], ["terminal.peek", "worker"]]);
});
