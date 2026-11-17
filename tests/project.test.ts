import { describe, it, expect } from "vitest";
import { serializeProject, deserializeProject } from "../electron/project/ProjectSerializer";
import type { Project } from "../shared/types";

function sampleProject(): Project {
  return {
    id: "p1",
    name: "demo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas: { width: 100, height: 80, backgroundColor: "#fff" },
    layers: [
      {
        id: "l1",
        name: "base",
        type: "base",
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: "normal",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        src: "data:image/png;base64,AAAA",
        metadata: { createdAt: "2026-01-01T00:00:00.000Z" },
      },
    ],
    references: [],
    promptHistory: [],
    jobs: [],
    settings: { defaultProviderId: "umage2", autosave: false },
  };
}

describe("ProjectSerializer", () => {
  it("round-trips a project preserving layers and canvas", () => {
    const p = sampleProject();
    const restored = deserializeProject(serializeProject(p));
    expect(restored.canvas.width).toBe(100);
    expect(restored.layers).toHaveLength(1);
    expect(restored.layers[0].type).toBe("base");
  });

  it("rejects non-mbrush content", () => {
    expect(() => deserializeProject(JSON.stringify({ hello: "world" }))).toThrow();
  });

  it("rejects corrupt JSON", () => {
    expect(() => deserializeProject("{not json")).toThrow();
  });

  it("never embeds API keys", () => {
    const out = serializeProject(sampleProject());
    expect(out.toLowerCase()).not.toContain("sk-");
    expect(out).not.toContain("apiKey");
  });
});
