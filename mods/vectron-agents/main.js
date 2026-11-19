import { InputGlow } from "./input-glow.js";
// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  agents,
  terminals,
  panes,
  focused,
  spaces,
  run,
  theme,
  shared,
  setShared,
  setAgentOrder,
  openOverlay,
  closeOverlay,
  props,
  window,
  layout,
  nextCommand,
} from "herdr";
import { announce, isActive, entered, move, toTerminal } from "./keynav.js";
import { buildAgentLabels, buildAgentList, RANK } from "./agent-list.js";
import { keynavOutline, renderAgentRows } from "./agent-rows.js";

// Keyboard navigation (keynav.js): while a driver such as whistle selects this list, it glows
// and j/k move a cursor over the agents in the order shown; enter or l focuses the one under it.
const MOD = "vectron-agents";
// Outline the panel while Whistle owns its keyboard focus.
const frame = (t) =>
  div().absolute().top(0).left(0).right(0).bottom(0).border_2().border_color(keynavOutline(t));
// One step through a list of ids, stopping at the ends.
function step(ids, cur, d) {
  if (!ids.length) return null;
  const i = ids.indexOf(cur);
  return ids[i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + d))];
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", {
    id: "sidebar",
    px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44,
  });
}

const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];

export default class Agents extends View {
  init(_props, cx) {
    this.inputGlow = new InputGlow();
    // Only the list in the layout takes part, not this mod's sort menu (an overlay copy).
    if (!props()?.overlay)
      cx.spawn(async (cx) => {
        for (;;) {
          this.handleCommand(await nextCommand());
          cx.notify();
        }
      });
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed))
      if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle")
      this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("sort agents"))
      .children(
        SORTS.map((s) =>
          h_flex()
            .id(`sort-${s.id}`)
            .h(26)
            .px(8)
            .gap(9)
            .rounded(0)
            .items_center()
            .text_color(t.foreground)
            .hover((el) => el.bg(t.foreground + "14"))
            .on_click(() => {
              setShared("agents.sort", s.id);
              closeOverlay(props().overlay);
            })
            .child(
              svg(`mods/vectron-icons/${s.icon}.svg`).size(14).flex_none().text_color(t.muted),
            )
            .child(div().flex_1().child(s.label))
            .when(s.id === on, (el) =>
              el.child(
                svg("mods/vectron-icons/check.svg")
                  .size(14)
                  .flex_none()
                  .text_color(t.foreground),
              ),
            ),
        ),
      );
  }

  rowActions = {
    focusPane: (pane) => run("pane.focus", { pane }),
    peekTerminal: (terminal) => run("terminal.peek", { terminal }),
    hover: (address, on, cx) => {
      if (on) this.hovered = address;
      else if (this.hovered === address) this.hovered = null;
      cx.notify();
    },
    pin: (address, pinned, cx) => {
      run("terminal.pin", { terminal: address, pinned });
      // Pinning moves the row and the original hover-out will not fire.
      this.hovered = null;
      cx.notify();
    },
    fold: (id, cx, closed = !this.folded.has(id)) => {
      if (closed) this.folded.add(id);
      else this.folded.delete(id);
      cx.notify();
    },
  };

  // Number shortcuts follow the current sidebar order, including its sort and pins.
  handleCommand(command) {
    const match = /^select-([1-9])$/.exec(command);
    if (!match) {
      this.keynav(move(command));
      return;
    }
    const live = new Set(agents().map((a) => a.address));
    const ids = (this.order ?? []).filter((address) => live.has(address));
    const terminal = ids[Number(match[1]) - 1];
    if (terminal) run("agent.focus", { terminal });
  }

  // A keynav move while this list is the active field.
  keynav(m) {
    if (!m || !isActive(this.key)) return;
    const live = new Set(agents().map((a) => a.address));
    const ids = (this.order ?? []).filter((a) => live.has(a));
    if (m === "down" || m === "up") this.cursor = step(ids, this.cursor, m === "down" ? 1 : -1);
    else if ((m === "open" || m === "right") && this.cursor) {
      run("agent.focus", { terminal: this.cursor });
      toTerminal();
    }
  }

  render(cx) {
    if (!props()?.overlay) {
      this.key = announce(MOD, props(), "Agents");
      // Selected just now: the cursor starts on the focused agent, else the first.
      if (entered(this, this.key))
        this.cursor = agents().find((a) => a.focused)?.address ?? this.order?.[0] ?? null;
      this.keyOn = isActive(this.key);
    }
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    const list = agents();
    this.inputGlow.selection(
      cx,
      this.keyOn ? this.cursor : (list.find((a) => a.focused)?.address ?? null),
    );
    const listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const ordered = buildAgentList(list, all, {
      byPriority,
      listed,
      held: this.held,
      changed: this.changed,
    });
    const order = ordered.list.map((agent) => agent.address);
    setAgentOrder(order);
    this.order = order;

    // Read each host snapshot once; it copies the whole list into JavaScript.
    const { labels, detail } = buildAgentLabels(ordered.list, panes(), spaces());
    const rows = renderAgentRows(
      t,
      ordered,
      {
        all,
        byPriority,
        changed: this.changed,
        collapsed,
        details: detail,
        folded: this.folded,
        hovered: this.hovered,
        inputGlow: this.inputGlow,
        labels,
        listed,
        now,
        selectedCursor: this.keyOn ? this.cursor : null,
        shown,
      },
      this.rowActions,
    );
    return this.renderPanel(t, { collapsed, sort, count: list.length, rows });
  }

  renderPanel(t, { collapsed, sort, count, rows }) {
    return v_flex()
      .relative()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .pt(collapsed ? 0 : 10)
      .text_size(12)
      .when(this.keyOn, (el) => el.child(frame(t)))
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .pl(18)
            .pr(10)
            .h(26)
            .flex_none()
            .items_center()
            .justify_between()
            .child(
              div()
                .text_size(11)
                .font_medium()
                .text_color(t.foreground)
                .child(`AGENTS [${count}]`),
            )
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .p(3)
                .rounded(0)
                .text_color(t.dim)
                .hover((s) => s.bg(t.foreground + "14").text_color(t.foreground))
                .on_click(() =>
                  openOverlay({
                    mod: "vectron-agents",
                    kind: "popup",
                    width: 200,
                    height: 140,
                    props: { sortMenu: true },
                  }),
                )
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/vectron-icons/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(count === 0 && !collapsed, (el) =>
        el.child(
          div()
            .px(12)
            .text_size(12)
            .text_color(t.dim)
            .child(
              "No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.",
            ),
        ),
      )
      .child(
        v_flex()
          .id("ag-list")
          .flex_1()
          .min_h(0)
          .px(collapsed ? 0 : 10)
          .when(collapsed, (el) => el.pt(10).gap(6).items_center())
          .pb(10)
          .overflow_y_scrollbar()
          .mode("always")
          .children(rows),
      )
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(40)
            .flex_none()
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .size(30)
                .flex()
                .items_center()
                .justify_center()
                .border(1)
                .border_color(t.foreground + "00")
                .bg(t.foreground + "0a")
                .text_color(t.muted)
                .tooltip("Expand sidebar")
                .hover((s) =>
                  s
                    .bg(t.foreground + "14")
                    .border_color(t.foreground + "40")
                    .text_color(t.foreground),
                )
                .on_click(toggleSidebar)
                .child(svg("mods/vectron-icons/chevron-right.svg").size(14)),
            ),
        ),
      );
  }
}
