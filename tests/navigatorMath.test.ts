import { describe, it, expect } from "vitest";
import { visibleFraction, panToCenter } from "../src/navigatorMath";

const layer = { x: 0, y: 0, w: 1000, h: 500 };

describe("navigator geometry", () => {
  it("marks nothing while the whole layer is on screen", () => {
    expect(visibleFraction(layer, { zoom: 0.5, panX: 20, panY: 20, viewW: 800, viewH: 600 })).toBeNull();
  });

  it("marks the part on screen when zoomed in", () => {
    // 200% with the picture's top-left at the view's top-left: 400×300 of it shows.
    const f = visibleFraction(layer, { zoom: 2, panX: 0, panY: 0, viewW: 800, viewH: 600 })!;
    expect(f.x).toBeCloseTo(0);
    expect(f.y).toBeCloseTo(0);
    expect(f.w).toBeCloseTo(0.4);
    expect(f.h).toBeCloseTo(0.6);
  });

  it("follows the pan, and works for a layer that is not at the origin", () => {
    const patch = { x: 500, y: 250, w: 200, h: 100 };
    // View covers picture x 550..650 (zoom 4, 400px wide, pan −2200).
    const f = visibleFraction(patch, { zoom: 4, panX: -2200, panY: -1000, viewW: 400, viewH: 400 })!;
    expect(f.x).toBeCloseTo(0.25);
    expect(f.w).toBeCloseTo(0.5);
  });

  it("returns null when the layer is off screen", () => {
    expect(visibleFraction(layer, { zoom: 1, panX: -5000, panY: 0, viewW: 800, viewH: 600 })).toBeNull();
  });

  it("a click centres the view on that point, and round-trips", () => {
    const v = { zoom: 2, panX: 0, panY: 0, viewW: 800, viewH: 600 };
    const p = panToCenter(layer, 0.5, 0.5, v);
    expect(p).toEqual({ panX: 400 - 500 * 2, panY: 300 - 250 * 2 });
    const f = visibleFraction(layer, { ...v, ...p })!;
    expect(f.x + f.w / 2).toBeCloseTo(0.5);
    expect(f.y + f.h / 2).toBeCloseTo(0.5);
  });
});
