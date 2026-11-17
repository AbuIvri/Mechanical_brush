import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { clampRect, moveRect, resizeRect, blendBand, snapToEdges, snapMoveToEdges, LARGE_IMAGE_EDGE } from "../src/piece";
import { originalUrl, isOriginalUrl, ORIGINAL_SCHEME } from "../shared/originalUrl";

const OW = 8000, OH = 5000;

describe("choosing the piece", () => {
  it("a dragged rectangle is whole pixels, inside the photo, either way it is dragged", () => {
    expect(clampRect({ x: 100.4, y: 50.6, w: 2000.2, h: 999.7 }, OW, OH)).toEqual({ x: 100, y: 51, w: 2001, h: 999 });
    // Dragged up and to the left: negative size, same rectangle.
    expect(clampRect({ x: 2100, y: 1050, w: -2000, h: -1000 }, OW, OH)).toEqual({ x: 100, y: 50, w: 2000, h: 1000 });
    // Past the edge: stops at it.
    expect(clampRect({ x: 7000, y: 4000, w: 3000, h: 3000 }, OW, OH)).toEqual({ x: 7000, y: 4000, w: 1000, h: 1000 });
  });

  it("moving keeps the size and stays inside", () => {
    expect(moveRect({ x: 100, y: 100, w: 2048, h: 1024 }, 10000, 10000, OW, OH)).toEqual({ x: OW - 2048, y: OH - 1024, w: 2048, h: 1024 });
    expect(moveRect({ x: 100, y: 100, w: 2048, h: 1024 }, -500, 20.6, OW, OH)).toEqual({ x: 0, y: 121, w: 2048, h: 1024 });
  });

  it("typing an exact size lands on it, grown around the centre, within the photo", () => {
    const r = resizeRect({ x: 1000, y: 1000, w: 1000, h: 1000 }, 2048, 2048, OW, OH);
    expect([r.w, r.h]).toEqual([2048, 2048]);
    expect(r.x + r.w / 2).toBeCloseTo(1500, 0);
    // Too big to fit: capped at the photo.
    expect(resizeRect({ x: 0, y: 0, w: 10, h: 10 }, 9000, 6000, OW, OH)).toEqual({ x: 0, y: 0, w: OW, h: OH });
  });

  it("a drawn edge that stops just short of the border lands on it", () => {
    // 4 screen px short at 5.3 original px each — the 21px sliver that was left behind.
    const tol = 12 * 5.3;
    expect(snapToEdges({ x: 4000, y: 2500, w: 3979, h: 2479 }, OW, OH, tol)).toEqual({ x: 4000, y: 2500, w: 4000, h: 2500 });
    expect(snapToEdges({ x: 40, y: 30, w: 1000, h: 1000 }, OW, OH, tol)).toEqual({ x: 0, y: 0, w: 1040, h: 1030 });
    // Far from every border: untouched.
    const mid = { x: 2000, y: 1500, w: 1000, h: 800 };
    expect(snapToEdges(mid, OW, OH, tol)).toEqual(mid);
  });

  it("a moved rectangle goes flush against a border it comes near, keeping its size", () => {
    const tol = 60;
    expect(snapMoveToEdges({ x: 7000 - 30, y: 10, w: 1000, h: 500 }, OW, OH, tol)).toEqual({ x: 7000, y: 0, w: 1000, h: 500 });
    expect(snapMoveToEdges({ x: 3000, y: 2000, w: 1000, h: 500 }, OW, OH, tol)).toEqual({ x: 3000, y: 2000, w: 1000, h: 500 });
  });

  it("asks only above 4K", () => {
    expect(LARGE_IMAGE_EDGE).toBe(4096);
  });
});

describe("putting the piece back", () => {
  // Opacity of a Gaussian-blurred edge, d pixels inside it (negative = outside).
  const erf = (x: number) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  };
  const alpha = (d: number, sigma: number) => 0.5 * (1 + erf(d / (sigma * Math.SQRT2)));

  it("fades inside its own band: the photo at the piece's edge, the piece past the band", () => {
    const band = 48;
    const { sigma, keep } = blendBand(2048, 1536, band);
    // At the piece's outer edge (keep.x outside the keep rect): the photo, unchanged.
    expect(alpha(-keep.x, sigma)).toBeLessThan(0.01);
    // At the band's inner edge: the piece as edited.
    expect(alpha(band - keep.x, sigma)).toBeGreaterThan(0.99);
  });

  it("no band is a hard paste", () => {
    expect(blendBand(2048, 1536, 0)).toEqual({ sigma: 0, keep: { x: 0, y: 0, w: 2048, h: 1536 } });
  });

  it("never asks for a band wider than half the piece", () => {
    const { keep } = blendBand(100, 60, 500);
    expect(keep.w).toBeGreaterThan(0);
    expect(keep.h).toBeGreaterThan(0);
  });
});

