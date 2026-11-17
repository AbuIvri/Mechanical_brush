import { describe, it, expect } from "vitest";
import { pickSize, buildModePrompt } from "../electron/providers/umage2/Umage2Mapper";

function parse(s: string) {
  const [w, h] = s.split("x").map(Number);
  return { w, h };
}

describe("pickSize", () => {
  it("returns one of the fixed sizes for gpt-image-1", () => {
    const s = pickSize("gpt-image-1", 2000, 1000, undefined);
    expect(["1024x1024", "1536x1024", "1024x1536"]).toContain(s);
  });

  it("keeps aspect ratio roughly for flexible model", () => {
    const s = pickSize("gpt-image-2", 1600, 900, undefined);
    const { w, h } = parse(s);
    expect(Math.abs(w / h - 16 / 9)).toBeLessThan(0.2);
  });

  it("respects gpt-image-2 pixel + multiple-of-16 constraints", () => {
    const s = pickSize("gpt-image-2", 1000, 1000, undefined);
    const { w, h } = parse(s);
    expect(w % 16).toBe(0);
    expect(h % 16).toBe(0);
    expect(w * h).toBeGreaterThanOrEqual(655360);
    expect(w * h).toBeLessThanOrEqual(8294400);
    expect(Math.max(w / h, h / w)).toBeLessThanOrEqual(3);
  });

  it("honors requested output size on flexible model", () => {
    const s = pickSize("gpt-image-2", 1000, 1000, { outputWidth: 2048, outputHeight: 2048 });
    const { w, h } = parse(s);
    expect(w).toBe(2048);
    expect(h).toBe(2048);
  });

  it("never exceeds the pixel budget even when snapping rounds up", () => {
    // 3632x2288 = 8,310,016 > 8,294,400 — the size that the API hard-rejected.
    for (const [rw, rh] of [
      [3632, 2288],
      [3640, 2290],
      [5000, 4000],
      [4536, 4536],
    ]) {
      const { w, h } = parse(pickSize("gpt-image-2", rw, rh, { outputWidth: rw, outputHeight: rh }));
      expect(w % 16).toBe(0);
      expect(h % 16).toBe(0);
      expect(w * h).toBeLessThanOrEqual(8294400);
    }
  });
});

describe("buildModePrompt", () => {
  it("includes preservation guards when set", () => {
    const p = buildModePrompt("recreate", "make it pop", {
      preserveColor: true,
      preserveGeometry: true,
    });
    expect(p).toContain("colour palette");
    expect(p).toContain("composition");
    expect(p).toContain("make it pop");
  });
});
