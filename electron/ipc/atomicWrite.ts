// Writing a file so that it is either the old version or the new one — never half of each.
//
// `fs.writeFile` truncates the target first and then fills it. A crash, a full disk or a
// power cut in between leaves a file that is neither: for a project that is the user's
// only copy of the work, and for the key store it is every key at once. Here the bytes go
// to a temporary file next to the target, are flushed to disk, and only then replace the
// target with a rename — which the filesystem does in one step.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface AtomicWriteOptions {
  /** File mode for a newly created file (e.g. 0o600 for secrets). */
  mode?: number;
  encoding?: BufferEncoding;
  /** Keep the version being replaced as `<file>.bak` (one generation). */
  backup?: boolean;
  /** Test seam: runs after the data is on disk, before it replaces the target. */
  beforeRename?: () => void | Promise<void>;
}

export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(file);
  // Same folder as the target: a rename across filesystems is a copy, not an atomic step.
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmp, "w", opts.mode ?? 0o666);
    if (typeof data === "string") await handle.writeFile(data, opts.encoding ?? "utf8");
    else await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await opts.beforeRename?.();
    if (opts.backup) await keepBackup(file);
    await fs.rename(tmp, file);
  } catch (e) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** The current file, kept as `<file>.bak` before it is replaced. A hard link costs nothing
 *  and is instant even for a 500MB project; where links are not possible (some network or
 *  FAT drives) it is copied. A backup that cannot be made does not stop the save. */
async function keepBackup(file: string): Promise<void> {
  const bak = `${file}.bak`;
  try {
    await fs.access(file);
  } catch {
    return; // nothing to back up yet
  }
  await fs.rm(bak, { force: true }).catch(() => {});
  try {
    await fs.link(file, bak);
  } catch {
    await fs.copyFile(file, bak).catch(() => {});
  }
}
