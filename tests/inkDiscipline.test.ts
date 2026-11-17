import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// The design system's hardest rule, held by a test because it is the easiest to erode:
// the colour --ink appears only as a brush stroke. Used as a flat fill, a border or a
// text colour "just this once", it stops being the product's signature and becomes an
// accent colour like everyone else's.

const SRC = path.resolve(__dirname, "..", "src");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(css|tsx?)$/.test(name)) out.push(p);
  }
  return out;
}

describe("ink discipline", () => {
  it("var(--ink) is used in ink.css and nowhere else", () => {
    const offenders = files(SRC)
      .filter((f) => path.basename(f) !== "ink.css")
      .filter((f) => /var\(--ink\)/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("the ink hex is not smuggled in as a literal", () => {
    const offenders = files(SRC)
      // styles.css declares the token; the canvas draws marks with it (Konva has no CSS).
      .filter((f) => !["styles.css", "inkColor.ts"].includes(path.basename(f)))
      .filter((f) => /#e96a1b/i.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("the canvas ink equals the --ink token", async () => {
    const css = readFileSync(path.join(SRC, "styles.css"), "utf8");
    const token = css.match(/--ink:\s*(#[0-9a-f]{6})/i)?.[1];
    const { INK } = await import("../src/canvas/inkColor");
    expect(INK.toLowerCase()).toBe(token?.toLowerCase());
  });

  it("no brush shapes are left: the ink is flat everywhere but the logo", async () => {
    const css = readFileSync(path.join(SRC, "ink.css"), "utf8");
    expect(css).not.toMatch(/--stroke-(wet|dry)|mask(-image)?\s*:/);
    const ink = await import("../src/canvas/inkColor");
    expect("WET_PATH" in ink || "INK_BLOB_URL" in ink).toBe(false);
  });

  it("the old orange is gone from the stylesheet", () => {
    expect(readFileSync(path.join(SRC, "styles.css"), "utf8")).not.toMatch(/#d98a3d|217,\s*138,\s*61/i);
  });
});
