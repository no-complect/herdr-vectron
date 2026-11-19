import assert from "node:assert/strict";
import test from "node:test";
import { focusedSession } from "../vectron-context/target.js";

const focus = {
  space: "space-one",
  tab: "tab-one",
  pane: "shell-pane",
  agent: "claude-terminal",
};
const codex = {
  pane: "codex-pane",
  terminal: "codex-terminal",
  tab: focus.tab,
  program: { key: "codex" },
  status: "working",
};
const claude = {
  pane: "claude-pane",
  terminal: "claude-terminal",
  tab: focus.tab,
  program: { key: "claude" },
  status: "idle",
};
const terminals = [
  { address: "codex-terminal", program: { key: "codex" }, report: { title: "Codex session" } },
  {
    address: "claude-terminal",
    program: { key: "claude" },
    report: { title: "Claude session" },
    labels: { "agent.session": "session-identifier" },
  },
];

test("the selected agent wins over another working agent while a shell is focused", () => {
  const target = focusedSession(focus, [codex, claude], terminals);
  assert.equal(target.provider, "claude");
  assert.equal(target.session_id, "session-identifier");
});

test("a focused agent takes precedence over the sidebar selection", () => {
  const target = focusedSession({ ...focus, pane: codex.pane }, [codex, claude], terminals);
  assert.equal(target.address, codex.terminal);
});

test("terminal blocks work without a model pane", () => {
  const target = focusedSession({ ...focus, shown: claude.terminal }, [], terminals);
  assert.equal(target.provider, "claude");
});

test("a retained target stays within its original space and tab", () => {
  const previous = { ...focus, address: codex.terminal, provider: "codex" };
  assert.equal(focusedSession(focus, [], [], previous), previous);
  assert.equal(focusedSession({ ...focus, tab: "another-tab" }, [], [], previous), null);
  assert.equal(focusedSession({ ...focus, space: "another-space" }, [], [], previous), null);
  assert.equal(focusedSession(null, [codex], terminals, previous), null);
});

test("ambiguous agents require selection rather than guessing", () => {
  const target = focusedSession(
    { ...focus, agent: null },
    [codex, { ...claude, status: "working" }],
    terminals,
  );
  assert.equal(target, null);
});

test("Grok Build and Antigravity programs retain their own provider identity", () => {
  for (const [key, provider] of [
    ["grok", "grok"],
    ["grok-build", "grok"],
    ["agy", "agy"],
    ["antigravity", "agy"],
    ["antigravity-cli", "agy"],
  ]) {
    const pane = { ...codex, program: { key } };
    const target = focusedSession({ ...focus, pane: pane.pane }, [pane], []);
    assert.equal(target.provider, provider, key);
  }
});

test("unsupported Gemini CLI and unrelated names are not interpreted as Antigravity", () => {
  for (const key of ["gemini", "shell", "not-codex", "grok-editor"]) {
    const pane = { ...codex, program: { key } };
    assert.equal(focusedSession({ ...focus, pane: pane.pane }, [pane], []), null, key);
  }
});

test("live agent reports identify providers with generic program-table entries", () => {
  const pane = { ...codex, program: { key: "agent" }, app: "antigravity" };
  assert.equal(focusedSession({ ...focus, pane: pane.pane }, [pane], []).provider, "agy");
  const terminal = { address: "grok-terminal", program: { key: "agent" }, report: { app: "grok" } };
  assert.equal(
    focusedSession({ ...focus, shown: terminal.address }, [], [terminal]).provider,
    "grok",
  );
});

test("a shown replacement terminal takes precedence over the original pane program", () => {
  const terminal = {
    address: "agy-terminal",
    program: { key: "agent" },
    report: { app: "antigravity" },
  };
  const target = focusedSession(
    { ...focus, pane: codex.pane, shown: terminal.address },
    [codex],
    [terminal],
  );
  assert.equal(target.address, terminal.address);
  assert.equal(target.provider, "agy");
});
