import { InputGlow } from "./input-glow.js";
import { View, div, svg, uniform_list } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Editor, EditorState, Scrollbar } from "gpui-base";
import {
  appHome,
  exec,
  focused,
  panes,
  terminals,
  layout,
  props,
  theme,
  settings,
  shared,
  openOverlay,
  closeOverlay,
} from "herdr";
import { categories, categoryOf, ContextEvents, formatCount, reportedUsageAt } from "./model.js";
import { Flash, flashColor } from "./beam.js";
import { CompactionAfterimage, afterimageLayer, compactionComparison } from "./afterimage.js";
import { layoutVisibility } from "./visibility.js";
import { focusedSession, providerNames } from "./target.js";

const MOD = "vectron-context";
// Copies share this module, so keyboard-opened dialogs can inherit the panel's
// selected session without persisting an attachment or any conversation text.
let panelInstance = null;

function sessionKey(target) {
  const { address, provider, session_id: sessionId, pid } = target ?? {};
  // A process can restart and resume the same recorded session.
  return JSON.stringify([address, provider, sessionId || null, sessionId ? null : pid]);
}

async function readSession(request, timeout = 15000) {
  const result = await exec(
    "python3",
    [`${appHome()}/mods/${MOD}/inspect_session.py`, "--request", JSON.stringify(request)],
    { timeout },
  );
  if (result.code !== 0) {
    throw new Error("The local session reader could not start. Python 3 is required.");
  }
  const data = JSON.parse(result.stdout);
  if (data.error) throw new Error(data.error);
  return data;
}

export default class ContextInspector extends View {
  contextEvents = new ContextEvents();
  afterimage = new CompactionAfterimage();

