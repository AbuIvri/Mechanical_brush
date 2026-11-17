import { describe, expect, it } from "vitest";
import { debugDumpsEnabled, pickForPruning } from "../shared/debugPrune";

describe("debug dumps", () => {
  it("are on when running from source, off in a packaged build", () => {
    expect(debugDumpsEnabled(false, {})).toBe(true);
    expect(debugDumpsEnabled(true, {})).toBe(false);
  });

  it("can be asked for in a packaged build, by exact value only", () => {
    expect(debugDumpsEnabled(true, { MBRUSH_DEBUG: "1" })).toBe(true);
    expect(debugDumpsEnabled(true, { MBRUSH_DEBUG: "0" })).toBe(false);
    expect(debugDumpsEnabled(true, { MBRUSH_DEBUG: "" })).toBe(false);
  });
});

describe("pruning the debug folder", () => {
  const f = (name: string, size: number, mtimeMs: number) => ({ name, size, mtimeMs });

  it("deletes nothing while under the cap", () => {
    expect(pickForPruning([f("a", 40, 10), f("b", 40, 20)], 0, 100)).toEqual([]);
  });

  it("deletes the oldest first, and only as many as needed", () => {
    const files = [f("new", 40, 30), f("old", 40, 10), f("mid", 40, 20)];
    expect(pickForPruning(files, 0, 100)).toEqual(["old"]);
    expect(pickForPruning(files, 0, 50)).toEqual(["old", "mid"]);
  });

  it("never deletes what was there before the cap, however much there is", () => {
    const files = [f("legacy-1", 9000, 1), f("legacy-2", 9000, 2), f("a", 60, 100), f("b", 60, 110)];
    // 18,000 bytes of old dumps do not count against the cap and are not candidates.
    expect(pickForPruning(files, 50, 100)).toEqual(["a"]);
    expect(pickForPruning(files, 50, 1000)).toEqual([]);
  });

  it("a single file over the cap is deleted rather than kept forever", () => {
    expect(pickForPruning([f("huge", 500, 10)], 0, 100)).toEqual(["huge"]);
  });
});
