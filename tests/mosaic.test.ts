import { describe, it, expect } from "vitest";
import { getMosaicLayers, mosaicCells, fitContain } from "../src/mosaic";
import type { Layer } from "../shared/types";

function layer(id: string, w: number, h: number, visible = true): Layer {
  return {
    id, name: id, type: "generated", visible, locked: false, opacity: 1,
    blendMode: "normal", x: 0, y: 0, width: w, height: h, src: "",
  };
}

describe("getMosaicLayers", () => {
  const ls = [layer("a", 100, 100), layer("b", 100, 100), layer("c", 200, 100), layer("d", 100, 100, false)];
  it("returns ticked, visible layers of the first ticked layer's shape", () => {
    expect(getMosaicLayers(ls, ["a", "b", "c"]).map((l) => l.id)).toEqual(["a", "b"]);
  });
  it("returns [] when fewer than 2 qualify", () => {
    expect(getMosaicLayers(ls, ["a"])).toEqual([]);
    expect(getMosaicLayers(ls, ["a", "c"])).toEqual([]); // only 'a' matches shape
    expect(getMosaicLayers(ls, ["a", "d"])).toEqual([]); // 'd' is hidden
  });
});

describe("mosaicCells", () => {
  it("lays 4 tiles in a 2x2 grid filling the canvas", () => {
    const cells = mosaicCells(4, 800, 600, 0);
    expect(cells).toHaveLength(4);
    expect(cells[0]).toEqual({ x: 0, y: 0, w: 400, h: 300 });
    expect(cells[3]).toEqual({ x: 400, y: 300, w: 400, h: 300 });
  });
  it("uses ceil(sqrt) columns for 3 tiles (2 cols, 2 rows)", () => {
    const cells = mosaicCells(3, 900, 900, 0);
    expect(cells).toHaveLength(3);
    expect(cells[0].w).toBe(450);
  });
});

describe("fitContain", () => {
  it("fits a wide tile into a square cell by width", () => {
    expect(fitContain(200, 100, 100, 100)).toEqual({ w: 100, h: 50 });
  });
  it("fits a tall tile into a square cell by height", () => {
    expect(fitContain(100, 200, 100, 100)).toEqual({ w: 50, h: 100 });
  });
});
