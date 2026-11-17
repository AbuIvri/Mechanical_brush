// The debug folder: where it is, whether to write to it, and keeping it from growing
// without end. The rules themselves are in shared/debugPrune.ts.

import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { debugDumpsEnabled, pickForPruning } from "../shared/debugPrune.js";

const MARKER = ".cap-start";
const PRUNE_EVERY_MS = 10 * 60 * 1000;
let lastPrune = 0;

export function debugEnabled(): boolean {
  return debugDumpsEnabled(app.isPackaged, process.env);
}

/** The folder, created, or null when dumps are off — callers write nothing then. */
export async function debugDir(): Promise<string | null> {
  if (!debugEnabled()) return null;
  const dir = path.join(app.getPath("userData"), "debug");
  await fs.mkdir(dir, { recursive: true });
  void pruneDebug(dir);
  return dir;
}

/** Delete the oldest capped dumps once they pass the cap. Runs at most every ten minutes,
 *  and never touches a file older than the marker written the first time this ran. */
async function pruneDebug(dir: string): Promise<void> {
  const now = Date.now();
  if (now - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = now;
  try {
    const marker = path.join(dir, MARKER);
    let capStart: number;
    try {
      capStart = (await fs.stat(marker)).mtimeMs;
    } catch {
      await fs.writeFile(marker, "Dumps written after this file was created are capped; older ones are left alone.\n");
      capStart = (await fs.stat(marker)).mtimeMs;
    }
    const files = [];
    for (const name of await fs.readdir(dir)) {
      if (name === MARKER) continue;
      const st = await fs.stat(path.join(dir, name)).catch(() => null);
      if (st?.isFile()) files.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    }
    for (const name of pickForPruning(files, capStart)) await fs.rm(path.join(dir, name), { force: true });
  } catch (e) {
    console.warn("[debug] prune failed:", e);
  }
}
