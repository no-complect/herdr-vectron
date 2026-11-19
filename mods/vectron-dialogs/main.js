import { View } from "gpui-kit";
import { props } from "herdr";
import { AgentLauncher } from "./agent-launcher.js";
import { SpaceMenu } from "./space-menu.js";
import { SpaceName } from "./space-name.js";

export default class Dialogs extends View {
  init(_props, cx) {
    const options = props() ?? {};
    switch (options.part) {
      case "agent-launcher":
        this.page = new AgentLauncher(cx);
        break;
      case "space-menu":
        this.page = new SpaceMenu(options.id, cx);
        break;
      default:
        this.page = new SpaceName(options.id, cx);
    }
  }

  render() {
    return this.page.render();
  }
}
