import { div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { exec, openOverlay, panes, run, spaces, theme } from "herdr";
import { dismiss, menuRow } from "./controls.js";

async function checkout(space, folder) {
  const git = (args) => exec("git", args, { cwd: folder, on: space.machine });
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0) return null;

  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

export class SpaceMenu {
  constructor(id, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.space = spaces().find((space) => space.id === id);
    this.at = 0;
    this.git = null;

    if (!this.space) return;
    const tabs = new Set(this.space.tabs?.map((tab) => tab.id));
    const folder = panes().find((pane) => tabs.has(pane.tab) && pane.cwd)?.cwd || this.space.folder;
    if (folder) {
      cx.spawn(async (cx) => {
        this.git = await checkout(this.space, folder).catch(() => null);
        cx.notify();
      });
    }
  }

  rename() {
    dismiss();
    openOverlay({
      mod: "vectron-dialogs",
      kind: "dialog",
      width: 380,
      height: 190,
      props: { id: this.space.id },
    });
  }

  worktree(action) {
    dismiss();
    const opening = action === "open";
    openOverlay({
      mod: "worktree",
      kind: "dialog",
      width: opening ? 560 : 440,
      height: opening ? 480 : 260,
      props: { space: this.space.id, action },
    });
  }

  render() {
    const t = theme();
    const items = this.space
      ? [
          ["rename-space", "square-pen", "Rename", () => this.rename()],
          ...(this.git
            ? [
                ["new-space-worktree", "git-branch", "New worktree", () => this.worktree("new")],
                ["open-space-worktree", "git-branch", "Open worktree", () => this.worktree("open")],
              ]
            : []),
          ...(this.git === "linked"
            ? [["remove-space-worktree", "git-branch", "Remove worktree", () => this.worktree("remove")]]
            : []),
          ["close-space", "x", "Close", () => {
            dismiss();
            run("space.close", { id: this.space.id });
          }],
        ]
      : [];

    return v_flex()
      .id("space-menu")
      .track_focus(this.handle)
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((event, cx) => {
        if (event.key === "escape") dismiss();
        else if (!items.length) return;
        else if (event.key === "down") this.at = (this.at + 1) % items.length;
        else if (event.key === "up") this.at = (this.at + items.length - 1) % items.length;
        else if (event.key === "enter") items[this.at][3]();
        else return;

        cx.stop_propagation();
        cx.notify();
      })
      .when(!items.length, (el) =>
        el.child(div().px(9).py(6).text_color(t.dim).child("This space is unavailable.")),
      )
      .children(items.map(([id, icon, label, choose], index) =>
        menuRow(t, id, svg(`mods/workspace-chrome/${icon}.svg`).size(14), label, choose, {
          selected: index === this.at,
        }),
      ));
  }
}
