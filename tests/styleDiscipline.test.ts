import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Two rules of דיו ופלדה that are easy to erode one "just this once" at a time:
// colours come only from the tokens in :root, and steel does not move.

const css = readFileSync(path.resolve(__dirname, "..", "src", "styles.css"), "utf8");
// A theme is a token block too (:root[data-theme="…"]): values, not rules.
const outsideRoot = css.replace(/:root(\[data-(theme|well)="[a-z]+"\])?\s*\{[^}]*\}/g, "");
const lines = outsideRoot.split("\n");

describe("style discipline", () => {
  it("no colour is written directly in a rule — only tokens", () => {
    const offenders = lines.filter((l) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(l)).map((l) => l.trim());
    expect(offenders).toEqual([]);
  });

  it("nothing in the stylesheet animates or transitions (the ink lives in ink.css)", () => {
    const offenders = lines
      .filter((l) => /\b(animation|transition)\s*:/.test(l) && !/:\s*none\b/.test(l))
      // Run's stroke on hover is ink motion, allowed by the design system (120ms).
      .filter((l) => !l.includes(".generate-btn::before"))
      .map((l) => l.trim());
    expect(offenders).toEqual([]);
    expect(outsideRoot).not.toMatch(/@keyframes/);
  });
});
