// A small error log on disk, for the reports nobody can reproduce: what went wrong, and
// when, on the machine it went wrong on. One file, kept under a size cap — when it grows
// past it the old file is moved aside (one generation) and a new one starts.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

export const LOG_MAX_BYTES = 1_000_000;

export function appendLog(dir: string, line: string, maxBytes = LOG_MAX_BYTES): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "mbrush.log");
    if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, path.join(dir, "mbrush.old.log"));
    appendFileSync(file, `${new Date().toISOString()} ${line.replace(/\s+$/, "")}\n`);
  } catch {
    // Logging must never be the thing that breaks the app.
  }
}
