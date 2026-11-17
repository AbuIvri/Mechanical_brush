import { describe, it, expect } from "vitest";
import { DOC_KEYS, docTitle, extractSlice, newDocId, type DocSlice } from "../src/state/docs";

const slice = (over: Partial<DocSlice> = {}): DocSlice =>
  ({
    project: null, filePath: null, dirty: false, activeLayerId: null,
    zoom: 1, panX: 0, panY: 0, selectedLayerIds: [], hoveredLayerId: null,
    mosaic: false, compare: false,
    mask: { strokes: [], rects: [], bitmaps: [], inverted: false },
    thumbnails: {}, mode: "generate", prompt: "", references: [], settings: {},
    promptHistory: [], past: [], future: [], busy: false, genStartedAt: null, unseen: false,
    ...over,
  }) as DocSlice;

describe("extractSlice", () => {
  it("takes every document key and nothing else", () => {
    const state = { ...slice({ prompt: "hello" }), totalSpend: 9, providers: [], tool: "brush" };
    const out = extractSlice(state as never) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual([...DOC_KEYS].sort());
    expect(out.prompt).toBe("hello");
    // Spend and tool belong to the app, not to a document — they must not travel.
    expect(out).not.toHaveProperty("totalSpend");
    expect(out).not.toHaveProperty("tool");
  });

  it("round-trips a document unchanged", () => {
    const original = slice({ prompt: "x", zoom: 2.5, dirty: true, promptHistory: ["a", "b"] });
    const restored = extractSlice({ ...original, totalSpend: 1 } as never);
    expect(restored).toEqual(original);
  });
});

// The property the whole feature rests on: a result must land in the document that
// started the run, even when that document is no longer on screen. This mirrors
// commitToDoc's split, which the store applies to the real state.
describe("the commit split", () => {
  const isDocKey = (k: string) => (DOC_KEYS as readonly string[]).includes(k);

  it("separates document fields from app-wide ones", () => {
    const patch = { project: { name: "p" }, busy: false, totalSpend: 3, status: "done" };
    const doc = Object.fromEntries(Object.entries(patch).filter(([k]) => isDocKey(k)));
    const global = Object.fromEntries(Object.entries(patch).filter(([k]) => !isDocKey(k)));
    expect(Object.keys(doc).sort()).toEqual(["busy", "project"]);
    // Spend still applies now — it is the user's, not the document's — and the status
    // bar of a tab you are not looking at must not hijack the visible one.
    expect(Object.keys(global).sort()).toEqual(["status", "totalSpend"]);
  });

  it("leaves the other documents untouched", () => {
    const docs = [
      { id: "a", slice: slice({ prompt: "A" }) },
      { id: "b", slice: slice({ prompt: "B" }) },
    ];
    const next = docs.map((d) => (d.id === "a" ? { id: d.id, slice: { ...d.slice, busy: false, unseen: true } } : d));
    expect(next[0].slice.unseen).toBe(true);
    expect(next[1].slice).toBe(docs[1].slice); // same object: genuinely untouched
    expect(next[1].slice.prompt).toBe("B");
  });
});

describe("docTitle", () => {
  it("prefers the project's name", () => {
    expect(docTitle(slice({ project: { name: "דף דמות" } as never }), 0)).toBe("דף דמות");
  });
  it("falls back to the file name, then to a number", () => {
    expect(docTitle(slice({ filePath: "/a/b/מוצר.mbrush" }), 0)).toBe("מוצר.mbrush");
    expect(docTitle(slice(), 2)).toBe("פרויקט 3");
  });
  it("ignores a project named only whitespace", () => {
    expect(docTitle(slice({ project: { name: "   " } as never }), 0)).toBe("פרויקט 1");
  });
});

describe("newDocId", () => {
  it("does not collide", () => {
    expect(new Set(Array.from({ length: 200 }, newDocId)).size).toBe(200);
  });
});