  init(_props, cx) {
    this.inputGlow = new InputGlow();
    const options = props() ?? {};
    const attachment = options.overlay ? panelInstance?.attachment() : null;
    this.expandedTarget = options.target ?? attachment?.target;
    this.width = props()?.overlay ? 1100 : 450;
    this.controlsFlash = new Flash();
    this.dataFlash = new Flash();
    this.panelFlash = new Flash();
    this.data = null;
    this.pendingRead = null;
    this.error = null;
    this.selectedCategory = null;
    this.timelineOrder = "timeline";
    this.showWholeHistory = false;
    this.replayCutoff = null;
    this.pinned = null;
    this.details = null;
    this.detailKey = null;
    this.manual = new Map();
    const selectedPath =
      options.selectedPath ??
      (sessionKey(this.expandedTarget) === sessionKey(attachment?.target)
        ? attachment?.selectedPath
        : null);
    if (selectedPath && this.expandedTarget?.address) {
      this.manual.set(sessionKey(this.expandedTarget), selectedPath);
    }
    if (!options.overlay) panelInstance = this;
    this.picker = false;
    this.about = false;
    this.closed = false;
    this.search = InputState.new({ placeholder: "Filter events…" });
    this.searchQuery = "";
    this.search.on("change", (_e, cx) => {
      this.inputGlow.typing(cx);
      this.searchQuery = this.search.value().toLowerCase();
      cx.notify();
    });
    cx.timer.every(5000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  close() {
    this.closed = true;
    this.afterimage.clear();
    this.code?.release();
    if (panelInstance === this) panelInstance = null;
  }

  target() {
    if (props()?.target) return props().target;
    if (this.expandedTarget) return this.expandedTarget;
    this.lastTarget = focusedSession(focused(), panes(), terminals(), this.lastTarget);
    return this.lastTarget;
  }

  selectedTarget() {
    const target = this.target();
    const previous = this.selectionTarget;
    this.selectionTarget = target;
    if (
      !target?.session_id ||
      !previous ||
      previous.session_id ||
      !Number.isInteger(target.pid) ||
      target.pid <= 0 ||
      target.pid !== previous.pid ||
      target.address !== previous.address ||
      target.provider !== previous.provider
    ) return target;

    const previousKey = sessionKey(previous);
    const selectedPath = this.manual.get(previousKey);
    if (!selectedPath) return target;

    // A label identified the same running process. Carry its explicit transcript choice forward.
    const previousIdentity = this.targetIdentity(previous);
    const key = sessionKey(target);
    this.manual.delete(previousKey);
    if (!this.manual.has(key)) this.manual.set(key, selectedPath);
    if (this.identity === previousIdentity && this.manual.get(key) === selectedPath) {
      this.identity = this.targetIdentity(target);
      this.pendingRead = null;
    }
    return target;
  }

  attachment() {
    const target = this.selectedTarget();
    return { target, selectedPath: this.manual.get(sessionKey(target)) };
  }

  targetIdentity(target) {
    const key = sessionKey(target);
    return JSON.stringify([key, target?.title, target?.cwd, this.manual.get(key)]);
  }

  visible() {
    if (props()?.overlay) return true;
    if (props()?.pane) {
      const allPanes = panes();
      const pane = allPanes.find((candidate) => candidate.pane === props().pane);
      return Boolean(
        pane &&
        pane.tab === focused()?.tab &&
        !allPanes.some(
          (candidate) =>
            candidate.tab === pane.tab && candidate.zoomed && candidate.pane !== pane.pane,
        ),
      );
    }
    return layoutVisibility(layout(), MOD, props()?.blockId) !== false;
  }

  clearDetail() {
    this.code?.release();
    this.code = null;
    this.details = null;
    this.detailKey = null;
    this.pinned = null;
  }

  resetSession(identity) {
    this.identity = identity;
    this.dataFlash.burst = null;
    this.afterimage.clear();
    this.contextEvents = new ContextEvents();
    this.data = null;
    this.error = null;
    this.pendingRead = null;
    this.replayCutoff = null;
    this.clearDetail();
  }

  refresh(cx, force = false) {
    if (this.closed) return;
    if (!force && !this.visible()) return;

    const target = this.selectedTarget();
    const identity = this.targetIdentity(target);
    if (identity !== this.identity) this.resetSession(identity);

    if (this.pendingRead || !target) return;
    if (target.address.includes("/")) {
      this.error = "Context currently reads local sessions only.";
      return;
    }
    if (!Object.keys(providerNames).includes(target.provider)) {
      this.error =
        "Focus a Codex, Claude Code, Grok Build or Antigravity CLI session to inspect it.";
      return;
    }

    const request = {
      ...target,
      path: this.manual.get(sessionKey(target)),
      signature: force ? null : this.data?.signature,
    };
    // Two visits to the same session can have different reads in flight.
    this.pendingRead = request;
    const isCurrentRead = () =>
      !this.closed &&
      this.pendingRead === request &&
      this.targetIdentity(this.target()) === identity;
    cx.spawn(async (cx) => {
      try {
        const response = await readSession(request);
        if (!isCurrentRead()) return;

        const previous = this.data;
        const sameSession = previous?.path && previous.path === response.path;
        if (previous?.path && !sameSession) {
          this.replayCutoff = null;
          this.dataFlash.burst = null;
          this.afterimage.clear();
          this.clearDetail();
        }
        this.data = response.unchanged ? { ...previous, ...response } : response;
        this.error = null;

        if (!response.unchanged && this.replayCutoff === null && sameSession && this.visible()) {
          this.flashUpdatedCounts(cx, previous, this.data);
        }
      } catch (error) {
        if (isCurrentRead()) {
          this.error = String(error.message || error);
        }
      } finally {
        if (this.pendingRead === request) {
          this.pendingRead = null;
          if (!this.closed) cx.notify();
        }
      }
    });
  }

  inspect(event, cx) {
    const changed = this.pinned !== event.id;
    this.pinned = event.id;
    const key = `${this.data?.path}:${event.id}`;
    if (key === this.detailKey) {
      if (changed) cx.notify();
      return;
    }
    this.detailKey = key;
    this.code?.release();
    this.code = null;
    this.details = null;
    cx.spawn(async (cx) => {
      try {
        const detail = await readSession(
          {
            action: "detail",
            source: event.source,
            offset: event.offset,
            line: event.line,
            field: event.field,
            protected: event.protected,
          },
          10000,
        );
        if (this.closed || this.detailKey !== key) return;
        this.details = detail.text || detail.error || "This event has no text preview.";
        if (detail.truncated) this.details += "\n\n[Preview limited to 24,000 characters]";
        this.code = EditorState.new({
          language: "text",
          value: this.details,
          readonly: true,
          font_family: settings().font_family,
          font_size: 12,
        });
      } catch {
        if (this.detailKey === key) this.details = "The source could not be previewed.";
      } finally {
        cx.notify();
      }
    });
    cx.notify();
  }

  expand() {
    openOverlay({
      mod: MOD,
      kind: "dialog",
      width: 1120,
      height: 760,
      props: this.attachment(),
    });
  }

  button(id, text, action, on = false) {
    const t = theme();
    return div()
      .id(id)
      .px(8)
      .py(4)
      .rounded(3)
      .cursor_pointer()
      .text_size(11)
      .relative()
      .bg(on ? t.selected : t.surface)
      .text_color(on ? t.accent : t.muted)
      .child(this.controlsFlash.layer(id))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        this.lastFlashColor = flashColor(this.lastFlashColor, t);
        this.controlsFlash.start(cx, new Map([[id, this.lastFlashColor]]), {
          alreadyRendering: true,
        });
        action(cx);
        cx.notify();
      })
      .child(text);
  }

