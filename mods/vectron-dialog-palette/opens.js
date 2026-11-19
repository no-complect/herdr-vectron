// Opens another vectron mod, or Herdr's own equivalent when that mod isn't installed, so this
// mod works on its own. A mod can't import from another mod's folder: vectron-bar, vectron-chrome
// and vectron-dialog-palette each have a copy of this file; change all three.

import { run, readTextFile, appHome } from "herdr";

const FALLBACK = {
  "vectron-dialog-palette": ["app.palette"],
  "vectron-settings": ["app.settings"],
  "vectron-keys": ["app.help"],
  "vectron-dialog-picker": ["mod.open", { name: "vectron-picker" }],
};

// name -> true / false once looked at; unknown counts as installed.
const installed = {};

// Looks for each mod's main.js, then re-renders (cx: the caller's context).
export function lookFor(names, cx) {
  cx.spawn(async (cx) => {
    for (const name of names) installed[name] = (await readTextFile(`${appHome()}/mods/${name}/main.js`)) != null;
    cx.notify();
  });
}

// Something opens it: the mod itself, or its fallback.
export const canOpen = (name) => installed[name] !== false || name in FALLBACK;

export function openMod(name) {
  if (installed[name] !== false) run("mod.open", { name });
  else if (FALLBACK[name]) run(...FALLBACK[name]);
}
