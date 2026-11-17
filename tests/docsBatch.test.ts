import { describe, it, expect } from "vitest";
import { uniqueExportName } from "../src/state/docs";
import { isGranted } from "../shared/pathGuard";
import { MAX_OPEN_AT_ONCE } from "../shared/ipc";

describe("uniqueExportName", () => {
  it("keeps the opened name, minus its extension", () => {
    const used = new Set<string>();
    expect(uniqueExportName("cat.jpg", used)).toBe("cat");
    expect(uniqueExportName("dog.PNG", used)).toBe("dog");
  });

  it("suffixes a repeat instead of overwriting the earlier file", () => {
    const used = new Set<string>();
    expect(uniqueExportName("cat", used)).toBe("cat");
    expect(uniqueExportName("cat", used)).toBe("cat (2)");
    expect(uniqueExportName("cat", used)).toBe("cat (3)");
  });

  it("treats names that differ only in case as the same file", () => {
    // Two tabs writing "Cat.png" and "cat.png" into one folder is one file on macOS.
    const used = new Set<string>();
    expect(uniqueExportName("Cat", used)).toBe("Cat");
    expect(uniqueExportName("cat", used)).toBe("cat (2)");
  });

  it("names an untitled project rather than writing '.png'", () => {
    expect(uniqueExportName("", new Set())).toBe("ללא שם");
  });
});

describe("isGranted — what the renderer is allowed to name", () => {
  const roots = ["/data/photos"];
  const files = ["/elsewhere/one.png", "/elsewhere/two.png"];

  it("allows a file that was picked in the dialog", () => {
    expect(isGranted([], files, "/elsewhere/one.png")).toBe(true);
    expect(isGranted([], files, "/elsewhere/./two.png")).toBe(true);
  });

  it("refuses a sibling that was NOT picked", () => {
    expect(isGranted([], files, "/elsewhere/three.png")).toBe(false);
    expect(isGranted([], files, "/etc/passwd")).toBe(false);
  });

  it("still honours a granted folder", () => {
    expect(isGranted(roots, [], "/data/photos/a/b.png")).toBe(true);
    expect(isGranted(roots, [], "/data/photos-private/b.png")).toBe(false);
  });

  it("refuses a climb out of a granted folder", () => {
    expect(isGranted(roots, [], "/data/photos/../secrets.txt")).toBe(false);
  });

  it("grants nothing when nothing was picked", () => {
    expect(isGranted([], [], "/anything.png")).toBe(false);
  });
});

describe("the multi-open cap", () => {
  it("is one shared number, so the dialog and the message cannot disagree", () => {
    expect(MAX_OPEN_AT_ONCE).toBe(10);
  });
});

// --- what may run, and what must never be sent -------------------------------
import { docRunBlocker, RUN_BLOCK_LABEL } from "../src/state/docs";
import type { DocSlice } from "../src/state/docs";

const emptyMask = { strokes: [], rects: [], bitmaps: [], inverted: false };
const slice = (over: Partial<DocSlice> = {}) =>
  ({
    project: { id: "p", name: "x", layers: [] },
    busy: false,
    mode: "recreate",
    prompt: "",
    mask: emptyMask,
    ...over,
  }) as unknown as DocSlice;

describe("docRunBlocker", () => {
  it("blocks a freshly opened tab — the exact state that fired nine empty requests", () => {
    // initialDoc() opens every tab in "generate" with no prompt. Run-all used to send
    // these to the engine, where they failed one by one and cost money.
    expect(docRunBlocker(slice({ mode: "generate", prompt: "" }))).toBe("empty-prompt");
    expect(docRunBlocker(slice({ mode: "generate", prompt: "   " }))).toBe("empty-prompt");
  });

  it("allows a generate that actually has a prompt", () => {
    expect(docRunBlocker(slice({ mode: "generate", prompt: "a red mug" }))).toBeNull();
  });

  it("blocks a fill with nothing marked, and allows one with a mask", () => {
    expect(docRunBlocker(slice({ mode: "fill" }))).toBe("no-mask");
    expect(docRunBlocker(slice({ mode: "fill", mask: { ...emptyMask, rects: [{}] } as never }))).toBeNull();
    // "inverted" alone means the whole canvas outside nothing — still a real selection.
    expect(docRunBlocker(slice({ mode: "fill", mask: { ...emptyMask, inverted: true } }))).toBeNull();
  });

  it("allows image-to-image modes with no prompt at all — the prompt is optional there", () => {
    for (const mode of ["removebg", "recreate", "upscale"] as const) {
      expect(docRunBlocker(slice({ mode }))).toBeNull();
    }
  });

  it("blocks an empty tab and one that is already rendering", () => {
    expect(docRunBlocker(slice({ project: null }))).toBe("no-project");
    expect(docRunBlocker(slice({ busy: true }))).toBe("busy");
  });

  it("has a readable label for every blocker, so a skip can be explained", () => {
    for (const k of ["no-project", "busy", "empty-prompt", "no-mask"] as const) {
      expect(RUN_BLOCK_LABEL[k]).toBeTruthy();
    }
  });

  it("re-answers once the current tab's settings are applied over a blocked tab", () => {
    // This is what scope "current" does: a blank generate tab becomes runnable because
    // it adopts the visible tab's mode.
    const blocked = slice({ mode: "generate", prompt: "" });
    expect(docRunBlocker(blocked)).toBe("empty-prompt");
    expect(docRunBlocker({ ...blocked, mode: "removebg" } as DocSlice)).toBeNull();
  });
});
