import { describe, it, expect } from "vitest";
import {
  paddedFillBox,
  regionReadout,
  FILL_BENCHMARKS,
  clampBoxAspect,
} from "../src/fillRegion";

const C = 6000; // a canvas big enough that padding is never clipped
/** A mark centred on the canvas, so its padding is never cut by an edge. */
const mid = (size: number) =>
  regionReadout({ x: C / 2 - size / 2, y: C / 2 - size / 2, w: size, h: size }, C, C);

describe("paddedFillBox", () => {
  it("adds ~14% of each side, on both sides", () => {
    const b = paddedFillBox({ x: 1000, y: 1000, w: 1000, h: 1000 }, C, C);
    expect(b.w).toBe(1280); // 1000 + 2×140
    expect(b.h).toBe(1280);
  });

  it("never pads less than 24px, so a tiny mark still gets context", () => {
    const b = paddedFillBox({ x: 1000, y: 1000, w: 50, h: 50 }, C, C);
    expect(b.w).toBe(50 + 48);
  });

  it("keeps the shape of what was marked — a wide mark stays wide", () => {
    const b = paddedFillBox({ x: 1000, y: 1000, w: 2000, h: 1000 }, C, C);
    expect(b.w / b.h).toBeGreaterThan(1.5);
  });

  it("clips at the canvas edge instead of running off it", () => {
    const b = paddedFillBox({ x: 0, y: 0, w: 500, h: 500 }, 1000, 1000);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(b.x + b.w).toBeLessThanOrEqual(1000);
  });

  it("widens a sliver rather than sending a 20:1 crop", () => {
    const b = paddedFillBox({ x: 500, y: 500, w: 2000, h: 100 }, C, C);
    expect(Math.max(b.w / b.h, b.h / b.w)).toBeLessThanOrEqual(4.01);
  });
});

describe("regionReadout — what the badge says", () => {
  it("reports the rectangle's own size, not the padded one", () => {
    const r = regionReadout({ x: 1000, y: 1000, w: 800, h: 600 }, C, C);
    expect(r.w).toBe(800);
    expect(r.h).toBe(600);
  });

  it("lands on 1K when the mark is ~800 — NOT when it is 1024", () => {
    // This is the whole point: padding means the rectangle is smaller than the
    // resolution it produces. A badge that fired at 1024 would be lying.
    expect(mid(800).onBenchmark).toBe(true);
    expect(mid(800).nearest.label).toBe("1K");
    expect(mid(1024).onBenchmark).toBe(false);
  });

  it("the sent long edge is exactly 1.28× the mark, away from the edges", () => {
    expect(mid(1000).sentLongEdge / 1000).toBeCloseTo(1.28, 3);
  });

  it("hits every offered resolution at the right mark size", () => {
    for (const b of FILL_BENCHMARKS) {
      const r = mid(Math.round(b.px / 1.28));
      expect(r.nearest.px).toBe(b.px);
      expect(r.onBenchmark).toBe(true);
      expect(r.sentLongEdge).toBe(b.px);
    }
  });

  it("goes off-benchmark a few percent away, so the highlight means something", () => {
    expect(mid(900).onBenchmark).toBe(false);
  });

  it("is honest at the canvas edge, where the padding gets clipped", () => {
    // Same 800px mark, but in the corner: only one side gets padded, so the crop is
    // smaller and it is NOT 1:1. A fixed 1.28 multiplier would have claimed it was.
    const corner = regionReadout({ x: 0, y: 0, w: 800, h: 800 }, C, C);
    expect(corner.sentLongEdge).toBeLessThan(1024);
    expect(corner.onBenchmark).toBe(false);
  });

  it("flags a square mark, which is what '1024 × 1024' asks about", () => {
    expect(regionReadout({ x: 0, y: 0, w: 800, h: 800 }, C, C).square).toBe(true);
    expect(regionReadout({ x: 0, y: 0, w: 800, h: 600 }, C, C).square).toBe(false);
  });
});

describe("clampBoxAspect", () => {
  it("leaves a reasonable box alone", () => {
    const b = { x: 0, y: 0, w: 400, h: 300 };
    expect(clampBoxAspect(b, 4, 1000, 1000)).toBe(b);
  });
});

