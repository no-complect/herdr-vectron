// Herdr loads JavaScript within each mod. The SVG assets are shared across Vectron.
import { div, image, svg } from "gpui-kit";

const glyphs = new Map([
  ["codex", "codex"],
  ["codex-cli", "codex"],
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["grok", "grok"],
  ["grok-build", "grok"],
  ["antigravity", "antigravity"],
  ["antigravity-cli", "antigravity"],
  ["agy", "antigravity"],
]);

export function programIcon(program, size, color, pulse = null) {
  const glyph = glyphs.get(program?.key);
  if (glyph) {
    const draw = (tint) => svg(`mods/vectron-icons/${glyph}.svg`).size(size).flex_none().text_color(tint);
    const base = draw(color);
    if (!pulse) return base;

    return div().relative().size(size).flex_none()
      .child(base)
      .child(div().id(`${pulse.id}-glyph-${program.key}`).absolute().inset_0()
        .opacity(pulse.opacity)
        .transition("opacity", { duration: pulse.duration, easing: "ease-out" })
        .child(draw(pulse.color)));
  }
  if (!program?.icon) return null;

  return program.tint
    ? svg(program.icon).size(size).flex_none().text_color(color)
    : image(program.icon).size(size).flex_none();
}
