import { describe, it, expect } from "vitest";
import {
  REF_ROLES,
  DEFAULT_REF_ROLE,
  normalizeRole,
  roleSpec,
  referenceGuide,
  referencesThatFit,
} from "../shared/referenceGuide";

describe("reference guide", () => {
  it("the reported case: a typography sample on a recreate is not the picture to produce", () => {
    // An English slide, "translate to Hebrew", and one Hebrew slide attached for its
    // lettering. The engine returned the Hebrew slide. It was never told what it was for.
    const g = referenceGuide([{ role: "typography" }], { hasSource: true });
    expect(g).toContain("Image 1 is the picture to work on");
    expect(g).toContain("the result must show image 1's own content and layout");
    expect(g).toContain("never the picture to produce");
    expect(g).toContain("Image 2 — typography reference");
    expect(g).toMatch(/take only its lettering style/);
    expect(g).toMatch(/Do not copy its words, its layout or anything else in it/);
  });

  it("every restricting role says what is taken AND what is not copied", () => {
    for (const r of REF_ROLES.filter((x) => x.id !== "general")) {
      const g = referenceGuide([{ role: r.id }], { hasSource: true });
      expect(g, r.id).toContain(`Image 2 — ${r.kind} reference`);
      expect(g, r.id).toContain(r.take);
      expect(g, r.id).toContain(`Do not copy ${r.leave}`);
      // …and the same, in Hebrew, under the chip.
      expect(r.hint, r.id).toMatch(/נלקח: .+ · לא מועתק: .+/);
    }
  });

  it("the neutral role restricts nothing but still declares the image a reference", () => {
    expect(DEFAULT_REF_ROLE).toBe("general");
    const g = referenceGuide([{ role: "general" }], { hasSource: true });
    expect(g).toContain("never the picture to produce");
    expect(g).toContain("use it as the prompt describes");
    expect(g).not.toContain("Do not copy");
  });

  it("numbers references after the source, or from 1 when there is none", () => {
    const withSource = referenceGuide([{ role: "style" }, { role: "object" }], { hasSource: true });
    expect(withSource).toContain("Image 2 — style reference");
    expect(withSource).toContain("Image 3 — object reference");

    const textToImage = referenceGuide([{ role: "style" }, { role: "object" }], { hasSource: false });
    expect(textToImage).toContain("Images 1–2 are references, not the picture to produce");
    expect(textToImage).toContain("Image 1 — style reference");
    expect(textToImage).toContain("Image 2 — object reference");
    expect(textToImage).not.toContain("picture to work on");

    expect(referenceGuide([{ role: "identity" }], { hasSource: false })).toContain(
      "Image 1 is a reference, not the picture to produce",
    );
  });

  it("says nothing when there are no references", () => {
    expect(referenceGuide([], { hasSource: true })).toBe("");
  });

  it("keeps old projects working: a retired role is style, narrowed to its aspect", () => {
    expect(normalizeRole("texture")).toBe("style");
    expect(normalizeRole("lighting")).toBe("style");
    expect(normalizeRole(undefined)).toBe("general");
    expect(roleSpec("color").id).toBe("style");
    const g = referenceGuide([{ role: "lighting" }], { hasSource: true });
    expect(g).toContain("style reference: take its lighting only");
    // Still forbidden to copy the content, like any style reference.
    expect(g).toContain("Do not copy its subject");
  });

  it("carries the user's note, and keeps it from breaking out of its quotes", () => {
    const g = referenceGuide(
      [{ role: "typography", note: '  the "headline"\n font only  ' }],
      { hasSource: true },
    );
    expect(g).toContain(`User note: "the 'headline' font only".`);
    expect(referenceGuide([{ role: "style", note: "   " }], { hasSource: true })).not.toContain("User note");
  });

  it("offers six roles, each with a label and a hint", () => {
    expect(REF_ROLES.map((r) => r.id)).toEqual(["general", "style", "typography", "identity", "object", "composition"]);
    for (const r of REF_ROLES) {
      expect(r.label.length).toBeGreaterThan(1);
      expect(r.hint.length).toBeGreaterThan(5);
    }
  });

  it("fits references to the engine's limit, after the app's own images", () => {
    const refs = ["a", "b", "c", "d"];
    // Grok: 3 images in all, one of them the source → two references.
    expect(referencesThatFit(refs, 3, 1)).toEqual(["a", "b"]);
    // A fill also sends the full-picture context: source + context → one reference.
    expect(referencesThatFit(refs, 3, 2)).toEqual(["a"]);
    expect(referencesThatFit(refs, 8, 1)).toEqual(refs);
    // No limit declared → nothing is cut.
    expect(referencesThatFit(refs, undefined, 1)).toEqual(refs);
    expect(referencesThatFit(refs, 1, 2)).toEqual([]);
  });
});

