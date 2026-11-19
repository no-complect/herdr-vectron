import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { parseLog, parseStatus, withUncommitted } from "../vectron-changes/graph/git.js";
import { layoutLanes } from "../vectron-changes/graph/lanes.js";
import { fileAppearance, folderAppearance, gitStatus } from "../vectron-files/appearance.js";
import { applyInstall, findPackages, planInstall, uninstall } from "../vectron-mod-manager/core.js";
import { argvOf, resumeCommand } from "../vectron-tabs/reopen.js";

const root = new URL("../../", import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

function* objects(value) {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) yield value;

  for (const child of Object.values(value)) yield* objects(child);
}

test("the shipped layout resolves its blocks, pane header, icons, theme, and shortcuts", async () => {
  const layout = await json("layouts/vectron.json");
  const keys = (await json("keys.json"))["layout:vectron"];
  const modNames = new Set(
    [...objects(layout)].map(({ mod }) => mod).filter((name) => name?.startsWith("vectron-")),
  );

  for (const name of ["bar", "spaces", "agents", "tabs", "pane", "files", "changes", "context"]) {
    assert.ok(modNames.has(`vectron-${name}`), name);
  }
  for (const action of Object.values(keys)) {
    const mod = typeof action === "string" && action.match(/^(?:mod\.open:)?(vectron-[\w-]+)/);
    if (mod) modNames.add(mod[1]);
  }
  for (const name of modNames) await access(new URL(`mods/${name}/main.js`, root));

  const context = [...objects(layout)].find((node) => node.id === "panel-body");
  assert.equal(context.active, "context");
  assert.equal(layout.theme.light, "vectron");
  assert.equal(layout.theme.dark, "vectron");
  await access(new URL(layout.preview, root));
  assert.ok((await readdir(new URL("mods/vectron-icons", root))).includes("codex.svg"));
  for (let slot = 1; slot <= 9; slot++) {
    assert.equal(keys[`cmd-${slot}`], `space.select:${slot}`);
    assert.equal(keys[`ctrl-${slot}`], `vectron-agents.select-${slot}`);
  }
});

test("git history retains both merge parents and draws uncommitted changes as a dashed row", () => {
  const [merge, left, right, base] = ["a", "b", "c", "d"].map((x) => x.repeat(40));
  const row = (hash, parents, refs) =>
    [hash, parents.join(" "), "Author", "", "1234", refs, "Subject"].join("\0") + "\0";
  const history = parseLog(
    row(merge, [left, right], "HEAD -> refs/heads/main") +
      row(left, [base], "") +
      row(right, [base], "") +
      row(base, [], ""),
  );
  assert.deepEqual(history[0].parents, [left, right]);
  assert.equal(history[0].head, true);
  const graph = layoutLanes(withUncommitted(history, 2, merge));
  assert.equal(graph.rows.length, 5);
  assert.equal(graph.width, 2);
  assert.ok(graph.rows[0].segments.every((line) => line.at(-1)));
  assert.throws(() => parseLog("unframed"), /Invalid history framing/);
});

test("file and changes displays preserve whitespace, staged flags, conflicts, and icons", () => {
  assert.deepEqual(parseStatus("M  a b.js\0?? new\nfile\0UU conflict\0"), [
    { path: "a b.js", status: "M", untracked: false, staged: true },
    { path: "new\nfile", status: "A", untracked: true, staged: false },
    { path: "conflict", status: "U", untracked: false, staged: false },
  ]);
  assert.equal(gitStatus("DD"), "U");
  assert.equal(fileAppearance("src/types.d.ts").icon, "typescript-def");
  assert.equal(fileAppearance("src/.env.local").icon, "config");
  assert.equal(folderAppearance("project/tests", true), "folder_test_open");
});

test("tab reopen retains provider options, session identity, and the shell fallback", () => {
  const proc = { program: "codex", args: ["-c", "key=value", "--resume", "old", "--no-daemon"] };
  const command = resumeCommand(proc, "test session", "/home/local");

  assert.equal(command, "codex resume '-c' 'key=value' '--no-daemon' 'test session'");
  assert.deepEqual(argvOf(command, "/bin/zsh"), ["/bin/zsh", "-lc", `${command}; exec '/bin/zsh'`]);
  assert.equal(resumeCommand(null, null, "/home/local"), null);
  assert.equal(argvOf(null, "/bin/zsh"), undefined);
});

test("the mod manager separates test files, collisions, and user-owned shortcuts", async () => {
  const [pkg] = findPackages(["mods/example/main.js", "mods/test/runtime.test.mjs", "keys.json"]);
  assert.deepEqual(pkg.mods, ["example"]);
  assert.deepEqual(pkg.files, ["mods/example/main.js"]);

  const calls = [];
  let keys = { global: { "ctrl-u": "user.keep" } };
  const io = {
    readText: async (path) => {
      if (path === "/app/keys.json") return JSON.stringify(keys);
      if (path === "/cache/keys.json")
        return JSON.stringify({ global: { "ctrl-u": "example.other", "ctrl-i": "example.open" } });
      return "export default class Example {}";
    },
    exec: async (command, args) => {
      calls.push([command, args]);
      return { code: command === "test" ? 1 : 0, stdout: "" };
    },
    writeText: async (_path, text) => {
      keys = JSON.parse(text);
    },
  };
  const inputs = { appHome: "/app", dir: "/cache", pkg, existingLayouts: [] };
  const clash = await planInstall(io, { ...inputs, existingMods: ["example"] });
  await assert.rejects(applyInstall(io, { appHome: "/app", plan: clash }), /already exists/);
  assert.equal(calls.length, 0);

  const plan = await planInstall(io, { ...inputs, existingMods: [] });
  assert.deepEqual(
    plan.keyConflicts.map((conflict) => conflict.key),
    ["ctrl-u"],
  );
  const record = await applyInstall(io, { appHome: "/app", plan, source: "owner/repo" });
  assert.equal(keys.global["ctrl-i"], "example.open");
  keys.global["ctrl-i"] = "user.rebound";
  await uninstall(io, { appHome: "/app", record });
  assert.deepEqual(keys.global, { "ctrl-u": "user.keep", "ctrl-i": "user.rebound" });
});

test("a failed mod update restores the previous package", async () => {
  const files = new Map([
    ["/app/mods/first", "old first"],
    ["/app/mods/second", "old second"],
    ["/cache/mods/first", "new first"],
    ["/cache/mods/second", "new second"],
  ]);
  let replacementFailed = false;
  const io = {
    exec: async (command, args) => {
      const [from, to] = args.slice(-2);
      if (command === "test") return { code: Number(!files.has(args[1])) };
      const replacesSecondMod = (command === "cp" || command === "mv") && to === "/app/mods/second";
      if (!replacementFailed && replacesSecondMod) {
        assert.equal(files.get("/app/mods/first"), "new first");
        replacementFailed = true;
        return { code: 1, stderr: "fixture activation failure" };
      }
      if (command === "cp" || command === "mv") {
        files.set(to, files.get(from));
        if (command === "mv") files.delete(from);
      }
      if (command === "rm") files.delete(args.at(-1));
      return { code: 0 };
    },
  };
  const mods = ["first", "second"];
  const plan = { base: "/cache", mods, layouts: [], clashes: [], keyAdds: [], risks: [] };
  await assert.rejects(
    applyInstall(io, { appHome: "/app", plan, record: { mods } }),
    /fixture activation failure/,
  );
  assert.equal(files.get("/app/mods/first"), "old first");
  assert.equal(files.get("/app/mods/second"), "old second");
});
