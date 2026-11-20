import assert from "node:assert/strict";
import test from "node:test";
import { Element, find, loadMod } from "./support/herdr.mjs";

const diff = [
  "@@ -10,2 +10,2 @@ title", "-old", "+new", " context",
  "@@ -400 +400,0 @@ other", "-removed",
  "@@ -500,0 +501 @@ end", "+added",
];
const plain = (value) => JSON.parse(JSON.stringify(value));
const named = (tree, id) => find(tree, (el) => el.calls.id?.[0] === id);
const noop = () => {};
const theme = { ansi1: "#ff5577", ansi2: "#77ecab", accent: "#f2fb61" };

test("Diff Sweep maps actual edits to the header rows for mixed, deletion-only, and added hunks", async () => {
  const { parseDiffPreview } = await import("../vectron-changes/diff-preview.js");
  const { rows, hunks, extent, wholeFile } = parseDiffPreview(diff);
  assert.deepEqual(hunks, [
    { row: 0, revealRow: 2, line: 10, add: 1, del: 1 },
    { row: 4, revealRow: 5, line: 400, add: 0, del: 1 },
    { row: 6, revealRow: 7, line: 501, add: 1, del: 0 },
  ]);
  assert.deepEqual(hunks.map(({ row }) => rows[row].kind), ["@", "@", "@"]);
  assert.equal(rows[3].number, 11);
  assert.equal(extent, 501);
  assert.equal(wholeFile, false);

  const newFile = parseDiffPreview([
    "@@ -0,0 +1,3 @@", "+a", "+b", "+c",
  ], { newFile: true });
  assert.equal(newFile.wholeFile, true);
  assert.equal(newFile.extent, 3);
  assert.deepEqual(parseDiffPreview(["Binary file changed"]).hunks, []);
});

test("Diff Sweep exposes only hunks with an edit inside the loaded preview", async () => {
  const { parseDiffPreview } = await import("../vectron-changes/diff-preview.js");
  const preview = parseDiffPreview([
    "@@ -1,1498 +1,1498 @@", "-old", "+new", ...Array(1497).fill(" context"),
    "@@ -9000 +9000 @@", "-hidden", "+hidden",
  ]);
  assert.equal(preview.rows.length, 1500);
  assert.equal(preview.limited, true);
  assert.deepEqual(preview.hunks.map(({ row }) => row), [0]);

  const orphanHeader = parseDiffPreview([...diff, "@@ -9000 +9000 @@"], { limited: true });
  assert.equal(orphanHeader.limited, true);
  assert.equal(orphanHeader.hunks.length, 3);
});

async function changes(exec, wrap = false) {
  const native = { jumps: [], timers: [] };
  const handle = (mode) => ({ new: () => ({
    scroll_to_item: (...args) => native.jumps.push([mode, ...args]),
    release: noop,
  }) });
  const { default: Changes } = await loadMod("vectron-changes", "main.js", {
    herdr: {
      exec, focused: () => ({ pane: null, cwd: "/repo" }), spaces: () => [], panes: () => [],
      readTextFile: noop, watchFolder: noop, theme: () => theme, settings: () => ({}), props: noop,
      run: noop, shared: (key) => key === "vectron-changes.wrap" && wrap,
      setShared: noop, nextCommand: noop, openOverlay: noop, closeOverlay: noop,
      home: noop, notify: noop, knownAgents: noop, updates: noop,
    },
    "gpui-kit": { PathBuilder: noop },
    "gpui-base": {
      v_virtual_list: () => new Element("virtual"),
      TextView: noop,
      ScrollHandle: handle("wrapped"),
      VirtualListScrollHandle: handle("unwrapped"),
    },
  });
  const view = new Changes();
  const cx = { notify: noop, focus_handle: noop, spawn: noop, stop_propagation: noop,
    timer: { every: noop, after: (_ms, callback) => native.timers.push(callback) } };

  view.refresh = noop;
  view.init({}, cx);
  Object.assign(view, {
    root: "/repo", context: '{"cwd":"/repo","on":null}', hasHead: true,
    files: [{ path: "a.txt" }, { path: "b.txt" }], open: "a.txt",
  });
  return { view, cx, ...native };
}

test("Diff Sweep jumps via both native scroll containers and cycles clustered marks", async () => {
  for (const wrap of [false, true]) {
    const { view, cx, jumps, timers } = await changes(async () => ({ code: 0, stdout: diff.join("\n") }), wrap);
    await view.load(view.open, view.context);
    assert.equal(typeof view.diffView, "function");
    const render = () => view.diffView(theme, wrap, cx);
    const rail = () => named(render(), "changes-diff-sweep");
    rail().calls.on_size_change[0]({ height: 20, width: 24 }, cx);
    const click = named(rail(), "changes-hunks-4").calls.on_click[0];
    click({}, cx);
    click({}, cx);
    assert.deepEqual(jumps, wrap
      ? [["wrapped", 5], ["wrapped", 7]]
      : [["unwrapped", 4, "center"], ["unwrapped", 6, "center"]]);

    assert.equal(timers.length, 2);
    timers.splice(0).forEach((callback) => callback(cx));
    await view.load(view.open, view.context);
    assert.ok(named(rail(), "changes-hunks-4"));
    assert.equal(timers.length, 0);
  }
});

test("changes rows and sweep data ignore a late result after reselecting the same file", async () => {
  const requests = [];
  const { view } = await changes(() => new Promise((resolve) => requests.push(resolve)));
  const original = view.load("a.txt", view.context);
  view.open = "b.txt";
  const alternate = view.load("b.txt", view.context);
  view.open = "a.txt";
  const newest = view.load("a.txt", view.context);
  requests[2]({ code: 0, stdout: "@@ -99 +99 @@\n-old\n+last" });
  await newest;
  requests[1]({ code: 0, stdout: "@@ -44 +44 @@\n-old\n+other" });
  requests[0]({ code: 0, stdout: diff.join("\n") });
  await Promise.all([original, alternate]);

  assert.equal(view.rows.at(-1).text, "last");
  assert.deepEqual(plain(view.diffPreview.hunks), [{ row: 0, revealRow: 2, line: 99, add: 1, del: 1 }]);
});
