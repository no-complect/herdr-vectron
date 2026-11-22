import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { discoverDocuments, skillInvocation } from "../vectron-egm/documents.js";
import { Element, find, loadMod } from "./support/herdr.mjs";

const exec = promisify(execFile);

test("EGM detection requires an enabled installation on a supported agent", async () => {
  const { detectEgm } = await import("../vectron-tabs/egm.js");
  const probe = (reports) => detectEgm(async (command) => {
    if (!Object.hasOwn(reports, command)) throw new Error("Agent executable missing");
    return { code: 0, stdout: JSON.stringify(reports[command]) };
  });
  const codex = { pluginId: "egm@egm", installed: true, enabled: true };
  const claude = { id: "egm@egm", enabled: true };
  const agy = { name: "egm", enabled: true, skills: ["egm-brainstorm"] };

  assert.equal(await probe({}), false);
  assert.equal(await probe({
    codex: { available: [codex], installed: [{ ...codex, enabled: false }] },
    claude: [{ ...claude, enabled: false }],
    agy: [{ ...agy, skills: [] }],
  }), false);
  assert.equal(await probe({ codex: { installed: [codex] } }), true);
  assert.equal(await probe({ claude: [claude] }), true);
  assert.equal(await probe({ agy: [agy] }), true);
  assert.equal(await detectEgm(async () => ({ code: 1, stdout: "unavailable" })), false);
  assert.equal(await detectEgm(async () => ({ code: 0, stdout: "invalid JSON" })), false);
});

test("the Vectron strip hides EGM until detection succeeds and closes it after removal", async () => {
  const tasks = [];
  const commands = [];
  const noop = () => {};
  const cx = { spawn: (fn) => tasks.push(fn), notify: noop, focus_handle: noop, timer: { every: noop } };
  const body = { id: "panel-body", active: "context", children: [{ id: "context" }, { id: "egm" }] };
  const panel = { id: "panel", children: [body] };
  let installed = false;
  const { default: Tabs } = await loadMod("vectron-tabs", "main.js", { herdr: {
    layout: () => ({ children: [panel] }),
    spaces: () => [{ id: "space", active: true, tabs: [] }],
    run: (command, args) => commands.push([command, { ...args }]),
    exec: async (command) => ({
      code: 0,
      stdout: command === "claude" && installed
        ? '[{"id":"egm@egm","enabled":true}]'
        : "[]",
    }),
    panes: () => [], terminals: () => [], props: () => ({}), theme: () => ({}),
    readTextFile: noop, home: noop, appHome: noop, focused: noop, openOverlay: noop,
    shared: noop, setShared: noop, nextCommand: noop, notify: noop,
  } }, { localStorage: { getItem: () => null, setItem: noop } });
  const tabs = new Tabs();
  tabs.init({}, cx);
  const tab = (id) => find(tabs.render(cx), (node) => node.calls.id?.[0] === "panel-" + id);
  assert.equal(tab("egm"), undefined);
  assert.ok(tab("context"));
  await tasks.pop()(cx);
  assert.equal(tab("egm"), undefined);

  const refresh = async () => {
    tasks.length = 0;
    tabs.checkEgm(cx, body);
    await tasks.pop()(cx);
  };

  installed = true;
  await refresh();
  assert.ok(tab("egm"));
  body.active = "egm";
  assert.ok(tab("egm"));

  installed = false;
  await refresh();
  assert.equal(tab("egm"), undefined);
  assert.deepEqual(commands.at(-1), ["layout.hide", { id: "panel" }]);
});

test("EGM discovers tracked designs and new review artifacts from a nested pane directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vectron-egm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args) => exec("git", args, { cwd: root });
  await git(["init", "-q"]);
  await mkdir(join(root, "docs/designs"), { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "docs/designs/Editor layout.md"), "# Editor layout");
  await git(["add", "docs/designs/Editor layout.md"]);
  await writeFile(join(root, "src/concepts_brief.md"), "# Brief");
  await writeFile(join(root, "goldfish_review_report.md"), "# Review");
  await writeFile(join(root, "README.md"), "# Unrelated");

  const calls = [];
  const result = await discoverDocuments(async (command, args, options) => {
    calls.push(options.on);
    const { stdout, stderr } = await exec(command, args, { cwd: options.cwd });
    return { code: 0, stdout, stderr };
  }, { cwd: join(root, "src"), on: "design-host" });

  assert.deepEqual(calls, ["design-host", "design-host"]);
  assert.deepEqual(result.documents, [
    { path: "src/concepts_brief.md", kind: "Brief" },
    { path: "docs/designs/Editor layout.md", kind: "Design" },
    { path: "goldfish_review_report.md", kind: "Review" },
  ]);
});

