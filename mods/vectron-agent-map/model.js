export const nodeWidth = 190;
export const nodeHeight = 50;

const padding = 18;
const columnWidth = 260;
const rowHeight = 70;
const groupGap = 16;

function liveTerminalsInSpace(space, reports, terminals, panes) {
  const tabs = new Set(space.tabs.map((tab) => tab.id));
  const paneTabs = new Map(panes.map((pane) => [pane.terminal, pane.tab]));
  const live = new Map();

  for (const terminal of terminals) {
    if (terminal.state !== "live") continue;
    const agentSpace = reports.get(terminal.address)?.space;
    const paneTab = paneTabs.get(terminal.address);
    // A worker with its own pane can move to another space.
    if (agentSpace != null && agentSpace !== space.id) continue;
    if (paneTab != null && !tabs.has(paneTab)) continue;
    live.set(terminal.address, terminal);
  }

  return live;
}

function linksBetween(live) {
  const parents = new Map();
  const children = new Map();
  const machine = (address) => address.includes("/") ? address.split("/", 1)[0] : null;
  for (const { address, parent } of live.values()) {
    if (parent === address || !live.has(parent) || machine(parent) !== machine(address)) continue;
    parents.set(address, parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(address);
  }
  return { parents, children };
}

function describe(terminal, agent) {
  const program = agent?.program ?? terminal.program;
  const status = agent?.status ?? terminal.status;
  const title =
    agent?.title || terminal.title || terminal.report?.title || terminal.name ||
    program?.name || terminal.address;
  return {
    address: terminal.address,
    title,
    program,
    status: status === "error" ? "blocked" : status,
  };
}

function layoutBranches(visible, parents, children) {
  const roots = [...visible.keys()].filter((address) => !visible.has(parents.get(address)));

  const nodes = [];
  const edges = [];
  const visited = new Set();
  let width = 0;
  let height = 0;
  let nextRow = padding + nodeHeight / 2;

  // Walk each lineage iteratively. A cycle can have no root, so also visit any
  // remaining node and omit the edge that would revisit an ancestor.
  for (const address of [...roots, ...visible.keys()]) {
    if (visited.has(address)) continue;
    nextRow += nodes.length ? groupGap : 0;
    const stack = [];
    const placeNode = (address, parent, depth) => {
      const node = {
        ...visible.get(address),
        parent: parent?.address ?? null,
        x: padding + depth * columnWidth,
        y: null,
      };
      visited.add(address);
      nodes.push(node);
      if (parent) edges.push({ parent, child: node });
      stack.push({ node, children: children.get(address) ?? [], index: 0, firstY: null, lastY: null });
      width = Math.max(width, node.x + nodeWidth + padding);
    };
    placeNode(address, null, 0);

    while (stack.length) {
      const frame = stack.at(-1);
      if (frame.index < frame.children.length) {
        const child = frame.children[frame.index++];
        if (visible.has(child) && !visited.has(child)) {
          placeNode(child, frame.node, stack.length);
        }
        continue;
      }

      if (frame.firstY === null) {
        frame.node.y = nextRow;
        height = nextRow + nodeHeight / 2 + padding;
        nextRow += rowHeight;
      } else {
        frame.node.y = (frame.firstY + frame.lastY) / 2;
      }
      stack.pop();
      const parent = stack.at(-1);
      if (parent) {
        parent.firstY ??= frame.node.y;
        parent.lastY = frame.node.y;
      }
    }
  }

  return { nodes, edges, width, height };
}

export function buildAgentMap(space, agents, terminals, panes) {
  if (!space) return { nodes: [], edges: [], width: 0, height: 0 };

  const reports = new Map(agents.map((agent) => [agent.address, agent]));
  const live = liveTerminalsInSpace(space, reports, terminals, panes);
  const { parents, children } = linksBetween(live);
  const visible = new Map();

  for (const agent of agents) {
    if (agent.space === space.id && live.has(agent.address)) {
      visible.set(agent.address, describe(live.get(agent.address), agent));
    }
  }
  // Include descendants even when they have no tab or status report. Iterating
  // the Map visits new descendants as they are added, once for each address.
  for (const address of visible.keys()) {
    for (const child of children.get(address) ?? []) {
      if (!visible.has(child)) visible.set(child, describe(live.get(child), reports.get(child)));
    }
  }

  return layoutBranches(visible, parents, children);
}
