import { describe, it, expect } from "vitest";
import { DEFAULT_TOOL_ORDER, itemById, moveItem, reconcileOrder, TOOLBAR_ITEMS } from "../src/ui/toolbarItems";

describe("the toolbar registry", () => {
  it("has no duplicate ids", () => {
    expect(new Set(DEFAULT_TOOL_ORDER).size).toBe(DEFAULT_TOOL_ORDER.length);
  });
  it("gives every item a label, and every non-divider an icon", () => {
    for (const i of TOOLBAR_ITEMS) {
      expect(i.label, i.id).toBeTruthy();
      if (i.kind !== "divider") expect(i.icon, i.id).toBeTruthy();
    }
  });
});

describe("reconcileOrder", () => {
  it("leaves a current arrangement alone", () => {
    const custom = [...DEFAULT_TOOL_ORDER].reverse();
    expect(reconcileOrder(custom)).toEqual(custom);
  });

  it("drops an id this build no longer has", () => {
    const stored = ["tool:move", "tool:fromTheFuture", "tool:pan"];
    expect(reconcileOrder(stored, ["tool:move", "tool:pan"])).toEqual(["tool:move", "tool:pan"]);
  });

  it("appends a tool added since the arrangement was saved, rather than losing it", () => {
    // Shipping a new tool must never leave it unreachable for people who customised.
    const stored = ["tool:pan", "tool:move"];
    expect(reconcileOrder(stored, ["tool:move", "tool:pan", "tool:brandNew"]))
      .toEqual(["tool:pan", "tool:move", "tool:brandNew"]);
  });

  it("de-duplicates a corrupted order", () => {
    expect(reconcileOrder(["a", "a", "b"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("falls back to everything when there is nothing stored", () => {
    expect(reconcileOrder(undefined)).toEqual(DEFAULT_TOOL_ORDER);
    expect(reconcileOrder([])).toEqual(DEFAULT_TOOL_ORDER);
  });
});

describe("moveItem", () => {
  const order = ["a", "b", "c", "d"];
  it("moves an item later", () => {
    expect(moveItem(order, "a", "c")).toEqual(["b", "c", "a", "d"]);
  });
  it("moves an item earlier", () => {
    expect(moveItem(order, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });
  it("never loses or duplicates anything", () => {
    const moved = moveItem(order, "b", "d");
    expect([...moved].sort()).toEqual([...order].sort());
  });
  it("is a no-op for an unknown id or a drop on itself", () => {
    expect(moveItem(order, "a", "a")).toEqual(order);
    expect(moveItem(order, "zz", "b")).toEqual(order);
  });
});

describe("itemById", () => {
  it("finds a real item and nothing else", () => {
    expect(itemById("tool:brush")?.kind).toBe("tool");
    expect(itemById("nope")).toBeUndefined();
  });
});

// The extras are the whole reason a tool feels like it responded to the click: without
// them, selecting the brush changes nothing visible. They were written once and never
// rendered, which is how the size slider disappeared.
describe("tool extras", () => {
  it("names an owner for every control that used to live in the bar", () => {
    const owners = ["tool:brush", "tool:wand", "tool:erase-layer", "tool:remove"];
    for (const id of owners) expect(DEFAULT_TOOL_ORDER).toContain(id);
    // The note palette follows the selected shape, so hiding one shape cannot take it away.
    const shapes = DEFAULT_TOOL_ORDER.filter((id) => id.startsWith("note:"));
    expect(shapes).toEqual(["note:brush", "note:text", "note:arrow", "note:rect", "note:pin"]);
  });

  it("has no group headings left to click through", () => {
    // Every non-divider item is a control you press once; dividers are rules, not headers.
    const clickable = TOOLBAR_ITEMS.filter((i) => i.kind !== "divider");
    expect(clickable.length).toBeGreaterThan(10);
    expect(TOOLBAR_ITEMS.filter((i) => i.kind === "divider").every((d) => !d.icon)).toBe(true);
  });
});
