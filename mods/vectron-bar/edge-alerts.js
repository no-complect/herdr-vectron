import { div } from "gpui-kit";
import { agents, focused, run } from "herdr";

const statuses = ["blocked", "done"];
const brightMs = 65;
const fadeMs = 320;

function shownTerminal(focus) {
  return focus?.shown ?? focus?.terminal;
}

function marker(status, group, pulse, t) {
  const { target, count } = group;
  const color = t[status];
  const subject = count === 1 ? "1 agent" : `${count} agents`;
  const action = status === "blocked" ? (count === 1 ? "needs input" : "need input") : "finished";
  const title = target.title || target.program?.name || target.address;
  const location = [target.space_name, target.tab_name].filter(Boolean).join(" / ");
  const tooltip = [`${subject} ${action}`, title, location].filter(Boolean).join("\n");

  return div()
    .id(`edge-alert-${status}`)
    .relative()
    .h_full()
    .min_w(24)
    .px(5)
    .flex_none()
    .flex()
    .items_center()
    .justify_center()
    .cursor_pointer()
    .text_color(color)
    .tooltip(tooltip)
    .hover((style) => style.bg(t.hover))
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
    .on_click((_event, cx) => {
      cx.stop_propagation();
      const terminal = target.address;
      if (terminal === shownTerminal(focused())) return;
      if (agents().some((agent) => agent.address === terminal && agent.status === status)) {
        run("agent.focus", { terminal });
      }
    })
    .child(div().absolute().left(2).right(2).bottom(0).h(2).bg(color))
    .when(Boolean(pulse), (el) => el.child(
      div()
        .id(`edge-pulse-${status}-${pulse.sequence}`)
        .absolute()
        .left(0)
        .right(0)
        .bottom(0)
        .h(8)
        .bg(color)
        .opacity(pulse.opacity)
        .transition("opacity", { duration: fadeMs, easing: "ease-out" }),
    ))
    .child(`${status === "blocked" ? "◆" : "✓"}${count > 1 ? ` ${count}` : ""}`);
}

export class EdgeAlerts {
  #previous = new Map();
  #pulses = new Map();
  #sequence = 0;

  render(list, focus, t, cx) {
    const shown = shownTerminal(focus);
    const current = new Map();
    const groups = new Map();
    for (const agent of list) {
      const { address, status, seq } = agent;
      current.set(address, status);
      if (address === shown || !statuses.includes(status)) continue;

      const group = groups.get(status) ?? { target: agent, count: 0, changed: null };
      group.count++;
      if (seq > group.target.seq) group.target = agent;
      const before = this.#previous.get(address);
      // Fresh snapshots show existing alerts steadily. Returning focus never replays them.
      if (before && before !== status) group.changed = address;
      groups.set(status, group);
    }
    this.#previous = current;

    const markers = [];
    for (const status of statuses) {
      const pulse = this.#pulses.get(status);
      if (pulse && (pulse.address === shown || current.get(pulse.address) !== status)) {
        this.#pulses.delete(status);
      }
      const group = groups.get(status);
      if (!group) continue;
      if (group.changed) this.#flash(status, group.changed, cx);
      markers.push(marker(status, group, this.#pulses.get(status), t));
    }
    return markers;
  }

  #flash(status, address, cx) {
    const pulse = { address, sequence: ++this.#sequence, opacity: 1 };
    this.#pulses.set(status, pulse);
    cx.timer.after(brightMs, (cx) => {
      if (this.#pulses.get(status) !== pulse) return;
      pulse.opacity = 0;
      cx.notify();
    });
    cx.timer.after(brightMs + fadeMs, (cx) => {
      if (this.#pulses.get(status) !== pulse) return;
      this.#pulses.delete(status);
      cx.notify();
    });
  }
}
