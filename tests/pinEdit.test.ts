import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildModePrompt } from "../electron/providers/umage2/Umage2Mapper";
import { recreateOverride, PIN_EDIT_BASE, ERASE_WHOLE_PROMPT } from "../shared/erasePrompts";

// A pin said "an attack spaceship emerges here", and the engine returned the same picture:
// the recreate base prompt told it to reproduce the image faithfully, and it obeyed that
// over the pin instruction that came after. Measured on the real run's debug dump.

describe("a recreate that is really an edit", () => {
  it("picks the edit base from the flags, erase before pins", () => {
    expect(recreateOverride(undefined)).toBeNull();
    expect(recreateOverride({})).toBeNull();
    expect(recreateOverride({ pinEdit: true })).toBe(PIN_EDIT_BASE);
    expect(recreateOverride({ eraseObjects: true })).toBe(ERASE_WHOLE_PROMPT);
    expect(recreateOverride({ eraseObjects: true, pinEdit: true })).toBe(ERASE_WHOLE_PROMPT);
  });

  it("umage2: pins replace the fidelity base instead of trailing after it", () => {
    const pin = "pin 1 (x: 55%, y: 23%) an attack spaceship emerges";
    const out = buildModePrompt("recreate", pin, { pinEdit: true, preserveGeometry: true, preserveColor: true });
    expect(out.startsWith(PIN_EDIT_BASE)).toBe(true);
    expect(out).not.toMatch(/Recreate this image|avoid stylistic reinterpretation/);
    expect(out).toContain(pin);
    // The guards still hold — for the rest of the picture, not over the pinned change.
    expect(out).toMatch(/Everywhere else, preserve the original color palette/);
  });

  it("umage2: an ordinary recreate is untouched", () => {
    const out = buildModePrompt("recreate", "sharper", { preserveGeometry: true });
    expect(out).toMatch(/^Recreate this image in full/);
    expect(out).not.toMatch(/Everywhere else/);
  });

  // Nano Banana, Reve and Grok build their recreate prompt inline around a network call, so
  // the check is that each one consults the shared override before its own base.
  for (const [name, file] of [
    ["Nano Banana", "electron/providers/nano-banana/NanoBananaProvider.ts"],
    ["Grok", "electron/providers/grok/GrokProvider.ts"],
    ["Reve", "electron/providers/reve/ReveProvider.ts"],
  ] as const) {
    it(`${name} consults the shared override before its recreate base`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toMatch(/import \{ recreateOverride \} from "..\/..\/..\/shared\/erasePrompts\.js"/);
      const override = src.indexOf("recreateOverride(");
      const base = src.indexOf("recreatePrompt(");
      expect(override).toBeGreaterThan(-1);
      expect(base).toBeGreaterThan(override);
    });
  }

  it("the store flags a recreate whose prompt carried pins", () => {
    const src = readFileSync("src/state/store.ts", "utf8");
    expect(src).toMatch(/pinEdit = expanded\.used\.length > 0/);
    expect(src).toMatch(/if \(pinEdit\) reqSettings\.pinEdit = true/);
  });

  it("a whole-frame result lands on the whole canvas, not in the active layer's box", () => {
    const src = readFileSync("src/state/store.ts", "utf8");
    expect(src).toMatch(/const wholeFrame = mode === "recreate" \|\| mode === "upscale" \|\| mode === "removebg"/);
    expect(src).toMatch(/const parent = !wholeFrame && state\.activeLayerId/);
  });
});
