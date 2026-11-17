import { describe, expect, it } from "vitest";
import { unsavedDocNames, type DocSlice, type OpenDoc } from "../src/state/docs";

const slice = (name: string | null, dirty: boolean): DocSlice =>
  ({ project: name ? { name } : null, filePath: null, dirty }) as unknown as DocSlice;

describe("unsavedDocNames", () => {
  it("counts parked tabs from their slices and the active tab from the live state", () => {
    const docs: OpenDoc[] = [
      { id: "a", slice: slice("stale placeholder", false) }, // active: its slice is not the truth
      { id: "b", slice: slice("parked-dirty", true) },
      { id: "c", slice: slice("parked-clean", false) },
    ];
    expect(unsavedDocNames(docs, "a", slice("live", true))).toEqual(["live", "parked-dirty"]);
    expect(unsavedDocNames(docs, "a", slice("live", false))).toEqual(["parked-dirty"]);
  });

  it("an empty tab is never unsaved work, even if flagged dirty", () => {
    const docs: OpenDoc[] = [{ id: "a", slice: slice(null, true) }, { id: "b", slice: slice(null, true) }];
    expect(unsavedDocNames(docs, "a", slice(null, true))).toEqual([]);
  });

  it("before any tab is registered the store itself is the document", () => {
    expect(unsavedDocNames([], "", slice("first", true))).toEqual(["first"]);
    expect(unsavedDocNames([], "", slice("first", false))).toEqual([]);
  });
});
