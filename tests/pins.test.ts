import { describe, it, expect } from "vitest";
import type { Annotation } from "../shared/types";
import { pinsOf, nextPinNumber, pinPercent, pinListNote, expandPinTags, pinTagsIn, PIN_LEGEND } from "../src/pins";

const pin = (n: number, x: number, y: number, note = ""): Annotation => ({ kind: "pin", n, x, y, note, color: "#f00" });

describe("pins", () => {
  it("numbers pins stably — deleting one never renumbers the rest", () => {
    const items: Annotation[] = [pin(1, 0, 0), pin(2, 0, 0), pin(3, 0, 0)];
    expect(nextPinNumber(items)).toBe(4);
    const afterDelete = items.filter((a) => !(a.kind === "pin" && a.n === 2));
    expect(pinsOf(afterDelete).map((p) => p.n)).toEqual([1, 3]);
    // The new pin is 4, not 2: a "📍3" already typed must still mean the same spot.
    expect(nextPinNumber(afterDelete)).toBe(4);
    expect(nextPinNumber([])).toBe(1);
    expect(nextPinNumber(undefined)).toBe(1);
  });

  it("never reuses the number of a deleted top pin", () => {
    // Pins 1–3, "📍3" typed in the prompt, then pin 3 is deleted. The next pin must not be 3.
    const afterDelete: Annotation[] = [pin(1, 0, 0), pin(2, 0, 0)];
    expect(nextPinNumber(afterDelete, 3)).toBe(4);
    // Without a recorded sequence (an old project) it still can't go below the canvas.
    expect(nextPinNumber(afterDelete)).toBe(3);
    // The sequence never pulls a number below what is actually on the canvas.
    expect(nextPinNumber([pin(7, 0, 0)], 2)).toBe(8);
  });

  it("ignores other markup when collecting pins", () => {
    const items: Annotation[] = [
      { kind: "text", x: 1, y: 1, text: "hi", color: "#fff", size: 12 },
      pin(5, 1, 1),
    ];
    expect(pinsOf(items).map((p) => p.n)).toEqual([5]);
    expect(nextPinNumber(items)).toBe(6);
  });

  it("measures percent from the top-left, clamped to the image", () => {
    expect(pinPercent({ x: 0, y: 0 }, 2000, 1000)).toEqual({ x: 0, y: 0 });
    expect(pinPercent({ x: 1000, y: 500 }, 2000, 1000)).toEqual({ x: 50, y: 50 });
    expect(pinPercent({ x: 2000, y: 1000 }, 2000, 1000)).toEqual({ x: 100, y: 100 });
    expect(pinPercent({ x: 1160, y: 950 }, 2000, 1000)).toEqual({ x: 58, y: 95 });
    expect(pinPercent({ x: -20, y: 1200 }, 2000, 1000)).toEqual({ x: 0, y: 100 });
  });

  it("expands known tags to coordinates and appends the legend once", () => {
    const pins = pinsOf([pin(1, 1160, 950, "asphalt"), pin(4, 1940, 360)]);
    const r = expandPinTags("📍1 make it asphalt\n📍4 Jaffa Road instead", pins, 2000, 1000);
    expect(r.text).toContain("pin 1 (x: 58%, y: 95%) make it asphalt");
    expect(r.text).toContain("pin 4 (x: 97%, y: 36%) Jaffa Road instead");
    expect(r.text).not.toContain("📍");
    expect(r.text.split(PIN_LEGEND).length).toBe(2);
    expect(r.used).toEqual([1, 4]);
    expect(r.missing).toEqual([]);
  });

  it("reports a tag with no pin behind it", () => {
    const r = expandPinTags("📍1 a, 📍9 b", pinsOf([pin(1, 0, 0)]), 100, 100);
    expect(r.missing).toEqual([9]);
    expect(r.used).toEqual([1]);
  });

  it("leaves a prompt without tags exactly as written", () => {
    const text = "sharpen the details, keep the colours";
    expect(expandPinTags(text, pinsOf([pin(1, 0, 0)]), 100, 100)).toEqual({ text, used: [], missing: [] });
    expect(pinTagsIn(text)).toEqual([]);
  });

  it("accepts a space after the emoji, and names each pin once", () => {
    expect(pinTagsIn("📍 2 here and 📍2 again, 📍10")).toEqual([2, 10]);
  });

  it("tells the assistant which pins have no note", () => {
    const note = pinListNote(pinsOf([pin(1, 50, 50, "שיהיה אספלט"), pin(3, 100, 0)]), 100, 100);
    expect(note).toContain('סיכה 1 (x: 50%, y: 50%): "שיהיה אספלט"');
    expect(note).toContain("סיכה 3 (x: 100%, y: 0%): ללא הערה");
    expect(pinListNote([], 100, 100)).toBe("");
  });
});
