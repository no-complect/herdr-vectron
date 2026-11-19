import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { find, loadMod } from "../../mods/test/support/herdr.mjs";

test("Vectron has an opaque 16-color palette and both shell themes use it", async () => {
  const palette = JSON.parse(await readFile(new URL("../vectron.json", import.meta.url), "utf8"));
  const layout = JSON.parse(
    await readFile(new URL("../../layouts/vectron.json", import.meta.url), "utf8"),
  );

  assert.equal(palette.ansi.length, 16);
  for (const color of [...palette.ansi, ...Object.values(palette.colors)]) {
    assert.match(color, /^#[\da-f]{6}$/i);
  }
  for (const token of ["working", "blocked", "done", "idle", "accent", "border", "surface"]) {
    assert.ok(palette.colors[token], token);
  }
  assert.deepEqual(layout.theme, { light: "vectron", dark: "vectron" });
});

test("applying Vectron switches to dark mode when needed and preserves unrelated settings", async () => {
  const calls = [];
  const raw = JSON.stringify({ zoom: 1.2, sounds: { enabled: false } });
  const herdr = {
    themes: () => [{ name: "vectron", light: false }],
    settings: () => ({ dark: false }),
    run: (name, args) => calls.push([name, args.name]),
    theme: () => ({ accent: "#f2f54a" }),
    props: () => ({ overlay: "theme-picker" }),
    closeOverlay: (id) => calls.push(["close", id]),
    appHome: () => "/fixture",
    readTextFile: async () => raw,
    writeTextFile: async (path, body, expected) => {
      assert.equal(path, "/fixture/settings.json");
      assert.equal(expected, raw);
      assert.deepEqual(JSON.parse(body), {
        appearance: "dark",
        zoom: 1.2,
        sounds: { enabled: false },
      });
      calls.push(["write"]);
    },
  };
  const { default: Themes } = await loadMod("vectron-themes", "main.js", { herdr });
  await new Themes().pick({ name: "vectron", light: false });
  assert.deepEqual(calls, [["write"], ["app.theme", "vectron"], ["close", "theme-picker"]]);
});

test("the package ships just Vectron and the preview applies it from the keyboard", async () => {
  const themes = await readdir(new URL("../", import.meta.url));
  assert.deepEqual(
    themes.filter((name) => name.endsWith(".json")),
    ["vectron.json"],
  );

  const calls = [];
  const herdr = {
    themes: () => [
      { name: "vectron", light: false },
      { name: "catppuccin", light: false },
    ],
    settings: () => ({ dark: true, theme: "catppuccin" }),
    run: (_name, { name }) => calls.push(name),
    theme: () => ({ accent: "#f2f54a" }),
    props: () => ({ overlay: "theme-picker" }),
    closeOverlay: (id) => calls.push(id),
    appHome: () => "/fixture",
    readTextFile: () => assert.fail("Already in the matching appearance"),
    writeTextFile: () => assert.fail("Already in the matching appearance"),
  };
  const { default: Themes } = await loadMod("vectron-themes", "main.js", { herdr });
  const view = new Themes();
  const focus = { focus() {} };
  view.init({}, { focus_handle: () => focus, timer: { after() {} } });
  const root = view.render();

  assert.ok(find(root, (node) => node.kind === "image" && node.args[0] === "layouts/vectron.png"));
  await root.calls.on_key_down[0]({ key: "enter" });
  assert.deepEqual(calls, ["vectron", "theme-picker"]);
  root.calls.on_key_down[0]({ key: "[", modifiers: { control: true } });
  assert.equal(calls.at(-1), "theme-picker");
});
