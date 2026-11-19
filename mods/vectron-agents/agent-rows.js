import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agentTree, kidStatus, RANK } from "./agent-list.js";
import { programIcon } from "./program-icon.js";

export const keynavOutline = (theme) => theme.foreground + "b3";

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Compact blocked rows use a badge because their section already names the state.
function statusBadge(t, a, compact = false) {
  const color = t[a.status] ?? t.dim;
  if (a.status === "working")
    return div()
      .size(7)
      .mx(3)
      .flex_none()
      .rounded(0)
      .bg(t.working)
      .loop("opacity", { from: 0.35, to: 1, period: 1200 });
  if (a.status === "blocked" && compact)
    return div()
      .size(14)
      .flex_none()
      .rounded(0)
      .bg(t.blocked + "26")
      .text_size(10.5)
      .font_bold()
      .text_color(t.blocked)
      .flex()
      .items_center()
      .justify_center()
      .child("!");
  if (a.status === "blocked")
    return div()
      .flex_none()
      .px(6)
      .h(18)
      .rounded(0)
      .bg(t.blocked + "26")
      .text_size(10.5)
      .font_semibold()
      .text_color(t.blocked)
      .flex()
      .items_center()
      .child("Blocked");
  // Idle: a hollow square; done: a filled one.
  if (a.status === "idle")
    return div()
      .size(7)
      .mx(3)
      .flex_none()
      .rounded(0)
      .border(1)
      .border_color(t.idle ?? t.dim);
  return div()
    .size(7)
    .mx(3)
    .flex_none()
    .rounded(0)
    .bg(a.status === "done" ? color : t.dim + "00");
}

function childRow(t, s, shown, compact, listed, actions) {
  const k = s.t;
  const st = kidStatus(k, listed);
  const pic = programIcon(k.program, 14, t.foreground);
  const on = k.address === shown;
  return h_flex()
    .id(`sub-${k.address}`)
    .pl(39)
    .pr(8)
    .rounded(0)
    .h(24)
    .flex_none()
    .gap(0)
    .items_center()
    .text_size(12.5)
    .when(on, (el) => el.bg(t.foreground + "2e"))
    .hover((s) => s.bg(t.foreground + "14"))
    .on_click(() => actions.peekTerminal(k.address))
    .children(
      s.lines.map((l) =>
        div()
          .self_start()
          .mt(-4)
          .w(9)
          .h(17)
          .mr(4)
          .flex_none()
          .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
          .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(0)),
      ),
    )
    .when(Boolean(pic), (el) => el.child(div().mr(8).child(pic)))
    .child(
      div()
        .flex_1()
        .truncate()
        .text_color(on ? t.foreground : t.muted)
        .child(k.name || k.template || k.program?.name || k.address),
    )
    .child(statusBadge(t, { status: st }, compact));
}

// The fold chevron; folded, the count too, colored by the most urgent one.
function foldButton(t, a, subs, { listed, folded }, actions) {
  const sts = subs.map((s) => kidStatus(s.t, listed));
  const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
  const open = !folded.has(a.address);
  return div()
    .id(`fold-${a.address}`)
    .h(18)
    .px(3)
    .gap(3)
    .flex()
    .items_center()
    .rounded(0)
    .text_size(11)
    .text_color(open ? t.dim : (t[top] ?? t.dim))
    .cursor_pointer()
    .hover((s) => s.bg(t.foreground + "14").text_color(t.foreground))
    .on_click((_e, cx) => {
      cx.stop_propagation();
      actions.fold(a.address, cx, open);
    })
    .child(
      svg(`mods/vectron-icons/chevron-${open ? "down" : "right"}.svg`)
        .size(11)
        .flex_none(),
    )
    .when(!open, (el) => el.child(String(subs.length)));
}

function railRow(
  t,
  a,
  i,
  { pic, label, detail, machine },
  { inputGlow, selectedCursor },
  actions,
) {
  const corner =
    a.status === "blocked"
      ? div()
          .absolute()
          .top(1)
          .right(1)
          .size(11)
          .bg(t.blocked)
          .text_size(8.5)
          .font_bold()
          .text_color(t.background)
          .flex()
          .items_center()
          .justify_center()
          .child("!")
      : ["working", "done", "idle"].includes(a.status)
        ? div()
            .absolute()
            .top(2)
            .right(2)
            .size(5)
            .when(a.status === "idle", (d) => d.border(1).border_color(t.idle ?? t.dim))
            .when(a.status !== "idle", (d) => d.bg(t[a.status] ?? t.dim))
            .when(a.status === "working", (d) =>
              d.loop("opacity", { from: 0.35, to: 1, period: 1200 }),
            )
        : null;
  return div()
    .id(`ag-${a.address}`)
    .relative()
    .child(inputGlow.layer(a.address))
    .size(30)
    .flex_none()
    .flex()
    .items_center()
    .justify_center()
    .rounded(0)
    .border(1)
    .text_size(11)
    .font_bold()
    .tooltip([label, detail, machine].filter(Boolean).join(" \u00b7 "))
    .when(a.focused, (el) => el.bg(t.foreground + "2e").border_color(t.foreground + "40"))
    .when(!a.focused, (el) =>
      el
        .border_color(t.border)
        .hover((s) => s.bg(t.foreground + "14").border_color(t.foreground + "40")),
    )
    .when(selectedCursor === a.address, (el) => el.border_color(keynavOutline(t)))
    .on_click(() => actions.focusPane(a.pane))
    .child(
      pic ??
        div()
          .text_color(t.muted)
          .child(String(i + 1)),
    )
    .when(Boolean(corner), (el) => el.child(corner));
}

