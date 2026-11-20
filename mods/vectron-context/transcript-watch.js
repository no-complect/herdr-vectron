import { watchFolder } from "herdr";

const debounceMs = 175;

export class TranscriptWatch {
  current = null;

  stop() {
    const previous = this.current;
    this.current = null;
    previous?.waiting?.cancel();
  }

  queue(watch, changed, cx) {
    if (watch.queued) return;
    watch.queued = true;
    cx.timer.after(debounceMs, (cx) => {
      if (this.current !== watch) return;
      watch.queued = false;
      changed(cx);
    });
  }

  observe(path, provider, changed, cx) {
    if (this.current?.path === path) return;
    this.stop();
    if (!path) return;

    const normalized = (value) => value.replaceAll("\\", "/");
    const pathWithSlashes = normalized(path);
    const parentEnd = pathWithSlashes.lastIndexOf("/");
    const folder = path.slice(0, parentEnd) || "/";
    const directory = normalized(folder);
    const sources = new Set([directory, pathWithSlashes]);
    if (provider === "grok") {
      sources.add(`${directory}/updates.jsonl`);
      sources.add(`${directory}/summary.json`);
    }
    const watch = { path, waiting: null, queued: false, armed: false };
    this.current = watch;

    cx.spawn(async (cx) => {
      try {
        while (this.current === watch) {
          watch.waiting = watchFolder(folder);
          // Re-arm before refreshing so bursts can share one read.
          if (!watch.waiting) break;
          if (!watch.armed) {
            // Close the gap between the first snapshot and attaching its watcher.
            watch.armed = true;
            this.queue(watch, changed, cx);
          }
          const paths = await watch.waiting;
          watch.waiting = null;
          if (this.current !== watch || !paths.length) break;
          if (paths.some((source) => sources.has(normalized(source)))) this.queue(watch, changed, cx);
        }
      } catch {
        // The periodic check still catches changes when watching is unavailable.
      } finally {
        watch.waiting = null;
        if (this.current === watch) this.current = null;
      }
    });
  }
}