// --- a rectangle is sent as drawn, and only an exact hit lights up ------------------
import { fillBoxFor } from "../src/fillRegion";

describe("a rectangle selection", () => {
  it("is sent exactly as drawn — no padding, so 1024 means 1024", () => {
    const mark = { x: 1000, y: 1000, w: 1024, h: 1024 };
    expect(fillBoxFor(mark, C, C, true)).toEqual(mark);
  });

  it("still pads a brush or wand selection, which has no promise to keep", () => {
    const mark = { x: 1000, y: 1000, w: 1024, h: 1024 };
    expect(fillBoxFor(mark, C, C, false).w).toBe(1310);
  });
});

describe("the highlight fires on the exact value and nothing else", () => {
  const at = (w: number, h = w) => regionReadout({ x: 500, y: 500, w, h }, C, C, true);

  it("lights up on each offered resolution, to the pixel", () => {
    for (const b of FILL_BENCHMARKS) {
      expect(at(b.px).onBenchmark).toBe(true);
      expect(at(b.px).nearest.label).toBe(b.label);
      expect(at(b.px).sentLongEdge).toBe(b.px);
    }
  });

  it("stays dark one pixel either side — no range at all", () => {
    expect(at(1023).onBenchmark).toBe(false);
    expect(at(1025).onBenchmark).toBe(false);
    expect(at(2047).onBenchmark).toBe(false);
    expect(at(2049).onBenchmark).toBe(false);
  });

  it("goes by the long edge, so a non-square rectangle can be exact too", () => {
    // 2048 × 1200 is sent at 2048 on its long edge: 1:1, no resampling.
    expect(at(2048, 1200).onBenchmark).toBe(true);
    expect(at(1200, 2048).onBenchmark).toBe(true);
  });

  it("keeps reporting the live size whether or not it is on a value", () => {
    const r = at(1337, 900);
    expect(r.w).toBe(1337);
    expect(r.h).toBe(900);
    expect(r.onBenchmark).toBe(false);
  });

  it("is exact in the canvas corner too, because nothing is padded away", () => {
    const r = regionReadout({ x: 0, y: 0, w: 2048, h: 2048 }, C, C, true);
    expect(r.sentLongEdge).toBe(2048);
    expect(r.onBenchmark).toBe(true);
  });

  it("flags a square, which is what '1024 × 1024' asks about", () => {
    expect(at(1024).square).toBe(true);
    expect(at(1024, 800).square).toBe(false);
  });
});

import { regionDensity, scaleBox } from "../src/fillRegion";

describe("fill density — canvas pixels are not image pixels", () => {
  // The session that found this: a 3808×1280 canvas with a Crystal ×2 upscale on top.
  const base = { x: 0, y: 0, width: 3808, height: 1280, visible: true, type: "base", natW: 3808 };
  const upscale = { ...base, type: "generated", natW: 7616 };
  const mark = { x: 1412, y: 350, w: 473, h: 273 };

  it("cuts at the density of the sharpest layer under the mark", () => {
    expect(regionDensity([base, upscale], mark)).toBe(2);
  });

  it("ignores layers that are hidden, references, masks, or elsewhere", () => {
    expect(regionDensity([base, { ...upscale, visible: false }], mark)).toBe(1);
    expect(regionDensity([base, { ...upscale, type: "reference" }], mark)).toBe(1);
    expect(regionDensity([base, { ...upscale, type: "mask" }], mark)).toBe(1);
    const far = { ...upscale, x: 3000, y: 900, width: 400, height: 200, natW: 1600 };
    expect(regionDensity([base, far], mark)).toBe(1);
  });

  it("never goes below one image pixel per canvas pixel", () => {
    expect(regionDensity([{ ...base, natW: 1904 }], mark)).toBe(1);
  });

  it("caps the crop's long edge", () => {
    expect(regionDensity([{ ...base, natW: 3808 * 8 }], { x: 0, y: 0, w: 2048, h: 1000 }, 8192)).toBe(4);
  });

  it("scales the box into the denser grid", () => {
    expect(scaleBox(mark, 2)).toEqual({ x: 2824, y: 700, w: 946, h: 546 });
    expect(scaleBox(mark, 1)).toEqual(mark);
  });

  it("the badge reads image pixels, so 512 over a ×2 upscale is a 1K mark", () => {
    const r = regionReadout({ x: 100, y: 100, w: 512, h: 512 }, 3808, 1280, true, 2);
    expect([r.w, r.h, r.sentLongEdge]).toEqual([1024, 1024, 1024]);
    expect(r.onBenchmark).toBe(true);
    expect(regionReadout({ x: 100, y: 100, w: 512, h: 512 }, 3808, 1280, true).onBenchmark).toBe(false);
  });
});

