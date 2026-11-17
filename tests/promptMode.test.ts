import { describe, it, expect } from "vitest";
import { modeLabel, DOCK_MODES } from "../shared/modes";
import type { GenerationMode } from "../shared/types";

const ASK_MODES = DOCK_MODES;

describe("writing a prompt for a chosen mode", () => {
  it("every offered mode has a label — an unnamed option in the menu is unusable", () => {
    for (const m of ASK_MODES) {
      expect(modeLabel(m)).toBeTruthy();
      expect(modeLabel(m)).not.toBe(m);
    }
  });

  it("the modes offered are the ones the dock actually runs", () => {
    // Mirrors PromptBar's MODES. "expand" is a separate canvas flow, not a dock mode.
    expect(ASK_MODES).not.toContain("expand" as GenerationMode);
    expect(ASK_MODES).toContain("recreate");
    expect(ASK_MODES).toContain("upscale");
  });
});

// The guide text is what steered a rebuild request into a sharpening prompt, so its
// wording is worth pinning: upscale must stay about detail, and recreate about content.
describe("the mode guides stay distinct", () => {
  const GUIDE: Record<string, string> = {
    upscale: "המצב הנוכחי אפסקייל: הפרומפט על פרטים וחדות בלבד — לא על תוכן, קומפוזיציה או צבע.",
    recreate: "המצב הנוכחי יצירה מחדש: שיפור איכות תוך שמירה על הקומפוזיציה, הזווית, הצבעים וזהות הנושא.",
  };

  it("upscale asks for sharpness and explicitly not content", () => {
    expect(GUIDE.upscale).toContain("חדות");
    expect(GUIDE.upscale).toContain("לא על תוכן");
  });

  it("recreate is the one that may touch the picture itself", () => {
    expect(GUIDE.recreate).not.toContain("לא על תוכן");
  });

  it("the two are not interchangeable — that is the point of choosing", () => {
    expect(GUIDE.upscale).not.toBe(GUIDE.recreate);
  });
});
