// Lays commits out on lanes. Commits come newest first, every child before its
// parents (git log --date-order). A lane is a column waiting for one commit and
// keeps its column until that commit arrives, so lines bend only where
// branches fork or merge. A commit marked `dashed` (uncommitted changes) draws
// its line to its parent dashed.
//
// Each segment is [fromLane, fromY, toLane, toY, colorLane, dashed, sources].
// Y runs from the top of the row through the dot at 0.5 to the bottom.
// Sources are the commits whose outgoing edges use this piece of lane.
export function layoutLanes(commits) {
  const lanes = [],
    dashed = [],
    sources = []; // lanes[i]: the hash that column waits for, or null
  const free = () => {
    const i = lanes.indexOf(null);
    return i < 0 ? lanes.length : i;
  };
  let width = 1;
  const rows = commits.map((commit) => {
    const before = lanes.slice(),
      wasDashed = dashed.slice(),
      previousSources = sources.slice(),
      segments = [];
    const outgoing = [commit.hash];
    let lane = before.indexOf(commit.hash);
    if (lane < 0) {
      lane = free();
      lanes[lane] = commit.hash;
      dashed[lane] = false;
      sources[lane] = [];
    } // a branch tip: nothing above it
    before.forEach((hash, j) => {
      if (hash === null || hash === undefined) return;
      if (hash === commit.hash) {
        segments.push([j, 0, lane, 0.5, j, Boolean(wasDashed[j]), previousSources[j]]);
        if (j !== lane) {
          lanes[j] = null;
          dashed[j] = false;
          sources[j] = [];
        } // branches that end here
      } else segments.push([j, 0, j, 1, j, Boolean(wasDashed[j]), previousSources[j]]);
    });
    const [first, ...rest] = commit.parents;
    lanes[lane] = first ?? null;
    dashed[lane] = Boolean(first && commit.dashed);
    sources[lane] = first ? outgoing : [];
    if (first) segments.push([lane, 0.5, lane, 1, lane, dashed[lane], outgoing]);
    for (const parent of rest) {
      let k = lanes.indexOf(parent);
      if (k < 0) {
        k = free();
        lanes[k] = parent;
        dashed[k] = Boolean(commit.dashed);
        sources[k] = outgoing;
      } else {
        sources[k] = [...sources[k], commit.hash];
      }
      segments.push([lane, 0.5, k, 1, k, dashed[k], outgoing]);
    }
    width = Math.max(width, before.length, lanes.length);
    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
      dashed.length = lanes.length;
      sources.length = lanes.length;
    }
    return { lane, segments };
  });
  return { rows, width };
}

export function ancestryDepths(commits, selected) {
  const parents = new Map(commits.map(({ hash, parents }) => [hash, parents]));
  if (!parents.has(selected)) return new Map();

  const depths = new Map([[selected, 0]]);
  // Map iteration also visits newly appended entries, so both arms of a
  // merge are visited at the same depth and a shared ancestor is queued once.
  for (const [hash, depth] of depths) {
    for (const parent of parents.get(hash) ?? []) {
      if (!depths.has(parent)) depths.set(parent, depth + 1);
    }
  }
  return depths;
}