  flashUpdatedCounts(cx, previous, current) {
    const before = reportedUsageAt(previous, null);
    const after = reportedUsageAt(current, null);
    const previousTotals = this.contextEvents.capture(previous, null, this.showWholeHistory).totals;
    const currentTotals = this.contextEvents.capture(current, null, this.showWholeHistory).totals;
    const beforeCounts = previousTotals.counts;
    const afterCounts = currentTotals.counts;

    if (!this.showWholeHistory && this.replayCutoff === null) {
      const comparison = compactionComparison(previous, current, previousTotals.sum, currentTotals.sum);
      if (comparison) this.afterimage.start(cx, comparison);
    }

    const targets = new Map();
    if (after?.window && (before?.input !== after.input || before?.window !== after.window)) {
      targets.set("reported", this.usageBarColor(after));
    }
    for (const category of categories) {
      if (afterCounts[category.id] && beforeCounts[category.id] !== afterCounts[category.id]) {
        targets.set(category.id, category.color);
      }
    }
    this.dataFlash.start(cx, targets, { alreadyRendering: true });
  }

  usageBarColor(usage) {
    const fraction = usage?.window ? usage.input / usage.window : 0;
    const t = theme();
    if (fraction >= 0.9) return t.blocked;
    if (fraction >= 0.75) return "#f8ab59";
    return t.ansi4;
  }

  breathingFill(key, color, period) {
    return div()
      .id("vector-fill-" + key)
      .absolute()
      .inset_0()
      .bg(color)
      .loop("opacity", { from: 0.46, to: 1, period });
  }

