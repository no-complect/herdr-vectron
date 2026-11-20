import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { appendSnapshot } from "../vectron-context/append-snapshot.js";
import { loadMod } from "./support/herdr.mjs";

test("duplicate readers share one load and a cached snapshot survives an unchanged check", async () => {
  const reads = [];
  const { joinRead, recentSession } = await loadMod("vectron-context", "session-loads.js", {
    herdr: {
      appHome: () => "/fixture",
      exec: (_name, args) => new Promise((resolve) => {
        const request = JSON.parse(args[2]);
        reads.push({ request, finish: (result) => resolve({ code: 0, stdout: JSON.stringify(result) }) });
      }),
    },
  });

  const key = "same-session";
  const request = { path: "/fixture/session.jsonl" };
  const panel = joinRead(key, request);
  const overlay = joinRead(key, request);
  panel.leave();
  assert.equal(reads.length, 1);
  reads[0].finish({ path: request.path, signature: "v1", events: [{ id: 1 }] });
  const first = await overlay.promise;
  overlay.leave();
  assert.strictEqual(recentSession(key), first);

  const refresh = joinRead(key, request);
  assert.equal(reads[1].request.signature, "v1");
  reads[1].finish({ path: request.path, signature: "v1", unchanged: true });
  assert.strictEqual((await refresh.promise).events, first.events);
  refresh.leave();
});

test("manual Refresh waits for a fresh full read and coalesces requests only before that read starts", async () => {
  const reads = [];
  const { joinRead } = await loadMod("vectron-context", "session-loads.js", {
    herdr: {
      appHome: () => "/fixture",
      exec: (_name, args) => new Promise((resolve) => {
        reads.push({
          request: JSON.parse(args[2]),
          finish: (result) => resolve({ code: 0, stdout: JSON.stringify(result) }),
        });
      }),
    },
  });
  const key = "session";
  const request = { provider: "codex", path: "/fixture/session.jsonl" };
  const previous = { path: request.path, signature: "old", checkpoint: { offset: 123 } };

  const background = joinRead(key, request, previous, false);
  const refresh = joinRead(key, request, previous, true);
  const secondClick = joinRead(key, request, previous, true);
  assert.equal(reads.length, 1);
  assert.notStrictEqual(refresh.promise, background.promise);
  assert.strictEqual(refresh.promise, secondClick.promise);

  reads[0].finish({ path: request.path, signature: "old", unchanged: true });
  assert.equal((await background.promise).signature, "old");
  await setImmediate();
  assert.equal(reads.length, 2);
  assert.equal(reads[1].request.signature, null);
  assert.equal(reads[1].request.checkpoint, null);

  const thirdClick = joinRead(key, request, previous, true);
  assert.notStrictEqual(thirdClick.promise, refresh.promise);
  thirdClick.leave();
  reads[1].finish({ path: request.path, signature: "fresh" });
  assert.equal((await refresh.promise).signature, "fresh");
  await thirdClick.promise;
  assert.equal(reads.length, 2, "a canceled queued refresh must not start a reader");
  for (const visit of [background, refresh, secondClick]) visit.leave();

  const failing = joinRead(key, request, previous, false);
  const retry = joinRead(key, request, previous, true);
  const error = assert.rejects(failing.promise, /temporary read failure/);
  reads[2].finish({ error: "temporary read failure" });
  await error;
  await setImmediate();
  assert.equal(reads[3].request.signature, null);
  reads[3].finish({ path: request.path, signature: "recovered" });
  assert.equal((await retry.promise).signature, "recovered");
  failing.leave();
  retry.leave();
});

