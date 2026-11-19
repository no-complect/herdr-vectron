export const providerNames = {
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok Build",
  agy: "Antigravity CLI",
};

function providerFor(entry) {
  for (const key of [entry?.app, entry?.report?.app, entry?.program?.key]) {
    if (typeof key !== "string") continue;
    if (/^codex(?:-|$)/.test(key)) return "codex";
    if (/^claude(?:-|$)/.test(key)) return "claude";
    if (/^grok(?:-build)?$/.test(key)) return "grok";
    if (/^(?:agy|antigravity(?:-cli)?)$/.test(key)) return "agy";
  }
  return null;
}

const supported = (entry) => providerFor(entry) !== null;

function selectedAgent(candidates, selectedAddress) {
  const selected = candidates.find((pane) => pane.terminal === selectedAddress);
  if (selected) return selected;

  const working = candidates.filter((pane) => pane.status === "working");
  if (working.length === 1) return working[0];
  return candidates.length === 1 ? candidates[0] : null;
}

// Opening a shell or the inspector should preserve the selected agent, while
// moving to another tab must never carry an unrelated conversation along.
export function focusedSession(focus, allPanes, allTerminals, previous) {
  if (!focus) return null;

  const previousInTab =
    previous?.space === focus.space && previous?.tab === focus.tab ? previous : null;
  let pane = allPanes.find((candidate) => candidate.pane === focus.pane);
  let address = focus.shown || focus.terminal || pane?.terminal;
  let terminal = allTerminals.find((candidate) => candidate.address === address);

  if (!(pane?.terminal === address && supported(pane)) && !supported(terminal)) {
    const candidates = allPanes.filter(
      (candidate) => candidate.tab === focus.tab && supported(candidate),
    );
    pane = selectedAgent(candidates, focus.agent);
    if (!pane) return previousInTab;
    address = pane.terminal;
    terminal = allTerminals.find((candidate) => candidate.address === address);
  }
  if (!address) return previousInTab;

  const provider = providerFor(terminal) ?? (pane?.terminal === address ? providerFor(pane) : null);
  return {
    address,
    space: focus.space,
    tab: focus.tab,
    pid: terminal?.foreground?.pid,
    title: terminal?.report?.title || pane?.title || terminal?.title || "",
    cwd: terminal?.foreground?.cwd || pane?.cwd || focus.cwd || terminal?.cwd,
    session_id: terminal?.labels?.["agent.session"],
    provider,
  };
}
