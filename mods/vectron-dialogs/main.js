import { View } from "gpui-kit";
import { props } from "herdr";
import { SpaceMenu } from "./space-menu.js";
import { SpaceName } from "./space-name.js";

export default class Dialogs extends View {
  init(_props, cx) {
    const options = props() ?? {};
    this.page =
      options.part === "space-menu"
        ? new SpaceMenu(options.id, cx)
        : new SpaceName(options.id, cx);
  }

  render() {
    return this.page.render();
  }
}
