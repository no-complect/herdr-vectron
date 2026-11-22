import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { executeAction } from "../vectron-changes/graph/execute.js";
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

  assert.equal(keys["alt-enter"], "vectron-tabs.split-right");
  assert.equal(keys["alt-shift-enter"], "vectron-tabs.split-down");

  for (const name of ["bar", "spaces", "agents", "tabs", "pane", "files", "changes", "context", "egm"]) {
    assert.ok(modNames.has(`vectron-${name}`), name);
  }
  for (const action of Object.values(keys)) {
    const mod = typeof action === "string" && action.match(/^(?:mod\.open:)?(vectron-[\w-]+)/);
    if (mod) modNames.add(mod[1]);
  }
  for (const name of modNames) await access(new URL(`mods/${name}/main.js`, root));

  const context = [...objects(layout)].find((node) => node.id === "panel-body");
  assert.equal(context.active, "context");
  assert.equal(context.children.find((node) => node.id === "egm")?.content.mod, "vectron-egm");
  assert.equal(layout.theme.light, "vectron");
  assert.equal(layout.theme.dark, "vectron");
  await access(new URL(layout.preview, root));
  assert.ok((await readdir(new URL("mods/vectron-icons", root))).includes("codex.svg"));
  for (let slot = 1; slot <= 9; slot++) {
    assert.equal(keys[`cmd-${slot}`], `space.select:${slot}`);
    assert.equal(keys[`ctrl-${slot}`], `vectron-agents.select-${slot}`);
  }
});