test("EGM copies the chosen host's invocation with an applicable absolute document path", () => {
  const design = { path: "docs/designs/Editor layout.md", kind: "Design" };
  const brief = { path: "concepts_brief.md", kind: "Brief" };
  const root = "/work/project";
  assert.equal(
    skillInvocation("review", "codex", root, design),
    '$egm:egm-review "/work/project/docs/designs/Editor layout.md"',
  );
  assert.equal(
    skillInvocation("draft", "claude", root, brief),
    '/egm:egm-draft "/work/project/concepts_brief.md"',
  );
  assert.equal(skillInvocation("review", "codex", root, brief), "$egm:egm-review");
  assert.equal(skillInvocation("lite", "codex", root, design), "$egm:egm-lite");
});

test("EGM offers Markdown preview for the loaded design and clears it in another worktree", async () => {
  const tasks = [];
  const copies = [];
  const cx = {
    spawn: (fn) => tasks.push(fn(cx)),
    notify: () => {},
    write_to_clipboard: (text) => copies.push(text),
  };
  const drain = () => Promise.all(tasks.splice(0));
  let cwd = "/work/first";
  const { default: Egm } = await loadMod("vectron-egm", "main.js", {
    "gpui-base": { TextView: { markdown: (_id, text) => new Element("markdown").child(text) } },
    herdr: {
    checking: () => false,
    exec: async (_cmd, [action], options) => ({
      code: 0,
      stdout: action === "rev-parse" ? options.cwd + "\n" : "docs/designs/pane.md\0",
      stderr: "",
    }),
    focused: () => ({ pane: "pane", cwd }),
    panes: () => [],
    spaces: () => [],
    notify: () => {},
    readTextFile: async (path) => "# Contents of " + path,
    theme: () => ({}),
  } }, { localStorage: { getItem: () => null, setItem: () => {} } });
  const panel = new Egm();
  panel.init();

  const byLabel = (tree, label) => find(tree, (node) => node.nodes.includes(label));
  const byTooltip = (tree, text) => find(tree, (node) => node.calls.tooltip?.[0] === text);
  const click = (node) => node.calls.on_click[0](null, cx);
  panel.render(cx);
  await drain();
  assert.equal(byLabel(panel.render(cx), "Preview"), undefined);
  click(byTooltip(panel.render(cx), "docs/designs/pane.md"));
  assert.equal(byLabel(panel.render(cx), "Preview"), undefined);
  await drain();
  const editor = find(panel.render(cx), (node) => node.kind === "editor");
  assert.equal(editor.args[0].options.readonly, true);
  assert.equal(editor.args[0].options.value, "# Contents of /work/first/docs/designs/pane.md");

  click(byLabel(panel.render(cx), "Preview"));
  const markdown = find(panel.render(cx), (node) => node.kind === "markdown");
  assert.equal(markdown.nodes[0], editor.args[0].options.value);
  assert.equal(find(panel.render(cx), (node) => node.kind === "editor"), undefined);

  click(byLabel(panel.render(cx), "Skills"));
  click(byTooltip(panel.render(cx), '$egm:egm-review "/work/first/docs/designs/pane.md"'));
  click(byLabel(panel.render(cx), "Preview"));
  cwd = "/work/second";
  const next = panel.render(cx);
  assert.equal(byLabel(next, "Preview"), undefined);
  assert.equal(find(next, (node) => node.kind === "markdown"), undefined);
  click(byLabel(next, "Skills"));
  click(byTooltip(panel.render(cx), "$egm:egm-review"));
  await drain();
  assert.deepEqual(copies, ['$egm:egm-review "/work/first/docs/designs/pane.md"', "$egm:egm-review"]);
});
