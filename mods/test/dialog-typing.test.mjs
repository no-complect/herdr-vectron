import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { find, loadMod } from "./support/herdr.mjs";

const noop = () => {};
const space = { id: "remote/s1", machine: "remote", name: "Previous name", named: true, active: true };
const theme = {
  accent: "#f5fb62", ansi4: "#3287fe", ansi5: "#e34fd8", ansi6: "#8ae0c8",
  foreground: "#f0f4ff", dim: "#8091a8", input: "#26364f", popover: "#081022",
};

async function fixture(options = {}, activeSpaces = [space]) {
  let now = 1000;
  let focused = false;
  let value;
  let selection;
  const inputEvents = new Map();
  const calls = [];
  const dialogs = [];
  const tasks = [];
  const cx = {
    notify: noop,
    stop_propagation: noop,
    focus_handle: () => ({ focus: noop }),
    timer: { after: noop },
    sleep: () => new Promise(() => {}),
    spawn: (task) => tasks.push(task(cx)),
  };
  const { default: Dialogs } = await loadMod("vectron-dialogs", "main.js", {
    herdr: {
      props: () => ({ overlay: "dialog-1", ...options }),
      spaces: () => activeSpaces,
      panes: () => [],
      theme: () => theme,
      openOverlay: (spec) => dialogs.push(spec),
      closeOverlay: (id) => calls.push(["close", id]),
      run: (command, args) => calls.push([command, args]),
      exec: async () => ({ code: 1 }),
    },
    "gpui-base": {
      InputState: {
        new({ value: initial = "" }) {
          value = initial;
          return {
            value: () => value,
            on: (event, handler) => inputEvents.set(event, handler),
            focus: () => { focused = true; },
            set_selected_range: ({ start, end }) => { selection = [start, end]; },
          };
        },
      },
    },
  }, { Date: { now: () => now } });
  const view = new Dialogs();
  view.init({}, cx);
  await Promise.all(tasks.splice(0));

  return {
    cx, view, calls, dialogs,
    get input() { return { value, focused, selection }; },
    type(text, after = 0) {
      now += after;
      value = text;
      inputEvents.get("change")({}, cx);
    },
    submit: () => inputEvents.get("submit")({}, cx),
  };
}

const byId = (view, id) => find(view, (node) => node.calls.id?.[0] === id);
const flash = (view, sequence) => byId(view, `vector-flash-input-${sequence}-0-wash`);

test("typing a space name flashes the input on the palette cadence and renames the original space", async () => {
  const activeSpaces = [space];
  const f = await fixture({}, activeSpaces);
  assert.deepEqual(f.input, { value: "Previous name", selection: [0, 13], focused: true });
  assert.equal(flash(f.view.render(), 1), undefined);

  f.type("V");
  const first = flash(f.view.render(), 1);
  assert.equal(first.calls.opacity[0], 1);
  f.type("Ve", 100);
  assert.ok(flash(f.view.render(), 1));
  assert.equal(flash(f.view.render(), 2), undefined);
  f.type("Vector lab", 750);
  const next = flash(f.view.render(), 2);
  assert.ok(next);
  assert.notEqual(next.calls.bg[0], first.calls.bg[0]);

  activeSpaces[0] = { ...space, id: "remote/s2" };
  f.submit();
  assert.equal(f.calls[0][0], "close");
  assert.equal(f.calls[1][0], "space.rename");
  assert.equal(f.calls[1][1].id, space.id);
  assert.equal(f.calls[1][1].name, "Vector lab");
});

test("space menu Rename opens the flashing prompt for the clicked space and Escape cancels it", async () => {
  const target = { ...space, id: "remote/s2", named: false, active: false };
  const menu = await fixture({ part: "space-menu", id: target.id }, [space, target]);
  byId(menu.view.render(), "rename-space").calls.on_click[0]({}, menu.cx);
  assert.equal(menu.dialogs[0].mod, "vectron-dialogs");
  assert.equal(menu.dialogs[0].props.id, target.id);

  const prompt = await fixture({ id: target.id }, [space, target]);
  assert.equal(prompt.input.value, "");
  prompt.type("Draft name");
  byId(prompt.view.render(), "rename-space-prompt").calls.on_key_down[0]({ key: "escape" }, prompt.cx);
  assert.deepEqual(prompt.calls, [["close", "dialog-1"]]);
});

test("the Vectron rename shortcut and Whistle route into the flashing prompt", async () => {
  const root = new URL("../../", import.meta.url);
  const json = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
  const [keys, whistle] = await Promise.all([json("keys.json"), json("mods/whistle/mappings.json")]);
  assert.equal(keys["layout:vectron"]["shift-f2"], "mod.open:vectron-dialogs");
  assert.deepEqual(whistle.map.S.map.r, ["Rename space", "mod.open:vectron-dialogs"]);
});

test("both palettes and the Spaces menu use Vectron's rename prompt", async () => {
  const calls = [];
  const dialogs = [];
  const herdr = {
    commands: () => [], layouts: () => [], keys: () => [], props: () => ({}),
    run: (name, args) => calls.push([name, args]), theme: () => theme,
    spaces: () => [], panes: () => [], terminals: () => [],
    shared: noop, setShared: noop, openOverlay: (options) => dialogs.push(options),
    closeOverlay: noop, window: noop, readTextFile: noop, appHome: noop,
    focused: noop, layout: noop, exec: noop, home: noop, nextCommand: noop, notify: noop,
    machines: noop, agents: noop, hc: noop, watchFolder: noop,
  };
  const globals = { localStorage: { getItem: () => null, setItem: noop } };
  const load = (name) => loadMod(name, "main.js", { herdr }, globals);
  const [commandPalette, dialogPalette, spaces] = await Promise.all([
    load("vectron-command-palette"), load("vectron-dialog-palette"),
    load("vectron-spaces"),
  ]);

  for (const { default: Palette } of [commandPalette, dialogPalette]) {
    const view = new Palette();
    view.recent = [];
    view.go({ name: "space.rename", id: "space.rename:{}", args: {} });
  }
  assert.deepEqual(calls.map(([command, args]) => [command, args.name]), [
    ["mod.open", "vectron-dialogs"], ["mod.open", "vectron-dialogs"],
  ]);

  new spaces.default().menu(space);
  assert.equal(dialogs[0].mod, "vectron-dialogs");
  assert.equal(dialogs[0].props.part, "space-menu");
  assert.equal(dialogs[0].props.id, space.id);
});