function agentRow(t, a, i, subs, frame, actions) {
  const { inputGlow, selectedCursor, labels, details } = frame;
  const pic = programIcon(a.program, 16, t.foreground, inputGlow.iconPulse(a.address, t));
  const detail = details.get(a.address);
  const label = labels.get(a.address);
  // An agent on another machine (`vps/t7`) says which.
  const machine = a.address.includes("/") ? a.address.split("/")[0] : null;

  if (frame.collapsed) {
    return railRow(t, a, i, { pic, label, detail, machine }, frame, actions);
  }

  const when = frame.changed[a.address]?.at ?? 0;
  const idle = a.status === "idle" && !a.focused;
  const isPinned = a.pinned;
  const pin = div()
    .id(`pin-${a.address}`)
    .flex_none()
    .p(2)
    .rounded(0)
    .text_color(t.dim)
    .cursor_pointer()
    .hover((s) => s.bg(t.foreground + "14").text_color(t.foreground))
    .tooltip(isPinned ? "Unpin" : "Pin to the top")
    .on_click((_e, cx) => {
      cx.stop_propagation();
      actions.pin(a.address, !isPinned, cx);
    })
    .child(svg(`mods/vectron-icons/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
  // Two lines: on top, which agent it is: its task (the title it set, or a tab someone named),
  // or "✦ New ✦" in the theme's cyan (no status uses it) when it has none; below,
  // quieter, its tab number and space ("2 · Desktop").
  const name = a.space_name || label;
  const task = detail && detail !== name ? detail : "";
  return h_flex()
    .id(`ag-${a.address}`)
    .relative()
    .child(inputGlow.layer(a.address))
    .px(8)
    .h(36)
    .flex_none()
    .rounded(0)
    .border(1)
    .border_color(selectedCursor === a.address ? keynavOutline(t) : t.foreground + "00")
    .items_center()
    .gap(8)
    .when(a.focused, (el) =>
      el
        .bg(t.foreground + "2e")
        .child(div().absolute().left(-1).top(-1).bottom(-1).w(2).bg(t.accent)),
    )
    .cursor_pointer()
    .when(!a.focused, (el) =>
      el.hover((s) => s.bg(t.foreground + "14").border_color(t.foreground + "40")),
    )
    .on_hover((on, cx) => actions.hover(a.address, on, cx))
    .on_click(() => actions.focusPane(a.pane))
    .when(Boolean(pic), (el) =>
      el.child(
        div()
          .id(`agent-fold-${a.address}`)
          .when(subs.length > 0, (el) =>
            el.on_click((_e, cx) => {
              cx.stop_propagation();
              actions.fold(a.address, cx);
            }),
          )
          .child(pic),
      ),
    )
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .child(
          task
            ? div()
                .min_w(0)
                .truncate()
                .line_height("15px")
                .text_color(idle ? t.muted : t.foreground)
                .child(task)
            : div()
                .line_height("15px")
                .text_color(t.ansi6 ?? t.dim)
                .child("✦ New ✦"),
        )
        .child(
          h_flex()
            .min_w(0)
            .text_size(11)
            .line_height("13px")
            .text_color(t.dim)
            .child(div().flex_none().child(`${a.tab_index} · `))
            .child(div().min_w(0).truncate().child(name)),
        ),
    )
    .when(Boolean(machine), (el) =>
      el.child(div().text_size(10).text_color(t.dim).child(machine)),
    )
    .when(subs.length > 0, (el) => el.child(foldButton(t, a, subs, frame, actions)))
    .when(frame.hovered === a.address, (el) => el.child(pin))
    .when(frame.hovered !== a.address && Boolean(when), (el) =>
      el.child(
        div()
          .flex_none()
          .text_size(11)
          .line_height("11px")
          .text_color(t.dim)
          .child(duration(frame.now - when)),
      ),
    )
    .child(statusBadge(t, a, frame.byPriority && !isPinned));
}

// A group's header; it folds the group. Folded, it says how many and the most urgent state.
function groupHeader(t, g, { folded, byPriority }, actions) {
  const open = !folded.has(g.id);
  const top = g.members.reduce(
    (m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m),
    null,
  );
  return h_flex()
    .id(g.id)
    .px(8)
    .pt(6)
    .h(26)
    .flex_none()
    .gap(6)
    .items_center()
    .text_size(11)
    .cursor_pointer()
    .hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => {
      actions.fold(g.id, cx, open);
    })
    .child(
      div()
        .truncate()
        .text_color(t[g.status] ?? t.dim)
        .child((g.label ?? "").toLowerCase()),
    )
    .when(byPriority || !open, (el) =>
      el.child(div().text_color(t.dim).child(`[${g.members.length}]`)),
    )
    .child(div().flex_1())
    .when(!open, (el) =>
      el
        .when(!byPriority && top && top !== "idle", (el) =>
          el.child(statusBadge(t, { status: top }, true)),
        )
        .child(
          svg("mods/vectron-icons/chevron-right.svg").size(11).flex_none().text_color(t.dim),
        ),
    );
}

export function renderAgentRows(t, { list, groups }, frame, actions) {
  const { all, collapsed, folded, listed, shown, byPriority } = frame;
  const withChildren = (agent, index) => {
    const descendants = collapsed ? [] : agentTree(all, agent.address);
    const row = agentRow(t, agent, index, descendants, frame, actions);
    if (folded.has(agent.address)) return [row];

    return [
      row,
      ...descendants.map((child) => childRow(t, child, shown, byPriority, listed, actions)),
    ];
  };

  return collapsed
    ? list.flatMap(withChildren)
    : groups.flatMap((group) => [
        groupHeader(t, group, frame, actions),
        ...(folded.has(group.id) ? [] : group.members.flatMap(withChildren)),
      ]);
}
