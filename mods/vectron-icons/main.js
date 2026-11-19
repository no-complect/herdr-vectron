// Vectron icons: the SVGs the vectron mods draw (svg("mods/vectron-icons/<name>.svg")).
// Assets only; Herdr needs a view, so this one draws nothing and never shows ("place": "none").

import { View, div } from "gpui-kit";

export default class Icons extends View {
  render() {
    return div();
  }
}
