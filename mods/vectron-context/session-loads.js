import { appHome, exec } from "herdr";
import { appendSnapshot } from "./append-snapshot.js";

export async function readSession(request, timeout = 15000) {
  const result = await exec(
    "python3",
    [`${appHome()}/mods/vectron-context/inspect_session.py`, "--request", JSON.stringify(request)],
    { timeout },
  );
  if (result.code !== 0) {
    throw new Error("The local session reader could not start. Python 3 is required.");
  }
  const data = JSON.parse(result.stdout);
  if (data.error) throw new Error(data.error);
  return data;
}

const recent = new Map();
const reading = new Map();

export function recentSession(key) {
  return recent.get(key);
}

function save(key, snapshot) {
  recent.delete(key);
  if (snapshot.path) recent.set(key, snapshot);
  if (recent.size > 3) recent.delete(recent.keys().next().value);
}

export function joinRead(key, request, previous, force) {
  let read = reading.get(key);
  if (!read || (force && read.started)) {
    const earlier = read;
    read = { users: 0, started: false, settled: false, earlier };
    reading.set(key, read);
    const fullRequest = { ...request, want_checkpoint: request.provider === "codex" };
    const begin = async () => {
      if (earlier && read.users === 0) return null;
      read.started = true;
      read.earlier = null;

      const base = recentSession(key) ?? previous;
      const result = await readSession({
        ...fullRequest,
        signature: force ? null : base?.signature,
        checkpoint: force ? null : base?.checkpoint,
      });
      let snapshot = result;
      if (result.unchanged) snapshot = { ...base, ...result };
      if (result.delta_base) {
        snapshot = result.delta_base === base?.signature && result.path === base.path
          ? appendSnapshot(base, result)
          : await readSession(fullRequest);
      }
      if (reading.get(key) === read) save(key, snapshot);
      return snapshot;
    };
    // Refresh must read from a point after the click, even if an older read fails.
    read.promise = (earlier ? earlier.promise.then(begin, begin) : begin()).finally(() => {
      read.settled = true;
      if (reading.get(key) === read) reading.delete(key);
    });
  }
  read.users++;

  return {
    promise: read.promise,
    leave() {
      if (--read.users !== 0 || reading.get(key) !== read) return;
      const earlier = read.earlier;
      if (earlier?.users && !earlier.settled) reading.set(key, earlier);
      else reading.delete(key);
    },
  };
}
