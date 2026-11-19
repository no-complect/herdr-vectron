import assert from "node:assert/strict";
import test from "node:test";
import { find, loadMod } from "./support/herdr.mjs";

const noop = () => {};
const colorTheme = {
  accent: "#f2f54a",
  ansi4: "#1683ff",
  ansi5: "#f239d1",
  ansi6: "#72dac0",
  ansi12: "#7ab5ff",
  ansi13: "#ffa0eb",
  ansi14: "#a0ebdc",
};

test("selection flashes keep the three timed peaks, hue changes, and scope", async () => {
  let time = 0;
  const { Flash } = await loadMod(
    "vectron-agents",
    "beam.js",
    {},
    { Date: { now: () => time } },
  );
  const flash = new Flash();
  const observed = [];
  let run;
  const cx = {
    spawn: (task) => {
      run = task;
    },
    sleep: async (ms) => {
      time += ms;
    },
    notify: () => {
      observed.push(flash.iconPulse("selected", colorTheme));
    },
  };
  flash.start(cx, new Map([["selected", colorTheme.accent]]));
  assert.equal(flash.iconPulse("other", colorTheme), null);
  await run(cx);

  assert.deepEqual(
    observed.map((phase) => phase?.opacity ?? null),
    [1, 0, 0.64, 0, 0.36, 0, null],
  );
  assert.deepEqual(
    observed.filter((phase) => phase?.opacity).map((phase) => phase.color),
    [colorTheme.ansi12, colorTheme.ansi13, colorTheme.ansi14],
  );
});

test("each selected agent gets its own glyph and other programs use their existing icons", async () => {
  const { programIcon } = await loadMod("vectron-pane", "program-icon.js");
  for (const [key, name] of [
    ["codex", "codex"],
    ["claude-code", "claude"],
    ["grok-build", "grok"],
    ["agy", "antigravity"],
  ]) {
    const icon = programIcon({ key }, 14, "#ffffff");
    assert.equal(icon.args[0], `mods/vectron-icons/${name}.svg`);
    assert.deepEqual(icon.calls.size, [14]);
  }
  assert.equal(
    programIcon({ key: "other", icon: "other.png", tint: false }, 14, "#ffffff")
      .kind,
    "image",
  );
  assert.equal(programIcon(null, 14, "#ffffff"), null);
});

test("number shortcuts follow the live Agents list order, skipping closed terminals", async () => {
  const commands = [];
  const herdr = {
    agents: () => [{ address: "a" }, { address: "b" }],
    run: (...args) => commands.push(args),
    terminals: noop,
    panes: noop,
    focused: noop,
    spaces: noop,
    theme: noop,
    shared: noop,
    setShared: noop,
    setAgentOrder: noop,
    openOverlay: noop,
    closeOverlay: noop,
    props: noop,
    window: noop,
    layout: noop,
    home: noop,
    nextCommand: noop,
  };
  const { default: Agents } = await loadMod("vectron-agents", "main.js", {
    herdr,
  });
  const view = new Agents();
  view.order = ["closed", "b", "a"];
  view.handleCommand("select-1");
  view.handleCommand("select-2");
  view.handleCommand("select-9");

  assert.deepEqual(
    commands.map(([command, args]) => [command, args.terminal]),
    [
      ["agent.focus", "b"],
      ["agent.focus", "a"],
    ],
  );
});

test("Whistle dispatches a nested command and routes navigation to the selected field", async () => {
  const { resolve } = await loadMod("whistle", "keymap.js", {
    herdr: { appHome: noop, readTextFile: noop, writeTextFile: noop },
  });
  const entry = ["Panel", "mod.open:vectron-context"];
  const config = {
    map: { w: { name: "Workspace", map: { c: entry } } },
    own: new Map([
      ["j", { kind: "move", dir: "down" }],
      ["escape", { kind: "cancel" }],
    ]),
  };
  const opening = resolve(config, null, "terminal", "w");
  assert.equal(opening.sequence.title, "Workspace");
  assert.equal(
    resolve(config, opening.sequence, "terminal", "c").act.run,
    entry,
  );
  assert.equal(
    resolve(config, opening.sequence, "terminal", "escape").sequence,
    null,
  );
  assert.equal(resolve(config, null, "keynav", "j").act.keynav, "down");
  assert.equal(resolve(config, null, "terminal", "j").act.pane, "down");
  assert.equal(resolve(config, null, "keynav", "ctrl-x").act, null);
});