test("a visible Context panel checks after five seconds even when the active watch misses a transcript change", async () => {
  const path = "/fixture/day-one/session.jsonl";
  const nextPath = "/fixture/day-two/session.jsonl";
  let source = path;
  let now = 100000;
  let visible = true;
  const requests = [];
  const watched = [];
  const canceled = [];
  const noop = () => {};
  const timers = [];
  const cx = {
    spawn: (fn) => fn(cx), notify: noop,
    timer: {
      every: (ms, fn) => {
        assert.equal(ms, 5000);
        cx.tick = () => { now += ms; fn(cx); };
      },
      after: (_ms, fn) => timers.push(fn),
    },
  };
  const { default: Context } = await loadMod("vectron-context", "main.js", {
    herdr: {
      appHome: () => "/fixture", props: () => ({}), layout: noop, focused: noop,
      panes: noop, terminals: noop, theme: noop, settings: noop, shared: noop,
      openOverlay: noop, closeOverlay: noop,
      watchFolder: (folder) => {
        watched.push(folder);
        let settle;
        const promise = new Promise((resolve) => { settle = resolve; });
        promise.cancel = () => {
          canceled.push(folder);
          settle([]);
        };
        return promise;
      },
      exec: async (_name, args) => {
        requests.push(JSON.parse(args[2]));
        return { code: 0, stdout: JSON.stringify({ path: source, signature: source }) };
      },
    },
  }, { Date: class extends Date { static now() { return now; } } });
  const view = new Context();
  view.target = () => ({ address: "t1", provider: "codex", pid: 123 });
  view.visible = () => visible;
  view.init({}, cx);
  await setImmediate();
  assert.equal(view.data.path, path);
  assert.deepEqual(watched, ["/fixture/day-one"]);
  timers.shift()(cx);
  await setImmediate();

  source = nextPath;
  cx.tick();
  await setImmediate();
  assert.equal(view.data.path, nextPath);
  visible = false;
  const beforeHidden = requests.length;
  cx.tick();
  assert.equal(requests.length, beforeHidden);
  assert.deepEqual(canceled, ["/fixture/day-one", "/fixture/day-two"]);
  view.close();
});

test("a transcript watch batches Grok companion updates and drops queued work after detaching", async () => {
  const watchers = [];
  const timers = [];
  const reads = [];
  let canceled = false;
  const { TranscriptWatch } = await loadMod("vectron-context", "transcript-watch.js", {
    herdr: {
      watchFolder: (folder) => {
        let finish;
        const waiting = new Promise((resolve) => { finish = resolve; });
        waiting.cancel = () => {
          canceled = true;
          finish([]);
        };
        watchers.push({ folder, finish });
        return waiting;
      },
    },
  });
  const cx = { spawn: (fn) => fn(cx), timer: { after: (_ms, fn) => timers.push(fn) } };
  const watch = new TranscriptWatch();
  watch.observe("/test/session/chat_history.jsonl", "grok", () => reads.push("refresh"), cx);
  assert.equal(watchers[0].folder, "/test/session");
  timers.shift()(cx);
  assert.deepEqual(reads.splice(0), ["refresh"]);

  watchers[0].finish(["/test/session/unrelated.md"]);
  await setImmediate();
  assert.equal(timers.length, 0);
  watchers[1].finish(["/test/session/updates.jsonl"]);
  await setImmediate();
  watchers[2].finish(["/test/session/summary.json"]);
  await setImmediate();
  assert.equal(timers.length, 1);
  timers.shift()(cx);
  assert.deepEqual(reads, ["refresh"]);

  watchers[3].finish(["/test/session/chat_history.jsonl"]);
  await setImmediate();
  watch.stop();
  timers.shift()(cx);
  assert.equal(canceled, true);
  assert.deepEqual(reads, ["refresh"]);
});

const reader = fileURLToPath(new URL("../vectron-context/inspect_session.py", import.meta.url));
const entry = `
import runpy, sys
from pathlib import Path
script, fixture, request = sys.argv[1:]
Path.home = classmethod(lambda _: Path(fixture))
sys.argv = [script, '--request', request]
runpy.run_path(script, run_name='__main__')
`;

