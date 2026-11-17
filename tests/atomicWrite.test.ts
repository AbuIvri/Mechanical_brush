import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../electron/ipc/atomicWrite";

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "atomic-"));

describe("writeFileAtomic", () => {
  it("writes a new file", async () => {
    const f = path.join(tmpDir(), "a.json");
    await writeFileAtomic(f, '{"a":1}');
    expect(readFileSync(f, "utf8")).toBe('{"a":1}');
  });

  it("replaces an existing file and leaves no temp file behind", async () => {
    const d = tmpDir();
    const f = path.join(d, "a.json");
    writeFileSync(f, "old");
    await writeFileAtomic(f, "new");
    expect(readFileSync(f, "utf8")).toBe("new");
    expect(readdirSync(d)).toEqual(["a.json"]);
  });

  it("a failure before the replace keeps the old file whole and cleans up", async () => {
    const d = tmpDir();
    const f = path.join(d, "project.mbrush");
    writeFileSync(f, "the only copy of the work");
    await expect(
      writeFileAtomic(f, "half-written", {
        beforeRename: () => {
          throw new Error("power cut");
        },
      }),
    ).rejects.toThrow("power cut");
    expect(readFileSync(f, "utf8")).toBe("the only copy of the work");
    expect(readdirSync(d)).toEqual(["project.mbrush"]);
  });

  it("keeps the replaced version as .bak when asked", async () => {
    const d = tmpDir();
    const f = path.join(d, "p.mbrush");
    writeFileSync(f, "v1");
    await writeFileAtomic(f, "v2", { backup: true });
    await writeFileAtomic(f, "v3", { backup: true });
    expect(readFileSync(f, "utf8")).toBe("v3");
    expect(readFileSync(`${f}.bak`, "utf8")).toBe("v2");
  });

  it("no .bak for a file that did not exist, or when not asked", async () => {
    const d = tmpDir();
    const f = path.join(d, "p.mbrush");
    await writeFileAtomic(f, "v1", { backup: true });
    expect(existsSync(`${f}.bak`)).toBe(false);
    await writeFileAtomic(f, "v2");
    expect(existsSync(`${f}.bak`)).toBe(false);
  });

  it("creates secret files with the requested mode", async () => {
    if (process.platform === "win32") return;
    const f = path.join(tmpDir(), "credentials.enc.json");
    await writeFileAtomic(f, "{}", { mode: 0o600 });
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("writes binary data unchanged", async () => {
    const f = path.join(tmpDir(), "b.bin");
    const bytes = Uint8Array.from([0, 255, 10, 13, 128]);
    await writeFileAtomic(f, bytes);
    expect([...readFileSync(f)]).toEqual([...bytes]);
  });
});
