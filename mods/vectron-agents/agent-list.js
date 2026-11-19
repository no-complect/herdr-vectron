export const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
export const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};

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

// Live descendants in depth-first order, including their tree connectors.
export function agentTree(all, addr, lead = []) {
  const kids = all.filter((k) => k.parent === addr && k.state === "live");
  return kids.flatMap((k, i) => {
    const last = i === kids.length - 1;
    return [
      { t: k, lines: [...lead, last ? "└" : "├"] },
      ...agentTree(all, k.address, [...lead, last ? "" : "│"]),
    ];
  });
}

function agentRank(agent, held) {
  const viewedDone =
    agent.address === held?.address && held.rank === RANK.done && agent.status === "idle";
  return viewedDone ? RANK.done : (RANK[agent.status] ?? 0);
}

export function buildAgentList(list, all, { byPriority, listed, held, changed }) {
  const lastChanged = (agent) => changed[agent.address]?.at ?? 0;
  const urgency = new Map(
    list.map((a) => [
      a.address,
      Math.max(
        agentRank(a, held),
        ...agentTree(all, a.address).map((s) => RANK[kidStatus(s.t, listed)] ?? 0),
      ),
    ]),
  );
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

  return { list: [...pinned, ...rest], groups };
}
