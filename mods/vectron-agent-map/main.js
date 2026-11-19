import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, closeOverlay, focused, panes, props, run, spaces, terminals, theme } from "herdr";
import { buildAgentMap, nodeHeight, nodeWidth } from "./model.js";

const glyphs = {
  codex: "codex",
  "codex-cli": "codex",
  claude: "claude",
  "claude-code": "claude",
  grok: "grok",
  "grok-build": "grok",
  agy: "antigravity",
  antigravity: "antigravity",
  "antigravity-cli": "antigravity",
};

const statuses = {
  blocked: "Needs input",
  working: "Working",
  done: "Done",
  idle: "Idle",
};

function icon(program, color) {
  const glyph = Object.hasOwn(glyphs, program?.key) && glyphs[program.key];
  if (glyph) return svg(`mods/vectron-icons/${glyph}.svg`).size(17).flex_none().text_color(color);

  const path = program?.icon;
  if (path) {
    return program.tint
      ? svg(path).size(17).flex_none().text_color(color)
      : image(path).size(17).flex_none();
  }

  return div().size(8).flex_none().border_1().border_color(color);
}

function cables(edges, t) {
  if (!edges.length) return [];

  const normal = PathBuilder.stroke(1.25);
  const attention = PathBuilder.stroke(1.5);
  let hasNormal = false;
  let hasAttention = false;

  for (const { parent, child } of edges) {
    const blocked = child.status === "blocked";
    const path = blocked ? attention : normal;
    path.move_to(parent.x + nodeWidth, parent.y).line_to(child.x, child.y);
    hasAttention ||= blocked;
    hasNormal ||= !blocked;
  }

  const layers = [];
  if (hasNormal) {
    layers.push(window.paint_path(normal.build(), t.border).absolute().top(0).left(0).size_full());
  }
  if (hasAttention) {
    layers.push(
      window.paint_path(attention.build(), t.blocked + "ad").absolute().top(0).left(0).size_full(),
    );
  }
  return layers;
}

export default class AgentMap extends View {
  closeMap() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  peek(address) {
    this.closeMap();
    run("terminal.peek", { terminal: address });
  }

  card(node, selected, t) {
    const status = Object.hasOwn(statuses, node.status) ? node.status : "unknown";
    const color = t[status];
    const border = status === "blocked" ? color : selected ? t.accent : t.border;
    return h_flex()
      .id(`agent-map-node-${node.address}`)
      .absolute()
      .left(node.x)
      .top(node.y - nodeHeight / 2)
      .w(nodeWidth)
      .h(nodeHeight)
      .px(10)
      .gap(8)
      .items_center()
      .border_1()
      .border_color(border)
      .bg(selected ? t.selected : t.surface)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).border_color(t.accent))
      .tooltip(`Peek at ${node.title}`)
      .on_click(() => this.peek(node.address))
      .child(icon(node.program, selected ? t.accent : color))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().text_size(12).text_color(t.foreground).truncate().child(node.title))
          .child(div().text_size(10).text_color(color).child(statuses[status] ?? "Status unavailable")),
      );
  }

  render() {
    const t = theme();
    const focus = focused();
    const allSpaces = spaces();
    const space =
      allSpaces.find((space) => space.id === focus?.space) ?? allSpaces.find((space) => space.active);
    const graph = space
      ? buildAgentMap(space, agents(), terminals(), panes())
      : buildAgentMap(null);
    const selected = focus?.agent ?? focus?.shown ?? focus?.terminal;

    const paths = cables(graph.edges, t);

    return v_flex()
      .id("agent-map")
      .size_full()
      .min_w(0)
      .min_h(0)
      .p(16)
      .gap(12)
      .bg(t.popover)
      .child(
        h_flex()
          .gap(12)
          .items_center()
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Agent map"))
          .when(Boolean(space), (el) =>
            el.child(
              div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(space.name),
            ),
          )
          .child(
            div()
              .id("agent-map-close")
              .ml_auto()
              .p(6)
              .cursor_pointer()
              .text_color(t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip("Close agent map")
              .on_click(() => this.closeMap())
              .child(svg("mods/vectron-icons/x.svg").size(14)),
          ),
      )
      .child(
        div()
          .id("agent-map-scroll")
          .flex_1()
          .min_w(0)
          .min_h(0)
          .bg(t.background)
          .border_1()
          .border_color(t.border)
          .overflow_scrollbar()
          .child(
            graph.nodes.length
              ? div()
                  .size_full()
                  .min_w(graph.width)
                  .min_h(graph.height)
                  .flex()
                  .items_center()
                  .justify_center()
                  .child(
                    div()
                      .relative()
                      .flex_none()
                      .w(graph.width)
                      .h(graph.height)
                      .children(paths)
                      .children(
                        graph.nodes.map((node) => this.card(node, node.address === selected, t)),
                      ),
                  )
              : div()
                  .p(18)
                  .text_size(12)
                  .text_color(t.muted)
                  .child(space ? "No active agents in this space." : "No space selected."),
          ),
      );
  }
}