describe("originals over the app's own scheme", () => {
  it("never puts a path in the URL — only the token", () => {
    const u = originalUrl("1f0e-token");
    expect(u).toBe(`${ORIGINAL_SCHEME}://o/1f0e-token`);
    expect(isOriginalUrl(u)).toBe(true);
    expect(isOriginalUrl("data:image/png;base64,AAA")).toBe(false);
  });
});

// ---- wiring --------------------------------------------------------------------------
const STORE = readFileSync("src/state/store.ts", "utf8");
const COMP = readFileSync("src/compositing.ts", "utf8");
const MAIN = readFileSync("electron/main.ts", "utf8");
const HANDLERS = readFileSync("electron/ipc/handlers.ts", "utf8");

describe("wiring", () => {
  it("a picture over 4K asks before anything is shrunk", () => {
    const body = STORE.slice(STORE.indexOf("  async newProjectFromImage("), STORE.indexOf("  async newPieceProject("));
    expect(body.indexOf("largeImageAsk")).toBeGreaterThan(-1);
    expect(body.indexOf("largeImageAsk")).toBeLessThan(body.indexOf("downscaleToMax"));
    expect(body).toMatch(/if \(choice === "piece"\) return get\(\)\.newPieceProject\(name, dataUrl, from\)/);
  });

  it("the piece is cut pixel for pixel from the original and remembers where", () => {
    expect(STORE).toMatch(/const src = await cropImage\(originalUrl\(original\.token\), rect\)/);
    expect(STORE).toMatch(/pieceSource: \{ original, rect \}/);
  });

  it("going back: the piece at its own size, laid into the original at its rect", () => {
    expect(STORE).toMatch(/project\.canvas\.backgroundColor, Math\.max\(W, H\)\)/);
    expect(STORE).toMatch(/await pasteInto\(originalUrl\(token\), patch, rect, original\.width, original\.height\)/);
    // A new file in the photo's folder — overwriting is a choice made in the save dialog.
    expect(STORE).toMatch(/`\$\{dir\}\$\{base\}-ערוך\.\$\{ext\}`/);
  });

  it("the canvas that draws an original stays exportable (CORS, and the image asks for it)", () => {
    expect(COMP).toMatch(/if \(isOriginalUrl\(src\)\) img\.crossOrigin = "anonymous"/);
    const scheme = readFileSync("electron/ipc/originals.ts", "utf8");
    expect(scheme).toMatch(/corsEnabled: true/);
    expect(scheme).toMatch(/"access-control-allow-origin": "\*"/);
    expect(MAIN.indexOf("registerOriginalScheme();")).toBeLessThan(MAIN.indexOf("app.whenReady()"));
    expect(MAIN).toMatch(/img-src 'self' data: blob: \$\{ORIGINAL_SCHEME\}:/);
  });

  it("a reopened piece re-registers its original, from file and from autosave", () => {
    expect(HANDLERS.match(/attachProjectOriginals\(deserializeProject\(raw\)\)/g)?.length).toBe(2);
  });

  it("every drag on the photo draws; only the size label moves", () => {
    const ui = readFileSync("src/ui/BigImage.tsx", "utf8");
    expect(ui).toMatch(/const onDown = \(e: React\.PointerEvent\) => begin\(e, "draw"\);/);
    expect(ui).toMatch(/e\.stopPropagation\(\);\s*begin\(e, "move"\);/);
    expect(ui).not.toMatch(/inside\(p, rect\) \? \{ kind: "move"/);
  });

  it("nothing of the old piece-tab mechanism is left to collide with 'duplicate layer'", () => {
    expect(readFileSync("src/ui/toolbarItems.ts", "utf8")).not.toMatch(/aux:piece/);
    expect(STORE).not.toMatch(/openPiece|returnPiece|pieceOf/);
  });
});
