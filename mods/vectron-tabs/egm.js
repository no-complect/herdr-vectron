const probes = [
  ["codex", ["--marketplace", "egm"], (result) => result?.installed?.some(
    (plugin) => plugin?.pluginId === "egm@egm" && plugin.installed === true && plugin.enabled === true,
  )],
  ["claude", [], (result) => result?.some(
    (plugin) => plugin?.id === "egm@egm" && plugin.enabled === true,
  )],
  ["agy", [], (result) => result?.some(
    (plugin) => plugin?.name === "egm" && plugin.enabled === true &&
      plugin.skills?.includes("egm-brainstorm"),
  )],
];

export async function detectEgm(exec) {
  const installed = await Promise.all(probes.map(async ([agent, options, check]) => {
    try {
      const result = await exec(agent, ["plugin", "list", ...options, "--json"], { timeout: 5000 });
      return result.code === 0 && Boolean(check(JSON.parse(result.stdout)));
    } catch {
      return false;
    }
  }));
  return installed.some(Boolean);
}
