import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendLog } from "../electron/log";

describe("error log", () => {
  it("appends timestamped lines and moves a full file aside", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mbrush-log-"));
    try {
      appendLog(dir, "first", 40);
      appendLog(dir, "second", 40);
      const log = readFileSync(path.join(dir, "mbrush.log"), "utf8");
      expect(log).toMatch(/^\d{4}-\d\d-\d\dT.* first\n.* second\n$/);
      appendLog(dir, "third", 40); // the file is now past 40 bytes: rotate
      expect(existsSync(path.join(dir, "mbrush.old.log"))).toBe(true);
      expect(readFileSync(path.join(dir, "mbrush.log"), "utf8")).toMatch(/ third\n$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws, even when it cannot write", () => {
    expect(() => appendLog("/dev/null/nope", "x")).not.toThrow();
  });
});
