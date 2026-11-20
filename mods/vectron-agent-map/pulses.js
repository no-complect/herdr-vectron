const firstFrameMs = 40;
export const travelMs = 340;
export const fadeMs = 180;

export class AttentionPulses {
  previous = new Map();
  active = new Map();
  sequence = 0;

  get(address) {
    return this.active.get(address);
  }

  update(space, nodes, cx) {
    if (space !== this.space) {
      this.space = space;
      this.previous.clear();
      this.active.clear();
    }

    const previous = this.previous;
    this.previous = new Map(nodes.map((node) => [node.address, node]));
    for (const [address, signal] of this.active) {
      const node = this.previous.get(address);
      if (node?.status !== signal.status || node.parent !== signal.parent) this.active.delete(address);
    }

    const started = [];
    for (const { address, parent, status } of nodes) {
      const before = previous.get(address);
      if (!parent || before?.parent !== parent || before.status === status) continue;
      if (status !== "blocked" && status !== "done") continue;
      const signal = { address, parent, status, sequence: ++this.sequence, phase: "start" };
      this.active.set(address, signal);
      started.push(signal);
    }
    if (!started.length) return;

    // Timers change phase once per batch. The native renderer moves and fades
    // each marker between phases without a JavaScript frame loop.
    const advance = (phase, cx) => {
      let changed = false;
      for (const signal of started) {
        if (this.active.get(signal.address) !== signal) continue;
        if (phase) signal.phase = phase;
        else this.active.delete(signal.address);
        changed = true;
      }
      if (changed) cx.notify();
    };
    cx.timer.after(firstFrameMs, (cx) => advance("travel", cx));
    cx.timer.after(firstFrameMs + travelMs, (cx) => advance("fade", cx));
    cx.timer.after(firstFrameMs + travelMs + fadeMs, (cx) => advance(null, cx));
  }
}
