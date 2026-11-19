import { div, image, svg } from "gpui-kit";
import { InputState, v_flex } from "gpui-base";
import { keys, knownAgents, openOverlay, panes, run, setShared, shared, spaces, theme } from "herdr";
import { dismiss, flashingInput, menuRow } from "./controls.js";
import { InputGlow } from "./input-glow.js";

const cacheKey = "new-menu.agents";

export class AgentLauncher {
  constructor(cx) {
    this.handle = cx.focus_handle();
    this.space = spaces().find((space) => space.active);
    this.folder = panes().find((pane) => pane.focused)?.cwd;
    const machine = this.space?.machine;
    const cacheSlot = machine ?? "";
    this.agents = shared(cacheKey)?.[cacheSlot] ?? [];
    this.loading = true;
    this.failed = false;
    this.query = "";
    this.glow = new InputGlow();

    this.input = InputState.new({ placeholder: "Filter agents…" });
    this.input.on("change", (_event, cx) => {
      this.query = this.input.value().trim().toLowerCase();
      this.glow.typing(cx);
      cx.notify();
    });
    this.input.on("submit", () => {
      const agent = this.query && this.choices().find((agent) => agent.installed);
      if (agent) this.launch(agent);
    });
    this.input.focus();

    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared(cacheKey, { ...shared(cacheKey), [cacheSlot]: this.agents });
      } catch {
        this.failed = true;
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  choices() {
    const installed = this.agents.filter((agent) => agent.installed);
    const unavailable = this.failed ? [] : this.agents.filter((agent) => !agent.installed);
    if (!this.query) return [...installed, ...unavailable.slice(0, 2)];

    return [...installed, ...unavailable].filter(
      (agent) =>
        agent.name.toLowerCase().includes(this.query) || agent.key.toLowerCase().includes(this.query),
    );
  }

  launch(agent) {
    dismiss();
    run("tab.new", { name: agent.name, space: this.space?.id, argv: agent.run });
  }

  worktree(action) {
    dismiss();
    const opening = action === "open";
    openOverlay({
      mod: "worktree",
      kind: "dialog",
      width: opening ? 560 : 460,
      height: opening ? 480 : 280,
      props: { space: this.space.id, folder: this.folder, action },
    });
  }

  key(event, cx, choices) {
    if (event.key === "escape") {
      cx.stop_propagation();
      dismiss();
      return;
    }
    const held = event.modifiers;
    if (this.query || held?.control || held?.platform || held?.alt || held?.shift) return;
    if (!/^[1-9]$/.test(event.key)) return;
    const agent = choices[Number(event.key) - 1];
    if (agent?.installed) {
      cx.stop_propagation();
      this.launch(agent);
    }
  }

  render() {
    const t = theme();
    const choices = this.choices();
    const shortcut = (command) =>
      keys().find((binding) => binding.section === "global" && binding.action === command)?.keys ?? "";
    const icon = (name) => svg(`mods/workspace-chrome/${name}.svg`).size(14);
    const worktree = (id, title, action) =>
      menuRow(t, id, icon("branch"), title, () => this.worktree(action), { enabled: !!this.space });
    const empty = this.loading
      ? "Checking installed agents…"
      : this.failed
        ? "Could not check installed agents"
        : this.query
          ? "No matching agents"
          : "No agents available";

    return v_flex()
      .id("agent-launcher")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .h(Math.min(510, 205 + Math.max(1, choices.length) * 31 + (this.failed && choices.length ? 25 : 0)))
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((event, cx) => this.key(event, cx, choices))
      .child(
        menuRow(t, "launch-terminal", svg("icons/shell.svg").size(14), "Terminal", () => {
          dismiss();
          run("tab.new", { space: this.space?.id });
        }, { hint: shortcut("tab.new") }),
      )
      .child(div().px(9).pt(6).pb(4).text_size(11).text_color(t.dim).child("Start an agent"))
      .child(div().px(4).pb(4).child(flashingInput("agent-filter", this.input, this.glow, t)))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .children(choices.map((agent, index) =>
            menuRow(
              t,
              `launch-${agent.key}`,
              (agent.tint ? svg(agent.icon).text_color(t.foreground) : image(agent.icon)).size(14),
              agent.name,
              () => this.launch(agent),
              {
                enabled: agent.installed,
                hint: !agent.installed ? "not installed" : !this.query && index < 9 ? String(index + 1) : "",
              },
            ),
          ))
          .when(!choices.length || this.failed, (el) =>
            el.child(div().px(9).py(6).text_color(t.dim).child(empty)),
          ),
      )
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(menuRow(t, "launch-new-space", icon("plus"), "New space", () => {
        dismiss();
        run("space.new", { machine: this.space?.machine ?? "" });
      }, { hint: shortcut("space.new") }))
      .child(worktree("launch-worktree", "New worktree…", "new"))
      .child(worktree("launch-open-worktree", "Open worktree…", "open"));
  }
}