  gauge(usage) {
    const t = theme();
    let note = "No model usage sample is recorded yet.";
    if (usage?.before_retained_history) {
      note = "Last recorded usage predates the retained history.";
    } else if (usage?.kind === "context") {
      note = "Grok's recorded context estimate; an in-flight turn may be ahead.";
    } else if (usage) {
      note = "Reported by the last model request; an in-flight turn may be ahead.";
    } else if (this.replayCutoff != null) {
      note = "No usage sample is available at this replay point.";
    } else if (this.data?.partial_history) {
      note = "No usage sample was found within the read limit.";
    }
    const percent = usage?.window ? (usage.input / usage.window) * 100 : null;
    const barColor = this.usageBarColor(usage);
    const color = percent !== null && percent >= 75 ? barColor : t.accent;
    return v_flex()
      .gap(6)
      .child(
        h_flex()
          .justify_between()
          .items_end()
          .gap(8)
          .child(
            div()
              .text_color(t.muted)
              .text_size(11)
              .child(
                usage?.label ??
                  (this.replayCutoff === null ? "LAST REPORTED INPUT" : "REPORTED BY THIS POINT"),
              ),
          )
          .child(
            div()
              .text_size(22)
              .font_semibold()
              .text_color(color)
              .child(usage ? formatCount(usage.input) : "—"),
          ),
      )
      .child(
        h_flex()
          .justify_between()
          .gap(8)
          .text_size(11)
          .text_color(t.dim)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .tooltip(this.data?.model || "")
              .child(this.data?.model || "Model not recorded"),
          )
          .child(
            div()
              .flex_none()
              .child(
                usage?.window
                  ? `${formatCount(usage.window)} window · ${percent.toFixed(1)}%`
                  : "Window size not recorded",
              ),
          ),
      )
      .child(
        div()
          .h(5)
          .w_full()
          .rounded(2)
          .bg(t.border)
          .when(percent !== null, (el) =>
            el.child(
              div()
                .h_full()
                .rounded(2)
                .w(`${Math.min(100, Math.max(0, percent))}%`)
                .relative()
                .bg(barColor + "52")
                .child(this.breathingFill("reported", barColor, 477))
                .child(this.dataFlash.layer("reported", "fill")),
            ),
          ),
      )
      .child(
        div()
          .text_size(10)
          .text_color(t.dim)
          .child(note),
      );
  }

  breakdown({ counts, sum }) {
    const t = theme();
    const image =
      this.replayCutoff === null && !this.showWholeHistory ? this.afterimage.current : null;
    const active = categories.filter((c) => counts[c.id]);
    const chip = (c) =>
      this.button(
        `category-${c.id}`,
        `${c.label}  ~${formatCount(counts[c.id])}`,
        () => {
          this.selectedCategory = this.selectedCategory === c.id ? null : c.id;
        },
        this.selectedCategory === c.id,
      );
    const legend =
      this.width < 400
        ? v_flex()
            .gap(2)
            .children(
              Array.from({ length: Math.ceil(active.length / 2) }, (_, i) =>
                h_flex()
                  .gap(3)
                  .children(
                    active
                      .slice(i * 2, i * 2 + 2)
                      .map((c) => chip(c).flex_1().min_w(0).px(3).py(3).text_size(9).truncate()),
                  ),
              ),
            )
        : h_flex().gap(5).flex_wrap().children(active.map(chip));
    return v_flex()
      .gap(8)
      .child(
        (this.width < 400 ? v_flex().gap(3) : h_flex().justify_between().gap(8))
          .text_size(11)
          .child(div().text_color(t.muted).child("CAPTURED TEXT · ESTIMATED"))
          .child(
            div()
              .text_color(t.foreground)
              .child(
                image
                  ? `~${formatCount(image.before)} → ~${formatCount(image.after)} tokens`
                  : `~${formatCount(sum)} tokens`,
              ),
          ),
      )
      .child(
        div()
          .id("context-category-bar")
          .relative()
          .h(18)
          .w_full()
          .rounded(3)
          .overflow_hidden()
          .bg(t.surface)
          .on_size_change(({ width }, cx) => {
            if (this.categoryBarWidth === width) return;
            this.categoryBarWidth = width;
            if (this.afterimage.current) cx.notify();
          })
          .child(
            h_flex().size_full().children(
              active.map((c) =>
                div()
                  .id(`bar-${c.id}`)
                  .h_full()
                  .w(`${(counts[c.id] / sum) * 100}%`)
                  .flex_none()
                  .relative()
                  .bg(c.color + "52")
                  .child(
                    this.breathingFill(c.id, c.color, Math.round(403 + categories.indexOf(c) * 46.6)),
                  )
                  .child(this.dataFlash.layer(c.id, "fill"))
                  .cursor_pointer()
                  .tooltip(`${c.label}: ~${formatCount(counts[c.id])} estimated tokens`)
                  .on_click((_e, cx) => {
                    this.selectedCategory = this.selectedCategory === c.id ? null : c.id;
                    cx.notify();
                  }),
              ),
            ),
          )
          .when(Boolean(image), (el) => el.child(afterimageLayer(image, this.categoryBarWidth, t))),
      )
      .child(legend)
      .when(Boolean(this.selectedCategory), (el) =>
        el.child(
          this.button("context-reset-filter", "Show all categories", () => {
            this.selectedCategory = null;
          }),
        ),
      );
  }

  pickerView(cx) {
    const t = theme(),
      choices = this.data?.candidates ?? [];
    return v_flex()
      .gap(8)
      .p(10)
      .bg(t.surface)
      .rounded(4)
      .child(
        div()
          .text_size(11)
          .text_color(t.muted)
          .child(this.data?.reason || "Select a recorded session for this terminal."),
      )
      .child(
        this.button("context-follow", "Follow focused session automatically", (cx) => {
          const target = this.selectedTarget();
          if (target) this.manual.delete(sessionKey(target));
          this.picker = false;
          this.refresh(cx, true);
        }),
      )
      .child(
        v_flex()
          .id("context-sessions")
          .max_h(260)
          .overflow_y_scrollbar()
          .gap(4)
          .children(
            choices.map((candidate, i) =>
              v_flex()
                .id(`session-${i}`)
                .p(6)
                .rounded(3)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  const target = this.selectedTarget();
                  if (target) this.manual.set(sessionKey(target), candidate.path);
                  this.picker = false;
                  this.refresh(cx, true);
                  cx.notify();
                })
                .child(
                  div().text_size(12).truncate().text_color(t.foreground).child(candidate.name),
                )
                .child(
                  div()
                    .text_size(10)
                    .truncate()
                    .text_color(t.dim)
                    .child(
                      `${candidate.cwd || candidate.id} · ${new Date(candidate.updated * 1000).toLocaleDateString()}`,
                    ),
                ),
            ),
          ),
      )
      .when(!choices.length, (el) =>
        el.child(div().text_size(12).text_color(t.dim).child("No local session files found.")),
      );
  }

  timelineView(entries) {
    const t = theme();
    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(100)
      .gap(6)
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(
            this.button(
              "context-timeline",
              "Timeline",
              () => {
                this.timelineOrder = "timeline";
              },
              this.timelineOrder === "timeline",
            ),
          )
          .child(
            this.button(
              "context-largest",
              "Largest",
              () => {
                this.timelineOrder = "largest";
              },
              this.timelineOrder === "largest",
            ),
          )
          .child(div().flex_1())
          .child(div().text_size(10).text_color(t.dim).child(`${entries.length} entries`)),
      )
      .child(
        div()
          .relative()
          .w_full()
          .child(this.inputGlow.layer())
          .child(Input.new(this.search).w_full().text_size(12)),
      )
      .child(
        v_flex()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            uniform_list(
              "context-events",
              entries.length,
              (i) => entries[i].id,
              (range) => {
                const rows = [];
                for (let i = range.start; i < range.end; i++) {
                  const event = entries[i],
                    category = categoryOf(event.category),
                    selected = this.pinned === event.id;
                  rows.push(
                    v_flex()
                      .id(`event-${event.id}`)
                      .h(63)
                      .px(8)
                      .py(7)
                      .gap(4)
                      .rounded(3)
                      .cursor_pointer()
                      .bg(selected ? t.selected : t.background)
                      .hover((s) => s.bg(t.hover))
                      .child(
                        h_flex()
                          .gap(6)
                          .items_center()
                          .child(div().w(5).h(5).rounded(3).bg(category.color).flex_none())
                          .child(
                            div()
                              .text_size(12)
                              .text_color(t.foreground)
                              .flex_1()
                              .min_w(0)
                              .truncate()
                              .child(event.label),
                          )
                          .child(
                            div()
                              .text_size(11)
                              .text_color(category.color)
                              .flex_none()
                              .child(`~${formatCount(event.tokens)}`),
                          ),
                      )
                      .child(
                        div()
                          .pl(11)
                          .text_size(10)
                          .text_color(t.dim)
                          .truncate()
                          .child(
                            `${category.label} · ${event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : "Recorded"} · ${event.teaser.replace(/\s+/g, " ")}`,
                          ),
                      ),
                  );
                }
                return rows;
              },
            )
              .size_full()
              .on_item_click((key, cx) => {
                const event = entries.find((e) => e.id === key);
                if (event) this.inspect(event, cx);
              }),
          )
          .child(Scrollbar.vertical("context-events").absolute().inset_0()),
      )
      .when(!entries.length, (el) =>
        el.child(
          div().p(10).text_size(12).text_color(t.dim).child("No events match these filters."),
        ),
      );
  }

  preview(cx) {
    const t = theme();
    const event = this.pinned === null
      ? undefined
      : this.data?.events?.find((event) => event.id === this.pinned);

    let sourcePosition = "";
    if (event?.offset != null) sourcePosition = ` · byte ${event.offset}`;
    else if (event?.line != null) sourcePosition = `:${event.line}`;

    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(140)
      .overflow_hidden()
      .bg(t.surface)
      .rounded(4)
      .p(10)
      .gap(8)
      .when(!event, (el) =>
        el.child(
          div()
            .p(10)
            .text_size(12)
            .text_color(t.muted)
            .child(
              "Click an event to inspect its preview. Choose Largest to find the biggest recorded contributions.",
            ),
        ),
      )
      .when(Boolean(event), (el) =>
        el
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(12)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child(event.label),
              )
              .when(Boolean(this.pinned), (e) =>
                e.child(
                  this.button("context-unpin", "Unpin", () => {
                    this.pinned = null;
                  }),
                ),
              ),
          )
          .child(
            div()
              .text_size(11)
              .text_color(categoryOf(event.category).color)
              .child(
                `${categoryOf(event.category).label} · ~${formatCount(event.tokens)} tokens · ${formatCount(event.bytes)} bytes`,
              ),
          )
          .child(
            div()
              .text_size(10)
              .text_color(t.dim)
              .truncate()
              .tooltip(`${event.source}${sourcePosition}`)
              .child(`${event.source.split("/").pop()}${sourcePosition}`),
          )
          .child(
            this.button("context-replay-event", "Replay through this event", () => {
              this.afterimage.clear();
              this.replayCutoff = Number(event.id);
            }),
          )
          .child(
            this.code
              ? Editor.new(this.code).flex_1().min_h(0)
              : div()
                  .text_size(12)
                  .text_color(t.muted)
                  .child(this.details || "Loading preview…"),
          ),
      );
  }

  render(cx) {
    const t = theme(),
      target = this.target();
    const next = this.targetIdentity(target);
    const visible = this.visible();
    if (!visible) this.afterimage.clear();
    if (next !== this.identity && visible) this.refresh(cx);
    const shownTarget = visible ? (target?.address ?? "") : null;
    // A hidden stack child might not render until it is selected again.
    const opened = props()?.overlay ? null : shared("vectron.context-open");
    const justOpened = opened && opened.at !== this.lastPanelOpen && Date.now() - opened.at < 750;
    if (shownTarget !== null && (shownTarget !== this.shownTarget || justOpened)) {
      this.lastPanelFlashColor = justOpened
        ? opened.color
        : flashColor(this.lastPanelFlashColor, t);
      this.panelFlash.start(cx, new Map([["context-panel", this.lastPanelFlashColor]]), {
        alreadyRendering: true,
      });
    }
    this.lastPanelOpen = opened?.at;
    this.shownTarget = shownTarget;
    const { events, totals } = this.contextEvents.capture(
      this.data,
      this.replayCutoff,
      this.showWholeHistory,
    );
    const entries = this.contextEvents.timeline(
      events,
      this.selectedCategory,
      this.searchQuery,
      this.timelineOrder,
    );
    const usage = reportedUsageAt(this.data, this.replayCutoff);
    const wide = this.width > 720;
    const body = (wide ? h_flex().gap(12) : v_flex().gap(10)).items_stretch();
    return v_flex()
      .id("context-root")
      .size_full()
      .min_h(0)
      .relative()
      .bg(t.background)
      .text_color(t.foreground)
      .p(12)
      .gap(12)
      .child(this.panelFlash.layer("context-panel", "frame"))
      .on_size_change((size, cx) => {
        if (this.width !== size.width) {
          this.width = size.width;
          cx.notify();
        }
      })
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(svg(`mods/${MOD}/context.svg`).size(15).text_color(t.muted))
          .child(div().text_size(14).font_semibold().child("Context"))
          .child(
            div()
              .text_size(9)
              .px(5)
              .py(2)
              .rounded(2)
              .bg(t.surface)
              .text_color(this.replayCutoff === null ? t.ansi6 : t.accent)
              .child(this.replayCutoff === null ? "LIVE" : "REPLAY"),
          )
          .child(div().flex_1())
          .child(
            this.button("context-refresh", this.pendingRead ? "Reading…" : "Refresh", (cx) =>
              this.refresh(cx, true),
            ),
          )
          .child(
            this.button("context-expand", props()?.overlay ? "Close" : "Expand", () =>
              props()?.overlay ? closeOverlay(props().overlay) : this.expand(),
            ),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11)
              .text_color(t.muted)
              .tooltip(target?.title || "")
              .child(target?.title || "Focus an agent session"),
          )
          .child(
            this.button("context-session", "Session", () => {
              this.picker = !this.picker;
            }),
          ),
      )
      .when(Boolean(target), (el) =>
        el.child(
          div()
            .text_size(10)
            .text_color(t.dim)
            .child(
              `Following ${providerNames[target.provider] ?? target.provider} · ${target.address}`,
            ),
        ),
      )
      .when(Boolean(this.error), (el) =>
        el.child(div().text_size(12).text_color(t.blocked).child(this.error)),
      )
      .when(Boolean(this.data?.reason) || this.picker, (el) => el.child(this.pickerView(cx)))
      .when(!this.data?.path && !this.data?.reason && !this.error, (el) =>
        el.child(
          div()
            .p(12)
            .text_size(12)
            .text_color(t.muted)
            .child(
              this.pendingRead
                ? "Reading the local session…"
                : "Select a Codex, Claude Code, Grok Build or Antigravity CLI terminal to inspect its recorded context contributions.",
            ),
        ),
      )
      .when(Boolean(this.data?.path), (el) =>
        el
          .child(this.gauge(usage))
          .child(this.breakdown(totals))
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .flex_wrap()
              .child(
                this.button(
                  "context-segment",
                  "Since compact",
                  () => {
                    this.showWholeHistory = false;
                  },
                  !this.showWholeHistory,
                ),
              )
              .child(
                this.button(
                  "context-history",
                  "Whole history",
                  () => {
                    this.afterimage.clear();
                    this.showWholeHistory = true;
                  },
                  this.showWholeHistory,
                ),
              )
              .child(div().flex_1())
              .when(this.replayCutoff !== null, (e) =>
                e.child(
                  this.button("context-live", "Back to live", () => {
                    this.replayCutoff = null;
                  }),
                ),
              ),
          )
          .child(
            body
              .flex_1()
              .min_w(0)
              .min_h(0)
              .overflow_hidden()
              .child(this.timelineView(entries).when(wide, (e) => e.h_full()))
              .child(this.preview(cx).when(wide, (e) => e.h_full())),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                this.button(
                  "context-about",
                  this.about ? "Hide count details" : "About these counts",
                  () => {
                    this.about = !this.about;
                  },
                ),
              )
              .child(div().flex_1())
              .child(div().text_size(9).text_color(t.dim).child("Local · read-only · 5s")),
          )
          .when(this.about, (e) =>
            e.child(
              v_flex()
                .id("context-notes")
                .max_h(145)
                .overflow_y_scrollbar()
                .gap(5)
                .children(
                  [
                    this.data.method,
                    "The category bar describes recorded text, not an exact live prompt. Compaction and unrecorded runtime data can make the reported total different.",
                    `Matched: ${this.data.match}. ${this.data.files} history file(s).`,
                    ...(this.data.notes || []),
                  ].map((note) => div().text_size(10).text_color(t.dim).child(note)),
                ),
            ),
          ),
      );
  }
}