// ---- wiring: a guide nobody sends changes nothing -----------------------------------------
import { readFileSync } from "node:fs";

const STORE = readFileSync("src/state/store.ts", "utf8");

/** One store action's body, comments stripped (same helper as docFlags.test). */
function actionBody(name: string): string {
  const plain = STORE.indexOf(`  ${name}(`);
  const start = plain >= 0 ? plain : STORE.indexOf(`  async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = STORE.slice(start + 1);
  const end = rest.search(/\n {2}(?:async )?[a-zA-Z]\w*[(:]/);
  return rest
    .slice(0, end > 0 ? end : rest.length)
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

describe("references on their way out", () => {
  const gen = actionBody("generate");

  it("the guide goes in front of the user's text, for the references actually sent", () => {
    expect(gen).toMatch(/const sentRefs = referencesThatFit\(references, provider\.capabilities\?\.maxReferenceImages, reservedImages\)/);
    expect(gen).toMatch(/const guide = referenceGuide\(sentRefs, \{ hasSource \}\)/);
    expect(gen).toMatch(/if \(guide\) sendPrompt = `\$\{guide\}\\n\$\{sendPrompt\}`\.trim\(\)/);
    // Text-to-image has no picture of its own; a fill keeps a slot for its context view.
    expect(gen).toMatch(/const hasSource = mode !== "generate"/);
    expect(gen).toMatch(/\(hasSource \? 1 : 0\) \+ \(mode === "fill" \? 1 : 0\)/);
  });

  it("both request sites send the guided prompt and the capped list — never the raw ones", () => {
    expect(gen.match(/sentRefs\.map\(\(r\) => \(\{ src: r\.src, role: r\.role, note: r\.note \}\)\)/g)?.length).toBe(2);
    expect(gen).not.toMatch(/[^t]references\.map\(\(r\) => \(\{ src: r\.src/);
    expect(gen.match(/prompt: sendPrompt \|\| undefined/g)?.length).toBe(2);
  });

  it("says so when the engine's limit leaves references behind", () => {
    expect(gen).toMatch(/sentRefs\.length < references\.length/);
    expect(gen).toMatch(/let warning: string \| null = refWarning/);
  });

  it("run-all hands the references along with the rest", () => {
    const run = actionBody("runAllDocs");
    expect(run).toMatch(/settings: \{ \.\.\.st\.settings \}, references: \[\.\.\.st\.references\]/);
    // …but never a tab's own canvas back to itself.
    expect(run).toMatch(/references: shared\.references\.filter\(\(r\) => r\.fromDocId !== docId\)/);
  });

  it("a promoted image is neutral — 'identity' now really means 'the same person'", () => {
    const chat = readFileSync("src/ui/ChatDock.tsx", "utf8");
    expect(chat).not.toMatch(/addReference\([^)]*"identity"\)/);
    expect(chat.match(/addReference\(a\.full, "general"\)/g)?.length).toBe(2);
    // The skill flow reads the reference list right after adding; adding is async now.
    expect(chat).toMatch(/await Promise\.all\(refs\.map\(\(a\) => addReference\(a\.full, "general"\)\)\)/);
  });

  it("stores a reference downsized, in the tab it was added to", () => {
    expect(STORE).toMatch(/const fit = await downscaleToMax\(src, REF_MAX_EDGE\)/);
    expect(STORE).toMatch(/const REF_MAX_EDGE = 2048/);
  });
});
