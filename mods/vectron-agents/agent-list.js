export const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
function childStatus(terminal, listed) {
  const status = listed.get(terminal.address) ?? terminal.status;
  if (status === "error") return "blocked";
  return status === "done" ? "idle" : status;
}

const SECTION = { 4: "blocked", 3: "done", 2: "working", 1: "idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (
      !current ||
      (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))
    )
      leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling =
    live &&
    live !== prog &&
    !/^[~/]|^[A-Za-z]:\\/.test(live) &&
    !live.includes("@") &&
    live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
export function buildAgentLabels(list, allPanes, allSpaces) {
  const leads = leadPanes(allPanes);
  const tabLabels = new Map(
    allSpaces.flatMap((s) => s.tabs).map((tab) => [tab.id, title(tab, leads.get(tab.id))]),
  );
  const labels = new Map(
    list.map((a) => [a.address, tabLabels.get(a.tab) ?? (a.title || a.program?.name || "")]),
  );
  const label = (a) => labels.get(a.address);
  // The icon already names the program, so a detail that is only "Claude Code" or "Codex" says nothing.
  const isProgram = (a, l) =>
    !l || /^\d+$/.test(l) || l === a.program?.name || l === "Claude Code";
  const work = (a) => {
    if (!isProgram(a, label(a))) return label(a);
    const own = (a.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    return isProgram(a, own) ? null : own;
  };
  const detail = new Map(list.map((a) => [a.address, work(a)]));
  const seen = {};
  // Rows name the agent's space, not its working folder.
  const place = (a) => a.space_name;
  for (const a of list) {
    const k = `${place(a)}\u0000${detail.get(a.address) ?? ""}`;
    seen[k] = (seen[k] ?? 0) + 1;
  }
  for (const a of list) {
    if (
      detail.get(a.address) == null &&
      seen[`${place(a)}\u0000`] > 1 &&
      !isProgram(a, label(a))
    )
      detail.set(a.address, label(a));
  }

  return { labels, detail };
}

function indexLiveChildren(terminals) {
  const childrenByParent = new Map();
  for (const terminal of terminals) {
    if (terminal.state !== "live" || !terminal.parent) continue;

    if (!childrenByParent.has(terminal.parent)) childrenByParent.set(terminal.parent, []);
    childrenByParent.get(terminal.parent).push(terminal);
  }
  return childrenByParent;
}

function collectDescendants(address, childrenByParent, listed, includeRows) {
  const rows = [];
  const rootChildren = childrenByParent.get(address);
  if (!rootChildren) return { rank: 0, rows };

  const stack = [{ children: rootChildren, index: 0, parentRow: null }];
  const visited = new Set([address]);
  let rank = 0;

  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.index === frame.children.length) {
      stack.pop();
      continue;
    }

    const terminal = frame.children[frame.index++];
    if (visited.has(terminal.address)) continue;
    visited.add(terminal.address);

    const status = childStatus(terminal, listed);
    rank = Math.max(rank, RANK[status] ?? 0);

    let row = null;
    if (includeRows) {
      // Linking rows avoids copying an entire indentation path for each descendant.
      row = {
        terminal,
        status,
        parent: frame.parentRow,
        last: frame.index === frame.children.length,
      };
      rows.push(row);
    }

    const children = childrenByParent.get(terminal.address);
    if (children) stack.push({ children, index: 0, parentRow: row });
  }

  return { rank, rows };
}

function agentRank(agent, held) {
  const viewedDone =
    agent.address === held?.address && held.rank === RANK.done && agent.status === "idle";
  return viewedDone ? RANK.done : (RANK[agent.status] ?? 0);
}

export function buildAgentList(
  list,
  terminals,
  { byPriority, collapsed, listed, held, changed },
) {
  const childrenByParent = indexLiveChildren(terminals);
  const descendants = new Map();
  const urgency = new Map();
  const lastChanged = (agent) => changed[agent.address]?.at ?? 0;

  for (const agent of list) {
    const { rank, rows } = collectDescendants(
      agent.address,
      childrenByParent,
      listed,
      !collapsed,
    );
    urgency.set(agent.address, Math.max(agentRank(agent, held), rank));
    descendants.set(agent.address, rows);
  }

  const rankOf = (a) => urgency.get(a.address);
  if (byPriority)
    list = [...list].sort(
      (x, y) => rankOf(y) - rankOf(x) || lastChanged(y) - lastChanged(x) || y.seq - x.seq,
    );
  const pinned = list.filter((a) => a.pinned);
  const rest = list.filter((a) => !a.pinned);

  // Groups in list order: spaces (grouped) or priority sections. Agents of a
  // space are next to each other in agents(), so neighbours make a group.
  const groups = pinned.length
    ? [{ id: "pinned", label: "pinned", status: null, members: pinned }]
    : [];
  for (const a of rest) {
    const r = rankOf(a) || RANK.idle;
    const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
    if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
    else
      groups.push({
        id,
        label: byPriority ? SECTION[r] : a.space_name || "",
        status: byPriority ? SECTION_STATUS[r] : null,
        members: [a],
      });
  }

  return { list: [...pinned, ...rest], groups, descendants };
}