import { fillLongEdgeFor, workingSize } from "../src/fillRegion";
import { maskBoundsQuick } from "../src/compositing";

describe("fill generation size — follows the marked area unless one is picked", () => {
  it("auto (0 or unset) is the area's own long edge in image pixels", () => {
    expect(fillLongEdgeFor(946, 546, 0)).toBe(946);
    expect(fillLongEdgeFor(946, 546, undefined)).toBe(946);
    expect(fillLongEdgeFor(1200, 2400, null)).toBe(2400);
  });

  it("a picked size wins, for any selection", () => {
    expect(fillLongEdgeFor(946, 546, 2048)).toBe(2048);
    expect(fillLongEdgeFor(946, 546, "1536")).toBe(1536);
  });

  it("an area that already fits the engine is generated 1:1", () => {
    expect(workingSize(1536, 1024, fillLongEdgeFor(1536, 1024, 0))).toEqual({ w: 1536, h: 1024 });
    expect(workingSize(2048, 2048, fillLongEdgeFor(2048, 2048, 0))).toEqual({ w: 2048, h: 2048 });
  });

  it("a small area is raised to the engine's minimum, keeping its shape", () => {
    const ws = workingSize(946, 546, 946);
    expect(ws).toEqual({ w: 1136, h: 656 });
  });

  it("a huge area is capped without being squashed", () => {
    const ws = workingSize(7000, 2000, fillLongEdgeFor(7000, 2000, 0));
    expect(ws.w).toBeLessThanOrEqual(3840);
    expect(ws.w * ws.h).toBeLessThanOrEqual(8294400);
    expect(Math.abs(ws.w / ws.h - 3.5)).toBeLessThan(0.05);
    const sq = workingSize(5000, 5000, 5000);
    expect(sq.w * sq.h).toBeLessThanOrEqual(8294400);
    expect(sq.w).toBe(sq.h);
  });
});

describe("maskBoundsQuick — the dock's live readout", () => {
  const empty = { strokes: [], rects: [], bitmaps: [], inverted: false };
  it("rectangles are exact, including ones dragged up-left", () => {
    expect(maskBoundsQuick({ ...empty, rects: [{ x: 1412, y: 350, w: 473, h: 273 }] }, 3808, 1280)).toEqual({ x: 1412, y: 350, w: 473, h: 273 });
    expect(maskBoundsQuick({ ...empty, rects: [{ x: 600, y: 400, w: -100, h: -50 }] }, 3808, 1280)).toEqual({ x: 500, y: 350, w: 100, h: 50 });
  });
  it("brush strokes count half the brush; erasers don't grow it", () => {
    const strokes = [
      { tool: "brush" as const, size: 40, points: [100, 100, 200, 150] },
      { tool: "erase" as const, size: 400, points: [1000, 1000] },
    ];
    expect(maskBoundsQuick({ ...empty, strokes }, 3808, 1280)).toEqual({ x: 80, y: 80, w: 140, h: 90 });
  });
  it("pixel selections and inverted masks are left to the run", () => {
    expect(maskBoundsQuick({ ...empty, inverted: true }, 100, 100)).toBeNull();
    expect(maskBoundsQuick({ ...empty, bitmaps: [{} as HTMLCanvasElement] }, 100, 100)).toBeNull();
    expect(maskBoundsQuick(empty, 100, 100)).toBeNull();
  });
});
