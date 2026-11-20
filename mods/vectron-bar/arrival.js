// Herdr loads each mod independently. Keep the bar, tabs and pane copies in sync.
import { div } from "gpui-kit";
import { shared } from "herdr";

export const arrivalKey = "vectron.edge-arrival";
export const arrivalFadeMs = 300;

export function activeArrival(focus) {
  const arrival = shared(arrivalKey);
  if (!arrival || arrival.expiresAt <= Date.now()) return null;
  if (arrival.terminal !== (focus?.shown ?? focus?.terminal)) return null;
  return arrival;
}

export function arrivalMarker(arrival, t, surface) {
  return div()
    .id(`edge-arrival-${surface}-${arrival.id}`)
    .flex_none()
    .font_semibold()
    .text_color(t[arrival.status])
    .opacity(arrival.fading ? 0 : 1)
    .transition("opacity", { duration: arrivalFadeMs, easing: "ease-out" })
    .child(arrival.status === "blocked" ? "◆" : "✓");
}
