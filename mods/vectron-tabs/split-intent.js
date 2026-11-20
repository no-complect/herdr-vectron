// Herdr loads each mod independently. Keep the pane and tabs copies in sync.
import { focused, panes, run, setShared } from "herdr";

export const splitKey = "vectron.pane-split";

export function splitPane(direction, pane = focused()?.pane) {
  const all = panes();
  const source = all.find((item) => item.pane === pane);
  if (source) {
    setShared(splitKey, {
      id: `${Date.now()}-${Math.random()}`,
      tab: source.tab,
      source: pane,
      before: all.filter((item) => item.tab === source.tab).map((item) => item.pane),
      direction,
      expiresAt: Date.now() + 2500,
    });
  }
  run("pane.split", pane ? { direction, pane } : { direction });
}
