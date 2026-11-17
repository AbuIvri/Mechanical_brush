import { describe, it, expect } from "vitest";
import { labelRegions, mergeNearby } from "../src/regions";

/** A w×h alpha map with filled rectangles. */
function map(w: number, h: number, rects: [number, number, number, number][]): Uint8Array {
  const a = new Uint8Array(w * h);
  for (const [x, y, rw, rh] of rects)
    for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) a[j * w + i] = 255;
  return a;
}

describe("regions", () => {
  it("finds two far-apart blobs as two areas, with exact boxes", () => {
    const { boxes } = labelRegions(map(400, 200, [[10, 10, 20, 30], [300, 100, 40, 40]]), 400, 200);
    expect(boxes).toEqual([
      { x: 10, y: 10, w: 20, h: 30 },
      { x: 300, y: 100, w: 40, h: 40 },
    ]);
    expect(mergeNearby(boxes)).toEqual([[0], [1]]);
  });

  it("treats touching strokes as one area", () => {
    const { boxes } = labelRegions(map(200, 200, [[10, 10, 50, 10], [55, 10, 10, 80]]), 200, 200);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toEqual({ x: 10, y: 10, w: 55, h: 80 });
  });

  it("does not connect diagonal-only neighbours", () => {
    const { boxes } = labelRegions(map(10, 10, [[2, 2, 1, 1], [3, 3, 1, 1]]), 10, 10);
    expect(boxes).toHaveLength(2);
  });

  it("merges areas close enough that their patches would overlap", () => {
    // Two separate blobs 30px apart: the fill padding (≥24px each side) makes them collide.
    const { boxes } = labelRegions(map(400, 200, [[100, 50, 40, 40], [170, 50, 40, 40]]), 400, 200);
    expect(boxes).toHaveLength(2);
    expect(mergeNearby(boxes)).toEqual([[0, 1]]);
  });

  it("keeps merging when a merged box reaches a third area", () => {
    // A tall and B short merge into a 100×100 box. C sits in that box's padded corner —
    // clear of A's padding (x ≤ 64) and of B's (y ≤ 34) — so only the merge reaches it.
    const boxes = [
      { x: 0, y: 0, w: 40, h: 100 },
      { x: 60, y: 0, w: 40, h: 10 },
      { x: 90, y: 140, w: 30, h: 30 },
      { x: 1000, y: 1000, w: 10, h: 10 },
    ];
    // Guard the premise: C alone overlaps neither A nor B.
    expect(mergeNearby([boxes[0], boxes[2]])).toEqual([[0], [1]]);
    expect(mergeNearby([boxes[1], boxes[2]])).toEqual([[0], [1]]);
    expect(mergeNearby(boxes)).toEqual([[0, 1, 2], [3]]);
  });

  it("returns nothing for an empty mask", () => {
    expect(labelRegions(new Uint8Array(100), 10, 10).boxes).toEqual([]);
    expect(mergeNearby([])).toEqual([]);
  });
});
