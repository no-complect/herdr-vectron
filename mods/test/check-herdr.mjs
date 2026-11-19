import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mods = new URL("../", import.meta.url);
for (const entry of readdirSync(mods, { withFileTypes: true })) {
  if (
    !entry.isDirectory() ||
    !existsSync(new URL(`${entry.name}/main.js`, mods))
  )
    continue;

  const folder = fileURLToPath(new URL(entry.name, mods));
  const result = spawnSync("herdr-app", ["check", folder], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = 1;
}
