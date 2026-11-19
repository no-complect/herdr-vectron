export const MARKET_TOPIC = "herdr-mod";

// A package is any folder of a repo that holds `mods/<name>/main.js`: the repo root, or one
// folder per package when a repo holds several (`github-panel/mods/github/…`).
export function findPackages(files) {
  const byPrefix = new Map();
  for (const f of files) {
    const m = f.match(/^(?:(.*)\/)?mods\/([^/]+)\/main\.js$/);
    if (!m) continue;
    const prefix = m[1] ?? "";
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, { prefix, mods: [], layouts: [], files: [] });
    byPrefix.get(prefix).mods.push(m[2]);
  }
  for (const pkg of byPrefix.values()) {
    const base = pkg.prefix ? `${pkg.prefix}/` : "";
    pkg.mods.sort();
    pkg.files = files.filter((f) => pkg.mods.some((name) => f.startsWith(`${base}mods/${name}/`)));
    pkg.layouts = files.filter(
      (f) => f.startsWith(`${base}layouts/`) && !f.slice(base.length + 8).includes("/"),
    );
    pkg.recipe = files.includes(`${base}RECIPE.md`);
    pkg.preview = files.includes(`${base}preview.png`);
    pkg.keys = files.includes(`${base}keys.json`);
    pkg.name = pkg.prefix ? pkg.prefix.split("/").at(-1) : pkg.mods.join(" + ");
  }
  return [...byPrefix.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
}

