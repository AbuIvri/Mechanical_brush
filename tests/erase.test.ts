import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DOC_KEYS, extractSlice } from "../src/state/docs";
import { buildModePrompt } from "../electron/providers/umage2/Umage2Mapper";
import { ERASE_FILL_PROMPT, ERASE_WHOLE_PROMPT, eraseModelFor } from "../shared/erasePrompts";

const SRC = readFileSync("src/state/store.ts", "utf8");

/** One store action's body, comments stripped (same helper as docFlags.test). */
function actionBody(name: string): string {
  const plain = SRC.indexOf(`  ${name}(`);
  const start = plain >= 0 ? plain : SRC.indexOf(`  async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  const end = rest.search(/\n {2}(?:async )?[a-zA-Z]\w*[(:]/);
  return rest
    .slice(0, end > 0 ? end : rest.length)
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

describe("erase brush", () => {
  it("keeps its paint per document, apart from the fill mask", () => {
    expect(DOC_KEYS).toContain("removeMask");
    expect(DOC_KEYS).toContain("mask");
    const live = Object.fromEntries(DOC_KEYS.map((k) => [k, null])) as Record<string, unknown>;
    const painted = { strokes: [{ tool: "brush", size: 10, points: [1, 2] }], rects: [], bitmaps: [], inverted: false };
    live.removeMask = painted;
    expect(extractSlice(live).removeMask).toBe(painted);
  });

  it("an erase run clears the erase paint and never the fill mask", () => {
    const run = actionBody("runErase");
    expect(run).toMatch(/removeMask:/);
    // runErase hands each area to generate() as `erase: { mask }` — that is its job. What
    // it must never do is clear or overwrite the user's own fill region.
    expect(run).toMatch(/erase: \{ mask:/);
    expect(run).not.toMatch(/(^|\n)\s*mask:/);
    expect(run).not.toMatch(/[{,]\s*mask:\s*(emptyMask|\{\s*strokes)/);

    // …and the fill branch's own "clear the region you filled" skips erase runs.
    expect(SRC).toMatch(/mask: mode === "fill" && !erase \?/);
  });

  it("borrows mode, prompt and mask for the run without touching the dock's", () => {
    const gen = actionBody("generate");
    expect(gen).toMatch(/const mode: GenerationMode = erase \? \(erase\.whole \? "recreate" : "fill"\) : state\.mode/);
    expect(gen).toMatch(/const prompt = erase \? \(erase\.whole \? "" : ERASE_FILL_PROMPT\) : state\.prompt/);
    expect(gen).toMatch(/const mask = erase \? erase\.mask : state\.mask/);
    // Style references are an invitation to put something back.
    expect(gen).toMatch(/const references = erase \? \[\] : state\.references/);
    // One patch per area, not three variations of the same background.
    expect(gen).toMatch(/const nVar = erase \? 1 :/);
    // The app's fixed prompt stays out of the user's history.
    expect(gen).toMatch(/prompt && !erase \? \[prompt/);
  });

  it("runs on any engine that can edit — only an upscaler is turned away", () => {
    const gen = actionBody("generate");
    // No more "whole image needs a mask" refusal: the user asked for no restriction.
    expect(gen).not.toMatch(/erase\?\.whole && !provider\.capabilities\?\.supportsMasks/);
    expect(gen).toMatch(/erase\.whole \? provider\.capabilities\?\.supportsRecreate : provider\.capabilities\?\.supportsInpainting/);
  });

  it("always sends the marked bounding rectangle, and a mask too where the engine takes one", () => {
    const gen = actionBody("generate");
    // The brush shape is amorphous; the engine gets its bounding box, so the marks are the
    // only thing saying which part of that box to clear.
    expect(gen).toMatch(/if \(erase\) \{\n\s+eraseMarkRef = await cropRegionResized\(await paintMarks\(/);
    expect(gen).toMatch(/const eraseMask = !!erase && !!provider\.capabilities\?\.supportsMasks/);
    expect(gen).toMatch(/sendMask = eraseMask \? await cropRegionResized\(fullMaskUrl/);
    // The marked copy is "the second image": straight after the image, before the fill context.
    const mark = gen.indexOf("eraseMarkRef ? [");
    expect(mark).toBeGreaterThan(-1);
    expect(gen.indexOf("...(contextRef")).toBeGreaterThan(mark);
  });

  it("erases on Sunburst within umage2, and leaves other engines' models alone", () => {
    expect(actionBody("generate")).toMatch(/if \(erase\) modelId = eraseModelFor\(providerId, modelId, provider\.models\)/);
    expect(eraseModelFor("umage2", "gpt-image-2.5-flare", [{ id: "gpt-image-2.5-sunburst" }])).toBe("gpt-image-2.5-sunburst");
    // Not offered by this build's model list → leave the choice alone rather than send a 400.
    expect(eraseModelFor("umage2", "gpt-image-2", [{ id: "gpt-image-2" }])).toBe("gpt-image-2");
    expect(eraseModelFor("nano-banana", "nano-2", [{ id: "nano-2" }])).toBe("nano-2");
  });

  it("gives an erase patch a real feather even when the fill slider is low", () => {
    const gen = actionBody("generate");
    expect(gen).toMatch(/erase \? Math\.max\(askedFeather, 6\) : askedFeather/);
  });

  it("swaps umage2's recreate base prompt for the erase one only when asked", () => {
    const erase = buildModePrompt("recreate", undefined, { eraseObjects: true });
    expect(erase).toContain(ERASE_WHOLE_PROMPT);
    expect(erase).not.toMatch(/Recreate this image/);

    const plain = buildModePrompt("recreate", undefined, {});
    expect(plain).toMatch(/Recreate this image/);
    expect(plain).not.toContain(ERASE_WHOLE_PROMPT);
  });

  it("says to add nothing in place of what it removes, and to leave no seam", () => {
    for (const p of [ERASE_FILL_PROMPT, ERASE_WHOLE_PROMPT]) {
      expect(p.toLowerCase()).toContain("remove");
      expect(p).toMatch(/nothing new in (its|their) place/);
      // The complaint that started this: the patch came back in a tone that did not match.
      expect(p).toMatch(/Match the surrounding colour, brightness, contrast, grain and texture exactly/);
      expect(p).toMatch(/no red-orange paint/);
    }
  });
});

describe("pin tags at run time", () => {
  it("are refused outside recreate, and checked for missing pins before any spend", () => {
    const gen = actionBody("generate");
    const refuse = gen.indexOf('if (mode !== "recreate")');
    const missing = gen.indexOf("expanded.missing.length");
    const busy = gen.indexOf("busy: true");
    expect(refuse).toBeGreaterThan(-1);
    expect(missing).toBeGreaterThan(refuse);
    // Both checks come before the first busy commit — i.e. before anything is sent.
    expect(busy).toBeGreaterThan(missing);
    // The expanded text is what goes to the engine; the user's own text is what's recorded.
    expect(gen).toMatch(/prompt: sendPrompt \|\| undefined/);
  });
});
