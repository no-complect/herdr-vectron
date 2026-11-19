import assert from "node:assert/strict";
import test from "node:test";
import { layoutVisibility } from "../vectron-context/visibility.js";

const mod = "vectron-context";
const inspector = { id: "my-context", type: "block", content: { mod } };

function layout(active = "my-context") {
  return {
    id: "anything",
    type: "row",
    children: [
      {
        id: "custom-sidebar",
        type: "stack",
        active,
        children: [inspector, { id: "notes" }],
      },
    ],
  };
}

test("arbitrary layout IDs work and inactive stack children do not poll", () => {
  assert.equal(layoutVisibility(layout(), mod), true);
  assert.equal(layoutVisibility(layout("notes"), mod), false);
});

test("hidden ancestors take precedence over a selected child", () => {
  assert.equal(layoutVisibility({ ...layout(), hidden: true }, mod), false);
});

test("a named block distinguishes multiple copies", () => {
  const root = layout();
  root.children.push({ id: "second-copy", content: { mod }, hidden: true });
  assert.equal(layoutVisibility(root, mod), true);
  assert.equal(layoutVisibility(root, mod, "second-copy"), false);
});

test("pane and overlay mounts do not require layout nodes", () => {
  assert.equal(layoutVisibility({ children: [] }, mod), null);
});
