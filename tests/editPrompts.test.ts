import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fillPrompt, recreatePrompt } from "../shared/editPrompts";
import { PIN_EDIT_BASE, ERASE_WHOLE_PROMPT } from "../shared/erasePrompts";

const ENGINES = [
  "electron/providers/umage2/Umage2Provider.ts",
  "electron/providers/nano-banana/NanoBananaProvider.ts",
  "electron/providers/grok/GrokProvider.ts",
  "electron/providers/reve/ReveProvider.ts",
  "electron/providers/ideogram/IdeogramProvider.ts",
];

describe("fill is a selective edit", () => {
  const p = fillPrompt("add four white tzitzit fringes to the lower hem", { contextImage: false });

  it("says the edit once, as the one change", () => {
    expect(p).toMatch(/^Make one selective edit to this image\. The edit: add four white tzitzit fringes to the lower hem\./);
    expect(p.match(/tzitzit/g)).toHaveLength(1);
  });

  it("keeps everything else as it was, colour and contrast included", () => {
    expect(p).toContain("Change only what this edit needs");
    expect(p).toMatch(/same colours, brightness, contrast, saturation and white balance/);
    expect(p).toMatch(/Do not enhance, re-grade, brighten, sharpen or smooth/);
  });

  it("does not ask for more sharpness than the input — that re-graded whole crops", () => {
    expect(p).not.toMatch(/MAXIMUM|ideally sharper|super-detailed/i);
  });

  it("explains the context image only when one is sent", () => {
    expect(p).not.toContain("low-resolution view");
    expect(fillPrompt("x", { contextImage: true })).toContain("low-resolution view of the complete picture");
  });

  it("has a sensible edit when the prompt is empty, and does not double a full stop", () => {
    expect(fillPrompt("", { contextImage: false })).toContain("The edit: Subtly retouch the image.");
    expect(fillPrompt("make it red.", { contextImage: false })).toContain("The edit: make it red. ");
  });

  it("no engine keeps its own fill wording or the sharpness demand", () => {
    for (const f of ENGINES) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("fillPrompt(");
      expect(src, f).not.toMatch(/MAXIMUM sharpness|ideally sharper/);
      expect(src, f).not.toContain("`Edit the image and ${");
    }
  });
});

describe("recreate is a whole re-render", () => {
  it("applies the instruction to the entire picture", () => {
    const p = recreatePrompt("turn it into a winter evening", {});
    expect(p).toMatch(/^Recreate this image in full, as one complete new render/);
    expect(p).toContain("Apply this to the whole picture, not to one area: turn it into a winter evening.");
  });

  it("holds back only what the preserve switches ask for", () => {
    expect(recreatePrompt("x", {})).not.toMatch(/Keep the/);
    const p = recreatePrompt("x", { preserveColor: true, preserveGeometry: true, preserveIdentity: true });
    expect(p).toContain("Keep the original colour palette and tone.");
    expect(p).toContain("Keep the composition, geometry and framing.");
    expect(p).toContain("Keep the subject's identity and product shape.");
  });

  it("without an instruction it remasters without restyling", () => {
    expect(recreatePrompt(undefined, {})).toContain("without reinterpreting its style");
  });

  it("names the input the way the engine numbers it", () => {
    expect(recreatePrompt("x", {}, "the first image")).toMatch(/^Recreate the first image in full/);
  });

  it("an edit dressed as a recreate (pins, erase) never gets the whole-frame base", () => {
    const pins = recreatePrompt("pin 1 (x: 5%, y: 9%) a boat", { pinEdit: true, preserveColor: true });
    expect(pins.startsWith(PIN_EDIT_BASE)).toBe(true);
    expect(pins).not.toMatch(/Recreate|whole picture/);
    expect(recreatePrompt(undefined, { eraseObjects: true }).startsWith(ERASE_WHOLE_PROMPT)).toBe(true);
  });
});
