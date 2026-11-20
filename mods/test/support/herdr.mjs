import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

export class Element {
  constructor(kind) {
    this.kind = kind;
    this.nodes = [];
    this.calls = {};
    return new Proxy(this, {
      get(object, key, receiver) {
        if (key === "then") return undefined;
        if (Reflect.has(object, key)) return Reflect.get(object, key, receiver);

        return (...args) => {
          object.calls[key] = args;
          return receiver;
        };
      },
    });
  }

  child(value) {
    this.nodes.push(value);
    return this;
  }

  children(values) {
    this.nodes.push(...values);
    return this;
  }

  when(condition, transform) {
    return condition ? transform(this) : this;
  }
}

const element =
  (kind) =>
  (...args) => {
    const view = new Element(kind);
    view.args = args;
    return view;
  };

export function find(node, predicate) {
  if (!(node instanceof Element)) return undefined;
  if (predicate(node)) return node;

  for (const child of node.nodes) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

// Load the actual native modules with a small host stub. Like Herdr, a mod
// can import its own files and host modules, but not another mod's source.
export async function loadMod(mod, file = "main.js", overrides = {}, globals = {}) {
  const root = new URL(`../../${mod}/`, import.meta.url);
  const realm = createContext(globals);
  const builtins = {
    herdr: overrides.herdr ?? {},
    "gpui-kit": {
      View: class {},
      div: element("div"),
      svg: element("svg"),
      image: element("image"),
      uniform_list: element("uniform_list"),
      ...overrides["gpui-kit"],
    },
    "gpui-base": {
      h_flex: element("h_flex"),
      v_flex: element("v_flex"),
      InputState: { new: () => ({ on() {} }) },
      Input: { new: element("input") },
      EditorState: { new: (options) => ({ options, release() {} }) },
      Editor: { new: element("editor") },
      Scrollbar: { vertical: element("scrollbar") },
      ScrollHandle: { new: () => ({ scroll_to_item() {}, release() {} }) },
      VirtualListScrollHandle: { new: () => ({ scroll_to_item() {}, release() {} }) },
      ...overrides["gpui-base"],
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([name]) => !["herdr", "gpui-kit", "gpui-base"].includes(name),
      ),
    ),
  };
  const modules = new Map();

  function load(identifier) {
    if (!modules.has(identifier)) {
      modules.set(identifier, compile(identifier));
    }
    return modules.get(identifier);
  }

  async function compile(identifier) {
    if (Object.hasOwn(builtins, identifier)) {
      const values = builtins[identifier];
      return new SyntheticModule(
        Object.keys(values),
        function () {
          for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        },
        { context: realm, identifier },
      );
    }
    if (!identifier.startsWith(root.href)) {
      throw new Error(`Import outside mod: ${identifier}`);
    }
    return new SourceTextModule(await readFile(new URL(identifier), "utf8"), {
      context: realm,
      identifier,
    });
  }

  const entry = await load(new URL(file, root).href);
  await entry.link((specifier, parent) =>
    load(
      Object.hasOwn(builtins, specifier) ? specifier : new URL(specifier, parent.identifier).href,
    ),
  );
  await entry.evaluate();
  return entry.namespace;
}
