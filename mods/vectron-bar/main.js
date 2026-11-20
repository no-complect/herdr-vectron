import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  spaces,
  agents,
  theme,
  run,
  window,
  props,
  layout,
  shared,
  setShared,
  focused,
  home,
} from "herdr";
import { setZoomBorder, ZOOM_BORDER } from "./zoom.js";
import { lookFor, openMod } from "./opens.js";
import { EdgeAlerts } from "./edge-alerts.js";
import { activeArrival, arrivalMarker } from "./arrival.js";
import { CabinetIntro } from "./cabinet.js";

const own = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same toggle as vectron-chrome's header: the rail goes by width.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  const narrow = (width ?? Infinity) < 160;
  if (!narrow) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow);
  run("layout.resize", {
    id: "sidebar",
    px: narrow ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44,
  });
}

export default class VectronBar extends View {
  edgeAlerts = new EdgeAlerts();
  cabinet = new CabinetIntro();

  init(_props, cx) {
    lookFor(["vectron-dialog-palette", "vectron-dialog-picker"], cx);
  }

  render(cx) {
    const t = theme();
    const part = props()?.part;
    const row = h_flex()
      .id(`vectron-${part}`)
      .size_full()
      .items_center()
      .bg(t.chrome)
      .text_size(12)
      .text_color(t.muted)
      .overflow_hidden();
    if (part === "right") return this.right(row, t);
    return this.left(row, t, cx);
  }

  left(row, t, cx) {
    const list = spaces();
    const zoomed = Boolean(list.find((s) => s.active)?.tabs.find((tab) => tab.active)?.zoomed);
    if (zoomed !== this.zoomed) {
      // First render only fixes a thick frame left over from a zoom when the app quit.
      if (
        zoomed ||
        this.zoomed !== undefined ||
        find(layout(), "main")?.content?.pane?.focus?.width === ZOOM_BORDER
      )
        setZoomBorder(zoomed);
      this.zoomed = zoomed;
    }
    const liveAgents = agents();
    const focus = focused();
    const alerts = this.edgeAlerts.render(liveAgents, focus, t, cx);
    const blocked = new Set(
      liveAgents
        .filter((a) => a.status === "blocked")
        .map((a) => a.space),
    );
    const space = list.find((s) => s.active);
    const arrival = activeArrival(focus);
    const cwd = focus?.cwd;
    const here = cwd ? (cwd === home() ? "~" : cwd.split("/").filter(Boolean).pop()) : null;
    const sep = () => div().flex_none().mx(10).text_color(t.border).child("│");
    // macOS draws its window buttons over this corner; leave them room.
    const w = window();
    const inset = w?.platform === "macos" && !w.fullscreen ? 76 : 4;
    const sweep = this.cabinet.sweep(t, inset + 12);
    return row
      .relative()
      .pl(inset)
      .on_size_change(({ width }, cx) => {
        this.cabinet.measure(width, cx);
        const narrow = globalThis.window.viewport_size().width < 1024;
        if (narrow !== this.narrow) {
          this.narrow = narrow;
          const sizes = narrow
            ? [
                ["bar-left", { weight: 1 }],
                ["ai-usage", { weight: 2 }],
                ["bar-right", { px: w?.buttons ? 90 : 0 }],
              ]
            : [
                ["bar-left", { weight: 3 }],
                ["ai-usage", { weight: 2.5 }],
                ["bar-right", { weight: 3 }],
              ];
          for (const [id, size] of sizes) {
            const current = find(layout(), id)?.size;
            if (current && (current.px !== size.px || current.weight !== size.weight))
              run("layout.resize", { id, ...size });
          }
          cx.notify();
        }
      })
      .child(
        own(
          div()
            .id("menu")
            .flex_none()
            .size(24)
            .mr(6)
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click(() => openMod("vectron-dialog-palette"))
            .text_color(t.accent)
            .child(this.cabinet.logo(t)),
        ),
      )
      .child(
        own(
          div()
            .id("sidebar-toggle")
            .flex_none()
            .w(30)
            .h_full()
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(toggleSidebar)
            .child(svg("mods/vectron-icons/sidebar.svg").size(14)),
        ),
      )
      .when(!this.narrow, (el) =>
        el.children(
          list.map((s, i) => {
            const col = blocked.has(s.id) ? t.blocked : s.active ? t.foreground : t.dim;
            return div()
              .id(`ws-${s.id}`)
              .flex_none()
              .h_full()
              .px(8)
              .flex()
              .items_center()
              .justify_center()
              .cursor_pointer()
              .border_b(2)
              .border_color(s.active ? t.accent : "#00000000")
              .text_color(col)
              .hover((st) => st.text_color(t.foreground).bg(t.hover))
              .on_click(() => run("space.select", { id: s.id }))
              .child(String(i + 1));
          }),
        ),
      )
      .child(
        own(
          div()
            .id("search")
            .flex_none()
            .w(30)
            .h_full()
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => openMod("vectron-dialog-picker"))
            .child(svg("mods/vectron-icons/search.svg").size(14)),
        ),
      )
      .children(alerts)
      .when(Boolean(space), (el) =>
        el
          .child(sep())
          .child(div().flex_none().text_color(t.foreground).child(space.name))
          .when(arrival?.space === space.id, (e) =>
            e.child(arrivalMarker(arrival, t, "space").ml(5)),
          )
          // The focused terminal may have moved away from the folder its space was named after.
          .when(Boolean(here) && here !== space.name, (e) =>
            e.child(div().flex_none().ml(8).text_color(t.muted).child(here)),
          )
          .when(Boolean(space.branch), (e) =>
            e.child(div().flex_none().ml(8).text_color(t.dim).child(space.branch)),
          )
          .when(Boolean(space.machine), (e) =>
            e.child(div().flex_none().ml(8).text_color(t.dim).child(`@${space.machine}`)),
          ),
      )
      .when(Boolean(sweep), (el) => el.child(sweep));
  }

  right(row, t) {
    const w = window();
    const btn = (id, icon, cmd, danger) =>
      own(
        div()
          .id(id)
          .flex_none()
          .w(30)
          .h_full()
          .flex()
          .items_center()
          .justify_center()
          .cursor_pointer()
          .text_color(t.dim)
          .hover((s) =>
            s.bg(danger ? t.blocked : t.hover).text_color(danger ? t.background : t.foreground),
          )
          .on_click(() => run(cmd))
          .child(svg(`mods/terminals-bar/${icon}.svg`).size(14)),
      );
    return row.justify_end().when(Boolean(w?.buttons), (el) =>
      el
        .child(btn("wb-min", "win-min", "window.minimize"))
        .child(btn("wb-max", w.maximized ? "win-restore" : "win-max", "window.maximize"))
        .child(btn("wb-close", "win-close", "window.close", true)),
    );
  }
}
