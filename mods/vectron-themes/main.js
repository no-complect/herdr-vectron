import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  appHome,
  closeOverlay,
  props,
  readTextFile,
  run,
  settings,
  theme,
  themes,
  writeTextFile,
} from "herdr";

const PREVIEW = "layouts/vectron.png";
const PREVIEW_ASPECT = 760 / 487;

export default class VectronThemes extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(100, () => this.handle.focus());
  }

  async pick(choice) {
    if (choice.light === Boolean(settings().dark)) {
      const file = `${appHome()}/settings.json`;
      const raw = await readTextFile(file).catch(() => null);
      let preferences = {};

      try {
        preferences = JSON.parse(raw ?? "{}");
      } catch {
        // Herdr compares the previous contents before writing.
      }

      const updated = { ...preferences, appearance: choice.light ? "light" : "dark" };
      await writeTextFile(file, JSON.stringify(updated, null, 2) + "\n", raw).catch(() => null);
    }

    run("app.theme", { name: choice.name });
    closeOverlay(props().overlay);
  }

  render() {
    const choice = themes().find(({ name }) => name === "vectron");
    if (!choice) return div().size_full();

    const { accent } = theme();
    const current = settings();
    const previewWidth = Math.round((this.size?.width ?? 1600) / (current.zoom ?? 1) / 2);
    const previewHeight = Math.round(previewWidth / PREVIEW_ASPECT);

    return v_flex()
      .id("vectron-themes")
      .track_focus(this.handle)
      .size_full()
      .gap(28)
      .items_center()
      .justify_center()
      .bg("#000000cc")
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .on_key_down((event) => {
        if (event.key === "escape" || (event.key === "[" && event.modifiers?.control)) {
          return closeOverlay(props().overlay);
        }
        if (event.key === "enter") return this.pick(choice);
      })
      .child(
        div()
          .id("th-chosen")
          .flex_none()
          .border_3()
          .border_color(accent)
          .cursor_pointer()
          .on_click(() => this.pick(choice))
          .child(image(PREVIEW).w(previewWidth).h(previewHeight)),
      )
      .child(
        h_flex()
          .gap(12)
          .items_center()
          .child(div().text_size(30).font_semibold().text_color("#ffffffee").child("Vectron"))
          .when(choice.name === current.theme, (el) =>
            el.child(
              div()
                .px(6)
                .border_1()
                .border_color(accent)
                .text_size(12)
                .text_color(accent)
                .child("current"),
            ),
          ),
      );
  }
}