// Surface common side effects for the install preview. Patterns can miss indirect calls.
const RISKS = [
  ["runs programs", /\bexec\s*\(|\bhc\s*\(|process\.run/],
  ["reaches the network", /\bfetch\s*\(|WebSocket/],
  ["reads files", /readTextFile\s*\(|watchFolder\s*\(|fs\.(readFile|readdir|stat)/],
  ["writes files", /writeTextFile\s*\(|fs\.(writeFile|mkdir|rm|unlink|rename)/],
];

export function scanRisks(sources) {
  const found = new Map();
  for (const { path, text } of sources) {
    for (const [label, re] of RISKS) {
      if (re.test(text)) {
        if (!found.has(label)) found.set(label, []);
        found.get(label).push(path);
      }
    }
  }
  return [...found].map(([label, paths]) => ({ label, paths }));
}

async function run(io, cmd, args, opts) {
  const r = await io.exec(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export function repoUrl(fullName) {
  return /^(https?|file|git):|^\//.test(fullName) ? fullName : `https://github.com/${fullName}.git`;
}

// Shallow clone into a fresh folder under `cacheDir`; returns the folder, commit and tracked files.
export async function fetchSource(io, source, cacheDir) {
  const dir = `${cacheDir}/${source.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "")}-${Date.now()}`;
  await run(io, "mkdir", ["-p", cacheDir]);
  await run(io, "git", ["clone", "-q", "--depth", "1", repoUrl(source), dir]);
  const sha = (await run(io, "git", ["-C", dir, "rev-parse", "HEAD"])).trim();
  const files = (await run(io, "git", ["-C", dir, "ls-files"])).split("\n").filter(Boolean);
  return { dir, sha, files };
}

export async function remoteSha(io, source) {
  const out = await run(io, "git", ["ls-remote", repoUrl(source), "HEAD"]);
  return out.split(/\s/)[0] || null;
}

export async function readSources(io, dir, pkg) {
  const texts = [];
  for (const path of pkg.files.filter((f) => /\.(m?js|json)$/.test(f))) {
    texts.push({ path, text: (await io.readText(`${dir}/${path}`)) ?? "" });
  }
  return texts;
}

function parseKeys(text) {
  if (!text) return {};
  const v = JSON.parse(text);
  return v && typeof v === "object" ? v : {};
}

// What installing `pkg` would do, without doing it. `record` is the earlier install of the same
// package (an update): its own mods and layouts are replaced, anything else with the same name is
// a clash and blocks the install, as AGENTS.md never overwrites.
export async function planInstall(
  io,
  { appHome, dir, pkg, record, existingMods, existingLayouts },
) {
  const base = pkg.prefix ? `${dir}/${pkg.prefix}` : dir;
  const ownMods = new Set(record?.mods ?? []);
  const ownLayouts = new Set(record?.layouts ?? []);
  const layouts = pkg.layouts.map((f) => f.split("/").at(-1));
  const clashes = [
    ...pkg.mods.filter((m) => existingMods.includes(m) && !ownMods.has(m)).map((m) => `mods/${m}`),
    ...layouts
      .filter((l) => existingLayouts.includes(l) && !ownLayouts.has(l))
      .map((l) => `layouts/${l}`),
  ];

  const theirs = pkg.keys ? parseKeys(await io.readText(`${base}/keys.json`)) : {};
  const mine = parseKeys(await io.readText(`${appHome}/keys.json`));
  // A key the package added earlier and the person left alone is the package's to change.
  const ownKeys = new Map(
    (record?.keys ?? []).map((k) => [`${k.section}\u0000${k.key}`, k.action]),
  );
  const keyAdds = [];
  const keyConflicts = [];

  for (const [section, entries] of Object.entries(theirs)) {
    for (const [key, action] of Object.entries(entries ?? {})) {
      const current = mine[section]?.[key];
      const own = ownKeys.get(`${section}\u0000${key}`);
      if (current === undefined || current === action || (own !== undefined && current === own)) {
        if (current !== action) keyAdds.push({ section, key, action, previous: current });
      } else {
        keyConflicts.push({ section, key, action, current });
      }
    }
  }

  return {
    base,
    mods: pkg.mods,
    layouts,
    clashes,
    keyAdds,
    keyConflicts,
    risks: scanRisks(await readSources(io, dir, pkg)),
  };
}

async function writeKeys(io, appHome, change) {
  const path = `${appHome}/keys.json`;
  const previous = await io.readText(path);
  const keys = parseKeys(previous);
  change(keys);
  await io.writeText(path, JSON.stringify(keys, null, 2) + "\n", previous);
}

const packagePaths = ({ mods = [], layouts = [] }) => [
  ...mods.map((name) => `mods/${name}`),
  ...layouts.map((name) => `layouts/${name}`),
];

async function pathExists(io, path) {
  const found = await io.exec("test", ["-e", path, "-o", "-L", path]);
  if (found.code === 0 || found.code === 1) return found.code === 0;
  throw new Error(`Could not check whether ${path} exists.`);
}

export async function applyInstall(io, { appHome, plan, source, prefix, sha, record }) {
  if (plan.clashes.length) throw new Error(`already exists: ${plan.clashes.join(", ")}`);

  // One installer at a time. Keep the staging directory on the config filesystem
  // so each replacement and backup can be moved without copying it a second time.
  const staging = `${appHome}/.mod-manager-install`;
  const incoming = `${staging}/incoming`;
  const backup = `${staging}/backup`;
  const previousFiles = new Set(packagePaths(record ?? {}));
  const incomingFiles = new Set(packagePaths(plan));
  const changes = [];
  let keepBackups = false;

  await run(io, "mkdir", [staging]);
  try {
    await run(io, "mkdir", [
      "-p",
      ...[incoming, backup, appHome].flatMap((dir) => [`${dir}/mods`, `${dir}/layouts`]),
    ]);
    for (const path of incomingFiles) {
      const flags = path.startsWith("mods/") ? ["-R"] : [];
      await run(io, "cp", [...flags, `${plan.base}/${path}`, `${incoming}/${path}`]);
    }
    for (const mod of plan.mods) {
      const check = await io.exec("herdr-app", ["check", `${incoming}/mods/${mod}`]);
      if (check.code !== 0) {
        const detail = (check.stderr || check.stdout || "").trim().split("\n")[0];
        throw new Error(`herdr-app check failed on ${mod}${detail ? `: ${detail}` : ""}`);
      }
    }

    for (const path of new Set([...previousFiles, ...incomingFiles])) {
      const live = `${appHome}/${path}`;
      const present = await pathExists(io, live);
      if (present && !previousFiles.has(path)) throw new Error(`already exists: ${path}`);

      const change = { path, saved: false, added: false };
      changes.push(change);
      if (present) {
        await run(io, "mv", [live, `${backup}/${path}`]);
        change.saved = true;
      }
      if (incomingFiles.has(path)) {
        await run(io, "mv", [`${incoming}/${path}`, live]);
        change.added = true;
      }
    }

    if (plan.keyAdds.length) {
      await writeKeys(io, appHome, (keys) => {
        for (const { section, key, action, previous } of plan.keyAdds) {
          const bindings = (keys[section] ??= {});
          if (bindings[key] !== previous)
            throw new Error(`Shortcut ${key} in ${section} changed. Review the package again.`);
          bindings[key] = action;
        }
      });
    }
  } catch (error) {
    for (const { path, added, saved } of changes.reverse()) {
      const live = `${appHome}/${path}`;
      try {
        if (added) await run(io, "rm", ["-rf", live]);
        if (saved) await run(io, "mv", [`${backup}/${path}`, live]);
      } catch {
        keepBackups = true;
      }
    }
    if (keepBackups)
      throw new Error(`${error.message}\nRollback was incomplete. Backups are in ${backup}.`);
    throw error;
  } finally {
    if (!keepBackups) await io.exec("rm", ["-rf", staging]).catch(() => null);
  }

  const keys = [
    ...(record?.keys ?? []).filter(
      (k) => !plan.keyConflicts.some((c) => c.section === k.section && c.key === k.key),
    ),
    ...plan.keyAdds,
  ];
  return {
    source,
    prefix,
    sha,
    mods: plan.mods,
    layouts: plan.layouts,
    keys: dedupeKeys(keys),
    risks: plan.risks.map((r) => r.label),
    at: new Date().toISOString(),
  };
}

function dedupeKeys(keys) {
  const seen = new Map();
  for (const { section, key, action } of keys) {
    seen.set(`${section}\u0000${key}`, { section, key, action });
  }
  return [...seen.values()];
}

// Removes what the record says the manager installed. A key is removed only while it still runs
// the action the package added: one the person rebound since then stays.
export async function uninstall(io, { appHome, record }) {
  for (const m of record.mods) await run(io, "rm", ["-rf", `${appHome}/mods/${m}`]);
  for (const l of record.layouts ?? []) await run(io, "rm", ["-f", `${appHome}/layouts/${l}`]);
  if (record.keys?.length) {
    await writeKeys(io, appHome, (all) => {
      for (const k of record.keys) {
        if (all[k.section]?.[k.key] === k.action) delete all[k.section][k.key];
      }
    });
  }
}

// A mod the manager did not install: a symlink is only unlinked, the folder it points to stays.
export async function removeLocal(io, { appHome, name, symlink }) {
  await run(io, "rm", symlink ? [`${appHome}/mods/${name}`] : ["-rf", `${appHome}/mods/${name}`]);
}

// The person's mods folder: Herdr's own (listed in installed.json), the manager's and the rest.
export async function listMods(io, { appHome, records }) {
  const shipped = Object.keys(parseKeys(await io.readText(`${appHome}/installed.json`)));
  const out = await run(io, "find", [
    `${appHome}/mods`,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "(",
    "-type",
    "d",
    "-o",
    "-type",
    "l",
    ")",
  ]);
  const links = new Set(
    (await run(io, "find", [`${appHome}/mods`, "-mindepth", "1", "-maxdepth", "1", "-type", "l"]))
      .split("\n")
      .filter(Boolean)
      .map((p) => p.split("/").at(-1)),
  );
  const owner = new Map();
  for (const r of records) for (const m of r.mods) owner.set(m, r);
  return out
    .split("\n")
    .filter(Boolean)
    .map((p) => p.split("/").at(-1))
    .filter((name) => !name.startsWith("."))
    .sort()
    .map((name) => ({
      name,
      kind: owner.has(name) ? "installed" : shipped.includes(name) ? "herdr" : "local",
      symlink: links.has(name),
      record: owner.get(name) ?? null,
    }))
    .sort((a, b) => (a.kind === "herdr") - (b.kind === "herdr"));
}

// GitHub search for the topic, as herdr.dev lists Community. `gh api` carries the person's login
// (30 searches a minute instead of 10); without `gh`, `anonymous(url)` fetches the same URL.
export async function searchMarket(
  io,
  { query = "", sort = "stars", page = 1, perPage = 50 },
  anonymous,
) {
  const q = `topic:${MARKET_TOPIC}${query.trim() ? ` ${query.trim()}` : ""}`;
  const params = { q, sort, order: "desc", per_page: String(perPage), page: String(page) };
  let body = null;
  let ghError = null;
  try {
    const args = ["api", "-X", "GET", "search/repositories"];
    for (const [k, v] of Object.entries(params)) args.push("-f", `${k}=${v}`);
    const r = await io.exec("gh", args);
    if (r.code === 0) body = JSON.parse(r.stdout);
    else ghError = (r.stderr || r.stdout).trim();
  } catch (e) {
    ghError = String(e?.message ?? e);
  }
  if (!body) {
    const url = `https://api.github.com/search/repositories?${new URLSearchParams(params)}`;
    const res = await anonymous(url);
    if (res.status !== 200) {
      const msg = (() => {
        try {
          return JSON.parse(res.text).message;
        } catch {
          return res.text.slice(0, 120);
        }
      })();
      throw new Error(`GitHub answered ${res.status}: ${msg}${ghError ? ` (gh: ${ghError})` : ""}`);
    }
    body = JSON.parse(res.text);
  }
  return {
    total: Math.min(body.total_count ?? 0, 1000),
    items: (body.items ?? []).map((r) => ({
      fullName: r.full_name,
      description: r.description ?? "",
      stars: r.stargazers_count ?? 0,
      pushedAt: r.pushed_at,
      url: r.html_url,
    })),
  };
}