test("tab controls show another inspector and hide the currently selected inspector", async () => {
  const calls = [];
  const panel = {
    id: "panel",
    children: [
      {
        id: "panel-body",
        active: "context",
        children: [{ id: "files" }, { id: "context" }],
      },
    ],
  };
  const herdr = {
    layout: () => ({ children: [panel] }),
    run: (command, args) =>
      calls.push([command, JSON.parse(JSON.stringify(args))]),
    spaces: noop,
    panes: noop,
    terminals: noop,
    focused: noop,
    props: noop,
    openOverlay: noop,
    theme: noop,
    shared: noop,
    setShared: noop,
    exec: noop,
    readTextFile: noop,
    home: noop,
    appHome: noop,
    nextCommand: noop,
    notify: noop,
  };
  const { default: Tabs } = await loadMod("vectron-tabs", "main.js", { herdr });
  const tabs = new Tabs();
  tabs.togglePanel("absent");
  tabs.togglePanel("context");
  tabs.togglePanel("files");

  assert.deepEqual(calls, [
    ["layout.hide", { id: "panel" }],
    ["layout.select", { stack: "panel-body", child: "files" }],
    ["layout.show", { id: "panel" }],
  ]);
});

function tasks() {
  const pending = [];
  const context = {
    spawn: (body) => pending.push(body(context)),
    notify: noop,
    timer: { every: noop },
  };
  return {
    context,
    async flush() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

const contextHost = {
  appHome: () => "/fixture",
  props: () => ({}),
  layout: noop,
  panes: noop,
  focused: noop,
  terminals: noop,
  theme: () => colorTheme,
  settings: () => ({}),
  shared: noop,
  openOverlay: noop,
  closeOverlay: noop,
  exec: noop,
};

test("Context rejects late reads across agent and session switches and skips hidden refreshes", async () => {
  const requests = [];
  const herdr = {
    ...contextHost,
    exec: (_program, args) =>
      new Promise((resolve) =>
        requests.push({
          request: JSON.parse(args[2]),
          resolve: (data) => resolve({ code: 0, stdout: JSON.stringify(data) }),
        }),
      ),
  };
  const { default: Inspector } = await loadMod("vectron-context", "main.js", {
    herdr,
  });
  const timeline = tasks();
  const view = new Inspector();
  let selected = null;
  let isVisible = true;
  view.target = () => selected;
  view.visible = () => isVisible;
  view.init({}, timeline.context);

  selected = { address: "old", provider: "codex" };
  view.refresh(timeline.context);
  selected = { address: "new", provider: "grok" };
  view.refresh(timeline.context);
  assert.deepEqual(
    requests.map(({ request }) => request.address),
    ["old", "new"],
  );

  requests[1].resolve({ path: "/new", signature: "current" });
  requests[0].resolve({ path: "/old" });
  await timeline.flush();
  assert.equal(view.data.path, "/new");
  assert.equal(view.pendingRead, null);

  selected = { address: "old", provider: "codex" };
  view.refresh(timeline.context);
  selected = { address: "another", provider: "claude" };
  view.refresh(timeline.context);
  selected = { address: "old", provider: "codex" };
  const currentRead = tasks();
  view.refresh(currentRead.context);

  requests[2].resolve({ path: "/first-read-of-old" });
  requests[3].resolve({ path: "/another" });
  await timeline.flush();
  assert.equal(view.data, null);

  requests[4].resolve({ path: "/current-read-of-old" });
  await currentRead.flush();
  assert.equal(view.data.path, "/current-read-of-old");

  selected = { ...selected, session_id: "first-thread", pid: 123 };
  view.refresh(timeline.context);
  view.replayCutoff = 12;
  selected = { ...selected, session_id: "second-thread" };
  const nextSession = tasks();
  view.refresh(nextSession.context);
  assert.equal(requests.length, 7);

  requests[5].resolve({ path: "/first-session" });
  await timeline.flush();
  assert.equal(view.data, null);
  assert.equal(view.replayCutoff, null);
  requests[6].resolve({ path: "/second-session" });
  await nextSession.flush();
  assert.equal(view.data.path, "/second-session");

  isVisible = false;
  view.refresh(timeline.context);
  assert.equal(requests.length, 7);
});

test("Context keeps the selected transcript and replay when a known session restarts", async () => {
  const candidate = { path: "/fixture/chosen.jsonl", name: "Chosen session", updated: 0 };
  const requests = [];
  let pid = 123;
  let sessionId = "same-thread";
  const { default: Inspector } = await loadMod("vectron-context", "main.js", {
    herdr: {
      ...contextHost,
      focused: () => ({ space: "space", tab: "tab", pane: "pane", terminal: "t1" }),
      panes: () => [{ pane: "pane", tab: "tab", terminal: "t1", program: { key: "codex" } }],
      terminals: () => [
        {
          address: "t1",
          app: "codex",
          foreground: { pid, cwd: "/fixture" },
          labels: { "agent.session": sessionId },
        },
      ],
      exec: async (_program, args) => {
        const request = JSON.parse(args[2]);
        requests.push(request);
        return {
          code: 0,
          stdout: JSON.stringify({
            path: request.path ?? "/fixture/current.jsonl",
            candidates: [candidate],
          }),
        };
      },
    },
  });
  const view = new Inspector();
  const { context, flush } = tasks();
  view.init({}, context);
  await flush();

  const choice = find(view.pickerView(context), (node) => node.calls.id?.[0] === "session-0");
  choice.calls.on_click[0]({}, context);
  await flush();
  assert.equal(view.data.path, candidate.path);
  view.replayCutoff = 77;

  pid = 456;
  view.refresh(context);
  pid = 789;
  await flush();
  assert.equal(requests.at(-1).path, candidate.path);
  assert.equal(view.data.path, candidate.path);
  assert.equal(view.replayCutoff, 77);

  sessionId = undefined;
  view.refresh(context);
  await flush();
  view.replayCutoff = 77;

  pid = 999;
  view.refresh(context);
  await flush();
  assert.equal(requests.at(-1).pid, 999);
  assert.equal(view.replayCutoff, null);
});

test("Context previews show byte offsets and legacy line numbers", async () => {
  const { default: Inspector } = await loadMod("vectron-context", "main.js", {
    herdr: contextHost,
  });
  const view = new Inspector();
  view.controlsFlash = { layer: () => null };
  const source = "/fixture/session.jsonl";
  const event = { id: "event", category: "user", label: "Prompt", tokens: 3, bytes: 12, source };
  view.pinned = event.id;

  for (const [position, suffix] of [
    [{ offset: 0 }, " · byte 0"],
    [{ offset: 144, line: 7 }, " · byte 144"],
    [{ line: 7 }, ":7"],
    [{}, ""],
  ]) {
    view.data = { events: [{ ...event, ...position }] };
    const location = find(view.preview({}), (node) => node.calls.tooltip?.[0]?.startsWith(source));
    assert.deepEqual(location.nodes, [`session.jsonl${suffix}`]);
    assert.equal(location.calls.tooltip[0], `${source}${suffix}`);
  }
});

test("Context meters retain their native pulse rates and flash only changed categories", async () => {
  const { default: Inspector } = await loadMod("vectron-context", "main.js", {
    herdr: contextHost,
  });
  const view = new Inspector();
  const updates = [];
  view.controlsFlash = { layer: () => null };
  view.dataFlash = {
    layer: () => null,
    start: (_cx, targets) => updates.push(Array.from(targets.keys())),
  };
  view.width = 450;
  const initial = {
    reported: { input: 20, window: 100 },
    events: [
      { id: 1, segment: 0, category: "user", tokens: 4 },
      { id: 2, segment: 0, category: "files", tokens: 5 },
    ],
  };
  const changed = {
    reported: { input: 25, window: 100 },
    events: [...initial.events, { id: 3, segment: 0, category: "files", tokens: 7 }],
  };

  const meter = view.gauge(initial.reported);
  const pulse = (root, id) =>
    find(root, (node) => node.calls.id?.[0] === id).calls.loop[1].period;
  assert.equal(pulse(meter, "vector-fill-reported"), 477);
  const breakdown = view.breakdown(view.contextEvents.capture(changed, null, false).totals);
  assert.equal(pulse(breakdown, "vector-fill-user"), 683);
  assert.equal(pulse(breakdown, "vector-fill-files"), 729);
  view.flashUpdatedCounts({}, initial, changed);
  assert.deepEqual(updates, [["reported", "files"]]);
});

test("Files discards a stale directory listing when the focused workspace changes", async () => {
  let folder = "/old";
  const lists = new Map();
  const herdr = {
    focused: () => ({ pane: "pane", cwd: folder }),
    panes: () => [{ pane: "pane", cwd: folder }],
    spaces: () => [{ active: true, machine: "test-machine" }],
    exec: (command, args) =>
      command === "sh"
        ? new Promise((resolve) => lists.set(args.at(-1), resolve))
        : Promise.resolve({ code: 1 }),
    readTextFile: noop,
    watchFolder: noop,
    theme: noop,
    settings: noop,
    window: noop,
    shared: noop,
    setShared: noop,
    nextCommand: noop,
    props: noop,
  };
  const { default: Files } = await loadMod("vectron-files", "main.js", {
    herdr,
  });
  const timeline = tasks();
  const view = new Files();
  view.refresh(timeline.context);
  folder = "/new";
  view.refresh(timeline.context);

  lists.get("/new")({ code: 0, stdout: "f\0new file.js\0" });
  lists.get("/old")({ code: 0, stdout: "f\0outdated.js\0" });
  await timeline.flush();
  assert.equal(view.root, "/new");
  assert.equal(view.entries.get("")[0].name, "new file.js");
  assert.equal(view.loading, false);
});

test("Changes checks the index before committing all files", async () => {
  let unmerged = true;
  const writes = [];
  const { default: Changes } = await loadMod("vectron-changes", "main.js", {
    herdr: {
      exec: async (_program, args) => {
        if (args.includes("--unmerged")) return { code: 0, stdout: unmerged ? "conflict" : "" };
        writes.push(Array.from(args));
        return { code: 0 };
      },
      focused: () => ({ pane: null, cwd: "/repo" }),
      spaces: () => [],
      panes: () => [],
      readTextFile: noop, watchFolder: noop, theme: noop, settings: noop, props: noop,
      run: noop, shared: noop, setShared: noop, nextCommand: noop, openOverlay: noop,
      closeOverlay: noop, home: noop, notify: noop, knownAgents: noop, updates: noop,
    },
    "gpui-kit": { PathBuilder: noop },
    "gpui-base": { v_virtual_list: noop, TextView: noop },
  });
  const queue = tasks();
  const view = new Changes();
  view.root = "/repo";
  view.context = JSON.stringify({ cwd: "/repo", on: null });
  view.message = "Finish merge";
  view.input = { set_value: noop };
  view.refresh = noop;

  view.commit(queue.context);
  await queue.flush();
  assert.match(view.note, /merge conflicts/);
  assert.deepEqual(writes, []);

  unmerged = false;
  view.commit(queue.context);
  await queue.flush();
  assert.deepEqual(writes, [["add", "-A"], ["commit", "-m", "Finish merge"]]);
});

test("AI usage normalizes provider data and gives unsupported agents a label without an API call", async () => {
  const requests = [];
  const { sourcesFor, fetchUsage } = await loadMod(
    "vectron-ai-usage",
    "providers.js",
    {
      herdr: {
        home: () => "/fixture",
        readTextFile: async (path) =>
          path === "/fixture/.codex/auth.json"
            ? JSON.stringify({ tokens: { access_token: "fake-token" } })
            : null,
        settings: () => ({}),
      },
    },
    {
      fetch: async (url) => {
        requests.push(url);
        return {
          ok: true,
          json: async () => ({
            rate_limit: {
              primary_window: {
                used_percent: 14.6,
                limit_window_seconds: 18000,
                reset_at: 100,
              },
            },
          }),
        };
      },
    },
  );
  const [grok] = await sourcesFor({
    program: { key: "grok", name: "Grok Build" },
  });
  assert.equal(grok.note, "no usage API");
  assert.equal(requests.length, 0);

  const [codex] = await sourcesFor({
    program: { key: "codex", name: "Codex" },
  });
  const [window] = await fetchUsage(codex);
  assert.equal(window.used, 15);
  assert.equal(window.short, "5h");
  assert.equal(requests.length, 1);
});

test("AI usage pauses automatic polling while idle and resumes when an agent is visible", async () => {
  const state = new Map();
  let tab = "agent";
  let requests = 0;
  const herdr = {
    focused: () => ({ tab }),
    panes: () => [
      {
        tab: "agent",
        terminal: "t1",
        focused: true,
        program: { agent: true, key: "codex", name: "Codex" },
      },
    ],
    agents: () => [],
    shared: (key) => state.get(key),
    setShared: (key, value) => state.set(key, value),
    home: () => "/fixture",
    readTextFile: async () => JSON.stringify({ tokens: { access_token: "fixture-token" } }),
    props: noop, exec: noop, openOverlay: noop, settings: noop, theme: noop,
  };
  const { default: AiUsage } = await loadMod("vectron-ai-usage", "main.js", { herdr }, {
    fetch: async () => {
      requests += 1;
      return { ok: true, json: async () => ({}) };
    },
  });
  const queue = tasks();
  let tick;
  queue.context.timer.every = (_interval, callback) => {
    tick = callback;
  };
  const view = new AiUsage();
  view.init({}, queue.context);
  view.sync(queue.context);
  await queue.flush();
  assert.equal(requests, 1);

  tab = "shell";
  view.sync(queue.context);
  state.get("vectron-ai-usage.codex").checked = "1970-01-01T00:00:00Z";
  tick(queue.context);
  await queue.flush();
  assert.equal(requests, 1);

  tab = "agent";
  view.sync(queue.context);
  await queue.flush();
  assert.equal(requests, 2);
});