test("Git ancestry follows both merge parents and excludes unrelated lanes and descendants", async () => {
  const { ancestryDepths } = await import("../vectron-changes/graph/lanes.js");
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
  const unrelated = { hash: "unrelated", parents: [base] };
  const commits = withUncommitted([history[0], unrelated, ...history.slice(1)], 2, merge);
  const { rows } = layoutLanes(commits);
  const trace = ancestryDepths(commits, merge);
  assert.deepEqual([...trace], [[merge, 0], [left, 1], [right, 1], [base, 2]]);
  const lit = (row) => row.segments.filter((line) => line[6].some((source) => trace.has(source)));
  assert.equal(lit(rows[0]).length, 0);
  assert.ok(rows[0].segments.every((line) => line[5]));
  assert.equal(lit(rows[1]).length, 2);
  assert.equal(lit(rows[2]).length, 2);
  assert.ok(rows[2].segments.some((line) => line[6].includes(unrelated.hash)));
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

test("Commit All requires confirmation and then commits a manually resolved merge", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vectron-merge-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = promisify(execFile);
  const exec = async (program, args, { cwd }) => {
    const opts = ["-c", "core.hooksPath=.git/no-hooks", "-c", "commit.gpgsign=false", ...args];
    try {
      return { code: 0, ...(await run(program, opts, { cwd })) };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const git = async (...args) => {
    const result = await exec("git", args, { cwd: root });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  const path = join(root, "shared file.txt");
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await writeFile(path, "base\n");
  await git("add", "--all");
  await git("commit", "-m", "Base");
  await git("switch", "-c", "topic");
  await writeFile(path, "topic\n");
  await git("commit", "-am", "Topic");
  await git("switch", "main");
  await writeFile(path, "main\n");
  await git("commit", "-am", "Main");
  const merge = await exec("git", ["merge", "--no-ff", "--no-edit", "topic"], { cwd: root });
  assert.equal(merge.code, 1, merge.stderr);
  await writeFile(path, "resolved\n");

  const ctx = { root, current: "main", head: await git("rev-parse", "HEAD") };
  const values = { all: true, message: "Finish merge" };
  const review = await executeAction({ type: "commit" }, values, ctx, exec);
  assert.equal(review.ok, false);
  assert.match(review.conflicts.entries, /shared file\.txt/);
  assert.match(await git("ls-files", "--unmerged"), /shared file\.txt/);
  assert.equal(await git("rev-parse", "HEAD"), ctx.head);

  const result = await executeAction(
    { type: "commit" },
    { ...values, confirmedConflicts: review.conflicts },
    ctx,
    exec,
  );
  assert.deepEqual(result, { ok: true });
  assert.equal((await git("rev-list", "--parents", "-n", "1", "HEAD")).split(" ").length, 3);
  assert.equal(await git("show", "HEAD:shared file.txt"), "resolved");
  assert.equal(await git("status", "--porcelain"), "");
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
      if (command === "mktemp") return { code: 0, stdout: "/app/.mod-manager-install.fixture\n" };
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

test("the mod manager installs, updates, and removes a package theme without taking user files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vectron-theme-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appHome = join(dir, "app");
  const source = join(dir, "source");
  const base = join(source, "package");
  const asset = "themes/vectron.json";
  const installed = join(appHome, asset);
  const userTheme = join(appHome, "themes", "personal.json");
  await mkdir(join(base, "mods", "example"), { recursive: true });
  await mkdir(join(base, "layouts"), { recursive: true });
  await mkdir(join(base, "themes"), { recursive: true });
  await mkdir(join(appHome, "themes"), { recursive: true });
  await writeFile(join(base, "mods", "example", "main.js"), "export default class Example {}");
  await writeFile(join(base, "layouts", "vectron.json"), '{"theme":"vectron"}');
  await writeFile(join(base, asset), '{"background":"#010203"}');
  await writeFile(userTheme, '{"background":"#abcdef"}');

  const tracked = ["package/mods/example/main.js", "package/layouts/vectron.json"];
  const [legacy] = findPackages(tracked);
  const [pkg] = findPackages([
    ...tracked,
    `package/${asset}`,
    "package/themes/test/fixture.json",
    "package/themes/preview.png",
    "package/docs/vectron-walkthrough.mp4",
    "package/docs/vectron-preview.gif",
    "package/mods/test/workspace.test.mjs",
    "themes/unrelated.json",
  ]);
  assert.deepEqual(pkg.themes, [`package/${asset}`]);

  const run = promisify(execFile);
  const io = {
    readText: (path) => readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
    async exec(command, args) {
      if (command === "herdr-app") return { code: 0 };
      try {
        return { code: 0, ...(await run(command, args)) };
      } catch (error) {
        return { code: error.code, stderr: error.stderr ?? error.message };
      }
    },
  };
  const plan = (candidate, record) => planInstall(io, {
    appHome, dir: source, pkg: candidate, record,
    existingMods: record ? ["example"] : [],
    existingLayouts: record ? ["vectron.json"] : [],
  });
  const install = (candidate, previous) => applyInstall(io, {
    appHome, plan: candidate, record: previous, source: "owner/repo", prefix: "package",
  });
  const { themes: _unused, ...olderRecord } = await install(await plan(legacy));

  await writeFile(installed, '{"background":"#445566"}');
  const clash = await plan(pkg, olderRecord);
  assert.deepEqual(clash.clashes, [asset]);
  await assert.rejects(install(clash, olderRecord), /already exists/);
  assert.equal(await readFile(installed, "utf8"), '{"background":"#445566"}');
  await rm(installed);

  const record = await install(await plan(pkg, olderRecord), olderRecord);
  assert.deepEqual(record.themes, ["vectron.json"]);
  assert.equal(await readFile(installed, "utf8"), '{"background":"#010203"}');
  assert.deepEqual((await readdir(join(appHome, "themes"))).sort(), ["personal.json", "vectron.json"]);

  await writeFile(join(base, asset), '{"background":"#020304"}');
  const updated = await install(await plan(pkg, record), record);
  assert.equal(await readFile(installed, "utf8"), '{"background":"#020304"}');
  await uninstall(io, { appHome, record: updated });
  assert.deepEqual(await readdir(join(appHome, "themes")), ["personal.json"]);
  assert.equal(await readFile(userTheme, "utf8"), '{"background":"#abcdef"}');
});

test("a failed theme update restores the previous package", async () => {
  const files = new Map([
    ["/app/mods/first", "old first"],
    ["/app/mods/second", "old second"],
    ["/app/themes/example.json", "old theme"],
    ["/cache/mods/first", "new first"],
    ["/cache/mods/second", "new second"],
    ["/cache/themes/example.json", "new theme"],
  ]);
  let replacementFailed = false;
  const io = {
    exec: async (command, args) => {
      const [from, to] = args.slice(-2);
      if (command === "mktemp") return { code: 0, stdout: "/app/.mod-manager-install.fixture\n" };
      if (command === "test") return { code: Number(!files.has(args[1])) };
      const replacesTheme = command === "mv" && to === "/app/themes/example.json";
      if (!replacementFailed && replacesTheme) {
        assert.equal(files.get("/app/mods/first"), "new first");
        assert.equal(files.get("/app/mods/second"), "new second");
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
  const themes = ["example.json"];
  const plan = { base: "/cache", mods, layouts: [], themes, clashes: [], keyAdds: [], risks: [] };
  await assert.rejects(
    applyInstall(io, { appHome: "/app", plan, record: { mods, themes } }),
    /fixture activation failure/,
  );
  assert.equal(files.get("/app/mods/first"), "old first");
  assert.equal(files.get("/app/mods/second"), "old second");
  assert.equal(files.get("/app/themes/example.json"), "old theme");
});

test("installer cleanup failures leave backups available and allow another install", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vectron-install-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appHome = join(dir, "app");
  const base = join(dir, "source");
  await mkdir(appHome);
  for (const name of ["first", "second"]) {
    await mkdir(join(base, "mods", name), { recursive: true });
    await writeFile(join(base, "mods", name, "main.js"), name);
  }

  const legacyBackup = join(appHome, ".mod-manager-install", "backup");
  await mkdir(legacyBackup, { recursive: true });
  await writeFile(join(legacyBackup, "keep"), "previous backup");

  const warnings = [];
  let failedStaging;
  let markChecking;
  let finishCheck;
  const checking = new Promise((resolve) => {
    markChecking = resolve;
  });
  const waitToFinish = new Promise((resolve) => {
    finishCheck = resolve;
  });
  const io = {
    warn: (message) => warnings.push(message),
    exec: async (program, args) => {
      if (program === "herdr-app") {
        if (args[1].endsWith("/first")) {
          markChecking();
          await waitToFinish;
        }
        return { code: 0 };
      }
      if (program === "rm" && !failedStaging) {
        failedStaging = args.at(-1);
        return { code: 1, stderr: "fixture cleanup failure" };
      }
      try {
        switch (program) {
          case "mkdir":
            for (const path of args.filter((arg) => arg !== "-p")) {
              await mkdir(path, { recursive: args[0] === "-p" });
            }
            break;
          case "mktemp":
            return { code: 0, stdout: `${await mkdtemp(args[1].replace(/X+$/, ""))}\n` };
          case "test":
            await lstat(args[1]);
            break;
          case "cp":
            await cp(args.at(-2), args.at(-1), { recursive: true });
            break;
          case "mv":
            await rename(...args);
            break;
          case "rm":
            await rm(args.at(-1), { recursive: true, force: true });
            break;
          case "rmdir":
            await rmdir(args[0]);
            break;
          default:
            assert.fail(`Unexpected installer command ${program}`);
        }
        return { code: 0, stdout: "" };
      } catch (error) {
        if (program === "test" && error.code !== "ENOENT") throw error;
        return { code: 1, stderr: error.message };
      }
    },
  };
  const install = (name) =>
    applyInstall(io, {
      appHome,
      plan: { base, mods: [name], layouts: [], clashes: [], keyAdds: [], risks: [] },
    });

  const first = install("first");
  await Promise.race([checking, first]);
  try {
    await assert.rejects(install("second"), /install.*lock/i);
  } finally {
    finishCheck();
    await first;
  }
  assert.deepEqual((await first).mods, ["first"]);
  assert.deepEqual((await install("second")).mods, ["second"]);
  assert.equal(await readFile(join(appHome, "mods", "first", "main.js"), "utf8"), "first");
  assert.equal(await readFile(join(appHome, "mods", "second", "main.js"), "utf8"), "second");
  assert.equal(await readFile(join(legacyBackup, "keep"), "utf8"), "previous backup");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fixture cleanup failure/);
  await access(failedStaging);
});
