import { View, div } from "gpui-kit";
import { Editor, EditorState, TextView, h_flex, v_flex } from "gpui-base";
import { checking, exec, focused, notify, panes, readTextFile, spaces, theme } from "herdr";
import { absolutePath, discoverDocuments, skillInvocation } from "./documents.js";

const skills = [
  ["brainstorm", "Brainstorm", "Turn an idea into a concepts brief"],
  ["draft", "Draft", "Develop a brief into a design document"],
  ["review", "Review", "Ask Goldfish reviewers to check a design"],
  ["resolve", "Resolve", "Work through review findings"],
  ["review-loop", "Review loop", "Iterate on a document with reviewers"],
  ["lite", "Lite", "Plan and review a small change"],
  ["drift-report", "Drift report", "Compare design docs with the code"],
  ["bootstrap", "Bootstrap", "Create directory READMEs"],
];
const previewLimit = 80000;

function workspace() {
  const focus = focused();
  const space = spaces().find((s) => s.id === focus?.space || (!focus && s.active));
  const pane = panes().find((p) => p.pane === focus?.pane);
  const on = focus?.pane === null && focus.terminal
    ? focus.terminal.includes("/") ? focus.terminal.split("/")[0] : null
    : space?.machine ?? null;
  return { cwd: pane?.cwd || focus?.cwd || space?.folder || null, on };
}

function button(t, label, click, selected = false) {
  return div().flex_none().px(8).py(5).text_size(11).rounded(3)
    .bg(selected ? t.selected : t.background)
    .text_color(selected ? t.accent : t.foreground)
    .hover((s) => s.bg(t.hover)).cursor_pointer().on_click(click).child(label);
}

function message(t, text) {
  return div().p(10).text_size(12).text_color(t.muted).child(text);
}

export default class Egm extends View {
  init() {
    this.page = "documents";
    this.host = localStorage.getItem("skill-host") === "claude" ? "claude" : "codex";
    this.work = null;
    this.preview = null;
  }

  close() {
    this.clearPreview();
  }

  clearPreview() {
    this.preview?.editor?.release();
    this.preview = null;
    if (this.page === "preview") this.page = "documents";
  }

  refresh(location, cx) {
    const work = { key: JSON.stringify(location), on: location.on, result: null, message: null };
    this.work = work;
    this.clearPreview();
    if (!location.cwd) {
      work.message = "Focus a terminal to see its EGM documents.";
      return;
    }
    cx.spawn(async (cx) => {
      try {
        work.result = await discoverDocuments(exec, location);
        if (!work.result) work.message = "Open a Git worktree to browse EGM documents.";
      } catch {
        work.message = "Couldn’t list EGM documents. Check Git and the connection, then refresh.";
      }
      if (this.work === work) cx.notify();
    });
  }