function transcript(t) {
  const fixture = mkdtempSync(join(tmpdir(), "context-append-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const directory = join(fixture, ".codex", "sessions", "2026", "01", "01");
  const path = join(directory, "rollout-append001.jsonl");
  mkdirSync(directory, { recursive: true });
  return {
    path,
    read(base, extra = {}) {
      const request = { provider: "codex", path, want_checkpoint: true, ...extra };
      if (base) Object.assign(request, { signature: base.signature, checkpoint: base.checkpoint });
      return JSON.parse(execFileSync("python3", ["-B", "-c", entry, reader, fixture, JSON.stringify(request)], {
        encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
      }));
    },
  };
}

const row = (type, payload) => JSON.stringify({ type, payload }) + "\n";
const prompt = (text) => row("response_item", { type: "message", role: "user", content: text });
const usage = (input) => row("event_msg", {
  type: "token_count", info: { last_token_usage: { input_tokens: input }, model_context_window: 475000 },
});

test("Codex append snapshots equal full reads across retention, usage replay, compaction, and event previews", (t) => {
  const { read, path } = transcript(t);
  const head = row("session_meta", { id: "append001", base_instructions: "fixture" });
  const history = Array.from({ length: 5100 }, (_, i) => prompt(`Fixture ${i} ${"a".repeat(i % 20)}`));
  writeFileSync(path, head + history.join("") + usage(4000));
  const first = read();
  appendFileSync(path, usage(4500) + row("compacted", { message: "fixture summary" }) + prompt("Appended prompt"));
  const delta = read(first);
  assert.equal(delta.delta_base, first.signature);
  assert.equal(delta.events.length, 2);
  assert.equal(delta.usage_samples[0].afterId, first.usage_samples.at(-1).afterId);
  const merged = appendSnapshot(first, delta);
  assert.deepEqual(merged, read());
  const event = merged.events.at(-1);
  const detail = read(null, { action: "detail", source: event.source, offset: event.offset, field: event.field });
  assert.equal(detail.text, "Appended prompt");

  appendFileSync(path, prompt("Second update"));
  assert.deepEqual(appendSnapshot(merged, read(merged)), read());
});

test("Codex falls back to full accounting on partial records, rewrites, and tool results crossing the cursor", (t) => {
  const { read, path } = transcript(t);
  const initial = row("session_meta", { id: "append001" }) + prompt("Initial prompt");
  writeFileSync(path, initial);
  const first = read();
  const appended = prompt("Written in two parts");
  appendFileSync(path, appended.slice(0, -4));
  const partial = read(first);
  assert.equal(partial.delta_base, undefined);
  assert.equal(partial.checkpoint, undefined);
  appendFileSync(path, appended.slice(-4));
  assert.deepEqual(read(partial), read());

  writeFileSync(path, initial.replace("Initial prompt", "Rewrote prefix") + prompt("More bytes"));
  const rewritten = read(first);
  assert.equal(rewritten.delta_base, undefined);
  assert.deepEqual(rewritten, read());

  appendFileSync(path, row("response_item", { type: "function_call", name: "read_file", call_id: "call", arguments: "SKILL.md" }));
  const beforeOutput = read();
  appendFileSync(path, row("response_item", { type: "function_call_output", call_id: "call", output: "tool output" }));
  const afterOutput = read(beforeOutput);
  assert.equal(afterOutput.delta_base, undefined);
  assert.equal(afterOutput.events.at(-1).category, "skills");
});

test("an atomic transcript replacement with the same size and mtime invalidates the snapshot", (t) => {
  const { read, path } = transcript(t);
  const header = row("session_meta", { id: "append001" });
  const stamp = new Date("2026-01-01T12:00:00Z");
  writeFileSync(path, header + prompt("Original"));
  utimesSync(path, stamp, stamp);
  const first = read();

  const replacement = `${path}.scratch`;
  writeFileSync(replacement, header + prompt("Replaced"));
  utimesSync(replacement, stamp, stamp);
  renameSync(replacement, path);
  const next = read(first);
  assert.equal(next.unchanged, undefined);
  assert.equal(next.delta_base, undefined);
  assert.equal(next.events.at(-1).teaser, "Replaced");
});
