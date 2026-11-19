// Return null when the copy is outside the layout tree (for example, a pane).
export function layoutVisibility(root, mod, blockId) {
  let found = false,
    visible = false;
  function visit(node, parentVisible) {
    if (!node) return;
    const shown = parentVisible && node.hidden !== true;
    if (node.content?.mod === mod && (!blockId || node.id === blockId)) {
      found = true;
      visible ||= shown;
    }
    for (const child of node.children ?? []) {
      visit(child, shown && (node.type !== "stack" || !node.active || child.id === node.active));
    }
  }
  visit(root, true);
  return found ? visible : null;
}