  openDocument(document, cx) {
    const work = this.work;
    const preview = { document, editor: null, markdown: null, message: null };
    this.preview = preview;
    const path = absolutePath(work.result.root, document.path);
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(path, { on: work.on });
        if (this.preview !== preview) return;
        if (text === null || text.includes("\0")) {
          preview.message = "This document is unavailable as text.";
        } else {
          const value = text.length > previewLimit ? text.slice(0, previewLimit) + "\n… (preview truncated)" : text;
          preview.editor = EditorState.new({
            readonly: true,
            value,
            font_size: 12,
          });
          if (/\.(md|markdown)$/i.test(document.path)) preview.markdown = value;
        }
      } catch {
        preview.message = "Couldn’t read this document.";
      } finally {
        if (this.preview === preview) cx.notify();
      }
    });
  }

  documents(t, location, formatted) {
    const { result, message: status } = this.work;
    const preview = this.preview;
    if (preview) {
      return v_flex().flex_1().min_h(0)
        .child(h_flex().gap(6).p(8).items_center()
          .child(button(t, "Back", (_e, cx) => {
            this.clearPreview();
            cx.notify();
          }))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(preview.document.path))
          .child(button(t, "Copy path", (_e, cx) => {
            cx.write_to_clipboard(absolutePath(result.root, preview.document.path));
            notify({ title: "Document path copied" });
          })))
        .child(
          formatted
            ? div().flex_1().min_h(0).px(10).pb(8).text_size(12)
                .child(TextView.markdown(`egm-markdown:${preview.document.path}`, preview.markdown)
                  .scrollable(true).selectable(true).size_full())
            : preview.editor
              ? Editor.new(preview.editor).flex_1().min_h(0)
              : message(t, preview.message ?? "Loading document…"),
        );
    }

    const rows = (result?.documents ?? []).map((document) =>
      v_flex().gap(2).px(10).py(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(document.path)
        .on_click((_e, cx) => {
          this.openDocument(document, cx);
          cx.notify();
        })
        .child(div().truncate().text_size(12).child(document.path.split("/").at(-1)))
        .child(div().truncate().text_size(11).text_color(t.muted)
          .child(document.kind + " · " + document.path)));
    return v_flex().flex_1().min_h(0)
      .child(h_flex().gap(6).p(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
          .tooltip(result?.root ?? location.cwd ?? "No folder")
          .child(result?.root ?? location.cwd ?? "No folder"))
        .child(button(t, "Refresh", (_e, cx) => {
          this.refresh(workspace(), cx);
          cx.notify();
        })))
      .child(v_flex().id("egm-documents").flex_1().min_h(0).overflow_y_scrollbar()
        .when(!result?.documents.length, (el) => el.child(message(t, status ??
          (result ? "No EGM documents found. Start with Brainstorm in Skills." : "Scanning worktree…"))))
        .children(rows)
        .when(Boolean(result?.limited), (el) => el.child(message(t, "Showing the first 100 documents."))));
  }

  skillList(t) {
    const setHost = (host) => (_e, cx) => {
      this.host = host;
      localStorage.setItem("skill-host", host);
      cx.notify();
    };
    const { result } = this.work;
    const document = this.preview?.document;
    return v_flex().flex_1().min_h(0)
      .child(h_flex().gap(6).p(8)
        .child(button(t, "Codex", setHost("codex"), this.host === "codex"))
        .child(button(t, "Claude / Antigravity", setHost("claude"), this.host === "claude")))
      .child(v_flex().id("egm-skills").flex_1().min_h(0).overflow_y_scrollbar()
        .child(message(t, "Copy a skill invocation into an agent with the EGM plugin installed."))
        .when(Boolean(document), (el) => el.child(message(t, "Selected document · " + document.path)))
        .children(skills.map(([id, label, description]) => {
          const text = skillInvocation(id, this.host, result?.root, document);
          return h_flex().gap(8).px(10).py(6).items_center()
            .child(v_flex().flex_1().min_w(0)
              .child(div().text_size(12).child(label))
              .child(div().text_size(11).text_color(t.muted).child(description)))
            .child(button(t, "Copy", (_e, cx) => {
              cx.write_to_clipboard(text);
              notify({ title: `${label} invocation copied` });
            }).tooltip(text));
        })));
  }

  render(cx) {
    const t = theme();
    const location = checking() ? { cwd: null, on: null } : workspace();
    if (this.work?.key !== JSON.stringify(location)) this.refresh(location, cx);
    const show = (page) => (_e, cx) => {
      this.page = page;
      cx.notify();
    };
    return v_flex().size_full().min_w(0).min_h(0).bg(t.background).text_color(t.foreground)
      .child(div().px(10).pt(9).text_size(13).font_semibold().child("Elephant & Goldfish"))
      .child(h_flex().gap(6).p(8).bg(t.chrome)
        .child(button(t, "Documents", show("documents"), this.page === "documents"))
        .child(button(t, "Skills", show("skills"), this.page === "skills"))
        .when(this.preview?.markdown != null, (el) =>
          el.child(button(t, "Preview", show("preview"), this.page === "preview"))))
      .child(this.page === "skills" ? this.skillList(t) : this.documents(t, location, this.page === "preview"));
  }
}
