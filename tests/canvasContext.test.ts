import { describe, it, expect } from "vitest";
import { annotationNote, canvasNote, describeRegion } from "../src/ui/canvasContext";
import type { Project } from "../shared/types";

const project = (width: number, height: number) =>
  ({ canvas: { width, height } } as unknown as Project);

describe("describeRegion", () => {
  it("places a centred box", () => {
    // A crop tells the model what; this has to tell it where.
    const s = describeRegion({ x: 250, y: 200, w: 500, h: 300 }, 1000, 1000);
    expect(s).toContain("25%–75% לרוחב");
    expect(s).toContain("20%–50% לגובה");
    expect(s).toContain("15%"); // 500*300 / 1000*1000
  });

  it("places a corner box", () => {
    const s = describeRegion({ x: 0, y: 0, w: 100, h: 50 }, 1000, 500);
    expect(s).toContain("0%–10% לרוחב");
    expect(s).toContain("0%–10% לגובה");
  });

  it("reports a whole-canvas box as covering everything", () => {
    const s = describeRegion({ x: 0, y: 0, w: 800, h: 600 }, 800, 600);
    expect(s).toContain("0%–100% לרוחב");
    expect(s).toContain("100% משטח התמונה");
  });
});

describe("canvasNote", () => {
  it("gives the canvas size and says there is no marking", () => {
    const note = canvasNote(project(1920, 1080), null);
    expect(note).toContain("1920×1080");
    expect(note).toContain("אין אזור מסומן");
    expect(note).not.toContain("שתי תמונות");
  });

  it("explains both images and where the marked one sits", () => {
    const note = canvasNote(project(1000, 1000), { x: 250, y: 200, w: 500, h: 300 });
    expect(note).toContain("1000×1000");
    expect(note).toContain("שתי התמונות הראשונות");
    expect(note).toContain("25%–75% לרוחב");
  });
});

describe("annotationNote", () => {
  it("says the marks are instructions and must not reach the image", () => {
    const note = annotationNote(3);
    expect(note).toContain("3 סימונים");
    expect(note).toContain("הוראות");
    expect(note).toContain("לא חלק");
    expect(note).toContain("אל תתאר אותם");
  });
});

// --- the canvas is the starting point, and the user's images come after it ---------
describe("canvasNote with the user's own images after the canvas", () => {
  it("says nothing extra when the canvas travelled alone", () => {
    const note = canvasNote(project(800, 600), null, 0);
    expect(note).toContain("התמונה הראשונה היא הקנבס");
    expect(note).not.toContain("המשתמש צירף בעצמו");
  });

  it("names one attached image, so it is not read as more canvas", () => {
    const note = canvasNote(project(800, 600), null, 1);
    expect(note).toContain("עוד תמונה אחת שהמשתמש צירף בעצמו");
    expect(note).toContain("לא חלק ממנו");
  });

  it("counts several, in the plural", () => {
    const note = canvasNote(project(800, 600), null, 3);
    expect(note).toContain("עוד 3 תמונות שהמשתמש צירף בעצמו");
  });

  it("keeps the marked-region explanation alongside the user's images", () => {
    const note = canvasNote(project(1000, 1000), { x: 250, y: 200, w: 500, h: 300 }, 2);
    expect(note).toContain("שתי התמונות הראשונות הן הקנבס");
    expect(note).toContain("25%–75% לרוחב");
    expect(note).toContain("עוד 2 תמונות");
  });

  it("describes no canvas when no project is open — generating from scratch", () => {
    expect(canvasNote(null, null, 0)).toBe("");
    expect(canvasNote(null, null, 2)).toContain("אין פרויקט פתוח");
  });
});
