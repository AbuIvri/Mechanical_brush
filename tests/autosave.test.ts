import { describe, expect, it } from "vitest";
import { autosaveDocs, pendingAutosaves, type DocSlice, type OpenDoc } from "../src/state/docs";
import { isSlotId, sortSlots, LEGACY_SLOT } from "../shared/autosaveSlots";

const slice = (project: object | null, dirty: boolean, filePath: string | null = null): DocSlice =>
  ({ project, filePath, dirty }) as unknown as DocSlice;

describe("autosaveDocs", () => {
  it("covers every open document, the active one from the live state", () => {
    const pa = { name: "a-live" }, pb = { name: "b" }, pc = { name: "c" };
    const docs: OpenDoc[] = [
      { id: "a", slice: slice({ name: "a-stale" }, false) },
      { id: "b", slice: slice(pb, true, "/x/b.mbrush") },
      { id: "c", slice: slice(pc, false) },
    ];
    expect(autosaveDocs(docs, "a", slice(pa, true))).toEqual([
      { id: "a", project: pa, filePath: null, dirty: true },
      { id: "b", project: pb, filePath: "/x/b.mbrush", dirty: true },
      { id: "c", project: pc, filePath: null, dirty: false },
    ]);
  });

  it("before any tab is registered, the store is the one document", () => {
    const p = { name: "only" };
    expect(autosaveDocs([], "a", slice(p, true))).toEqual([{ id: "a", project: p, filePath: null, dirty: true }]);
    expect(autosaveDocs([], "", slice(p, true))).toEqual([]);
  });
});

describe("pendingAutosaves", () => {
  const p1 = { v: 1 }, p2 = { v: 2 };
  const doc = (id: string, project: object | null, dirty: boolean) => ({ id, project: project as never, filePath: null, dirty });

  it("writes unsaved work that has not been written yet", () => {
    expect(pendingAutosaves([doc("a", p1, true)], new Map()).map((d) => d.id)).toEqual(["a"]);
  });

  it("skips a document whose current project is the one already written", () => {
    expect(pendingAutosaves([doc("a", p1, true)], new Map([["a", p1]]))).toEqual([]);
    expect(pendingAutosaves([doc("a", p2, true)], new Map([["a", p1]])).map((d) => d.id)).toEqual(["a"]);
  });

  it("never writes a saved document or an empty tab", () => {
    expect(pendingAutosaves([doc("a", p1, false), doc("b", null, true)], new Map())).toEqual([]);
  });

  it("a parked tab that changed is written even while another tab is in front", () => {
    const written = new Map<string, unknown>([["front", p1], ["parked", p1]]);
    expect(pendingAutosaves([doc("front", p1, true), doc("parked", p2, true)], written).map((d) => d.id)).toEqual(["parked"]);
  });
});

describe("recovery slots", () => {
  it("accepts the ids the app generates and the legacy name", () => {
    expect(isSlotId("dmb3k2x9a1")).toBe(true);
    expect(isSlotId(LEGACY_SLOT)).toBe(true);
  });

  it("refuses anything that could leave the autosave folder", () => {
    for (const bad of ["../x", "a/b", "a\\b", "a.b", "", " ", "x".repeat(65), null, 7]) expect(isSlotId(bad)).toBe(false);
  });

  it("offers the newest first", () => {
    const s = (id: string, savedAt: number) => ({ id, name: id, originalPath: null, savedAt });
    expect(sortSlots([s("old", 1), s("new", 3), s("mid", 2)]).map((x) => x.id)).toEqual(["new", "mid", "old"]);
  });
});

import { keepDiscardedSlots, discardedName, discardedToPrune } from "../shared/autosaveSlots";

describe("discarded work — kept on development builds only", () => {
  it("dev keeps it, a release does not unless asked", () => {
    expect(keepDiscardedSlots(false, {})).toBe(true);
    expect(keepDiscardedSlots(true, {})).toBe(false);
    expect(keepDiscardedSlots(true, { MBRUSH_KEEP_DISCARDED: "1" })).toBe(true);
  });

  it("names sort by when the work was discarded", () => {
    const a = discardedName("dmwkj85p06w0c", new Date("2026-11-17T10:42:00Z"), "mbrush");
    const b = discardedName("aaa", new Date("2026-11-17T11:00:00Z"), "mbrush");
    expect(a).toBe("2026-11-17T10-42-00-000Z_dmwkj85p06w0c.mbrush");
    expect([b, a].sort()).toEqual([a, b]);
  });

  it("prunes the oldest projects, a project's two files together", () => {
    const names = [1, 2, 3, 4].flatMap((d) => [`2026-11-0${d}T00-00-00-000Z_x.mbrush`, `2026-11-0${d}T00-00-00-000Z_x.json`]);
    expect(discardedToPrune([...names, ".DS_Store"], 2).sort()).toEqual(names.slice(0, 4).sort());
    expect(discardedToPrune(names, 10)).toEqual([]);
  });
});
