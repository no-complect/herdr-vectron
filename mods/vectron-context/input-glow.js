import { theme } from "herdr";
import { Flash, flashColor } from "./beam.js";

const typingIntervalMs = 850;

export class InputGlow {
  flash = new Flash();
  lastTyping = -Infinity;
  color = null;
  selected = undefined;
  confirming = false;

  start(cx, key, alreadyRendering = false) {
    this.color = flashColor(this.color, theme());
    this.flash.start(cx, new Map([[key, this.color]]), { alreadyRendering });
  }

  typing(cx, key = "input") {
    const now = Date.now();
    if (now - this.lastTyping < typingIntervalMs) return;
    this.lastTyping = now;
    this.start(cx, key);
  }

  selection(cx, key) {
    const previous = this.selected;
    this.selected = key;
    if (key != null && previous !== undefined && previous !== key) this.start(cx, key, true);
  }

  confirm(cx, action, key = "input") {
    if (this.confirming) return;
    this.confirming = true;
    this.start(cx, key);
    cx.timer.after(90, (cx) => {
      this.confirming = false;
      action(cx);
    });
  }

  layer(key = "input") {
    return this.flash.layer(key);
  }
}
