// Series data access: scanning a folder of subjects, reading its spreadsheet, and
// reading its images.
//
// Everything here is confined to a root the USER picked in a native dialog. The
// renderer can name a path, but it cannot reach outside that root — a renderer bug, or
// a crafted value inside a spreadsheet, must not become "read any file on this machine".

import { dialog, BrowserWindow, nativeImage } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DatasetImage, DatasetScan, OriginalRef, SheetData } from "../../shared/types.js";
import { registerOriginal } from "./originals.js";
import { docxToText } from "./docx.js";
import { parseDelimited } from "../../shared/sheetParse.js";
import { isGranted } from "../../shared/pathGuard.js";
import { MAX_OPEN_AT_ONCE } from "../../shared/ipc.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);
const SHEET_EXT = new Set([".csv", ".tsv"]);
/** A sanity ceiling on reading a file into memory at all — not a working limit. Anything
 *  under it that decodes is downscaled here before it crosses IPC, so a 90MB photo opens
 *  like any other; this only stops a pathological file from taking the process down. */
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;
/** The renderer downscales every import to this anyway. Doing it here too means the huge
 *  original never becomes a base64 string — which is what actually costs memory: 86MB of
 *  bytes is a ~115MB string on top of the buffer, per file, before anything is drawn. */
const IMPORT_MAX_EDGE = 4096;

/** Roots the user has explicitly granted this session, by picking them in a dialog. */
const allowedRoots = new Set<string>();
/** Individual files granted the same way — by being selected in an open dialog. The
 *  multi-file open returns paths rather than ten images' worth of base64 at once, so
 *  the renderer names each file back to us; this is what stops it naming any other. */
const allowedFiles = new Set<string>();

function normalize(p: string): string {
  return path.resolve(p);
}

function assertAllowed(target: string): void {
  if (isGranted(allowedRoots, allowedFiles, target)) return;
  throw new Error("הקובץ נמצא מחוץ למה שנבחר");
}

export interface PickedFile {
  path: string;
  name: string;
}

/** Pick several images at once. Selecting them IS the grant of access — the same rule
 *  as pickRoot. Returns paths only; readImageFile hands over one image at a time. */
export async function pickImages(): Promise<{ files: PickedFile[]; skipped: number }> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const opts = {
    properties: ["openFile" as const, "multiSelections" as const],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "tiff", "tif", "bmp"] }],
  };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled) return { files: [], skipped: 0 };
  const all = r.filePaths;
  const take = all.slice(0, MAX_OPEN_AT_ONCE);
  for (const f of take) allowedFiles.add(normalize(f));
  return {
    files: take.map((f) => ({ path: f, name: path.basename(f) })),
    skipped: all.length - take.length,
  };
}

/** Ask for the dataset root. Picking it is what grants access to everything under it. */
/** A prompt list's text, with its folder granted — its prompts can name reference images
 *  that sit next to it ("@logo.png"), and those are read with readImageFile like any
 *  other granted file. The folder is granted because the user picked or dropped the list. */
export async function readPromptFile(file: string): Promise<{ path: string; dir: string; text: string }> {
  const abs = normalize(file);
  const isDocx = /\.docx$/i.test(abs);
  if (!isDocx && !/\.(txt|md|text)$/i.test(abs)) throw new Error("רשימת פרומפטים צריכה להיות קובץ טקסט (.txt) או מסמך Word (.docx)");
  const st = await fs.stat(abs);
  if (st.size > (isDocx ? 20 : 2) * 1024 * 1024) throw new Error("הקובץ גדול מדי לרשימת פרומפטים");
  const dir = path.dirname(abs);
  allowedRoots.add(dir);
  const text = isDocx ? docxToText(await fs.readFile(abs)) : await fs.readFile(abs, "utf8");
  return { path: abs, dir, text };
}

export async function pickRoot(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const opts = { properties: ["openDirectory" as const] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const dir = r.canceled ? null : r.filePaths[0] ?? null;
  if (dir) allowedRoots.add(normalize(dir));
  return dir;
}

async function listImages(dir: string): Promise<DatasetImage[]> {
  const out: DatasetImage[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    const p = path.join(dir, e.name);
    const st = await fs.stat(p);
    out.push({ name: e.name, path: p, bytes: st.size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "he"));
}

/** One level of subfolders: each is a subject, its images are that subject's material. */
export async function scanDataset(root: string): Promise<DatasetScan> {
  assertAllowed(root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const folders = [];
  const sheets = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      folders.push({ name: e.name, path: p, images: await listImages(p) });
    } else if (SHEET_EXT.has(path.extname(e.name).toLowerCase())) {
      sheets.push({ name: e.name, path: p });
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, "he"));
  return { root, folders, sheets, looseImages: await listImages(root) };
}

/** Read a spreadsheet. CSV/TSV only, parsed in-process — reading .xlsx would mean
 *  shipping a workbook library (and its zip-writer dependency tree) with the app, which
 *  is not worth it for a format Excel exports to CSV in one click. */
export async function readSheet(file: string): Promise<SheetData> {
  assertAllowed(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") {
    throw new Error("קובצי אקסל לא נתמכים — שמור את הגיליון כ-CSV (קובץ ← שמירה בשם ← CSV UTF-8)");
  }
  if (ext !== ".csv" && ext !== ".tsv") throw new Error(`סוג גיליון לא נתמך: ${ext}`);
  return parseDelimited(await fs.readFile(file, "utf8"), ext === ".tsv" ? "\t" : ",");
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
};

/** Does the bitmap actually use its alpha channel? Chromium hands back BGRA whatever the
 *  source was, so "it is a PNG" says nothing — only the pixels do. Worth the scan: a photo
 *  wrongly kept as PNG is several times the bytes of the same photo as JPEG. */
function usesAlpha(bmp: Buffer): boolean {
  for (let i = 3; i < bmp.length; i += 4) if (bmp[i] !== 255) return true;
  return false;
}

/** One image as a data URL, downscaled to `IMPORT_MAX_EDGE` on the way out.
 *
 *  Nothing is lost by shrinking here — the renderer applies the same limit the moment the
 *  data URL arrives. What is gained is that the full-size original never has to survive as
 *  base64, which is the difference between a 90MB file opening and failing. */
export async function toImageDataUrl(file: string): Promise<string> {
  return (await toImageImport(file)).dataUrl;
}

/** The same, plus — when the picture was shrunk — the original it came from, registered
 *  so a full-resolution piece can be cut from it and the export can use it. */
export async function toImageImport(file: string): Promise<{ dataUrl: string; original?: OriginalRef }> {
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`סוג קובץ לא נתמך: ${ext}`);
  const st = await fs.stat(file);
  if (st.size > MAX_IMAGE_BYTES) throw new Error(`הקובץ גדול מדי (${Math.round(st.size / 1e6)}MB)`);
  const buf = await fs.readFile(file);

  // Only formats Chromium can decode take this path. A TIFF returns an empty image here,
  // and is handed over untouched exactly as before — the renderer could not open it either
  // way, so this is not the place to start failing it.
  const img = nativeImage.createFromBuffer(buf);
  if (!img.isEmpty()) {
    const { width, height } = img.getSize();
    const long = Math.max(width, height);
    if (long > IMPORT_MAX_EDGE) {
      const scale = IMPORT_MAX_EDGE / long;
      const small = img.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: "best",
      });
      const dataUrl = usesAlpha(small.getBitmap())
        ? `data:image/png;base64,${small.toPNG().toString("base64")}`
        : `data:image/jpeg;base64,${small.toJPEG(92).toString("base64")}`;
      let original: OriginalRef | undefined;
      try {
        original = registerOriginal(file, { width, height });
      } catch {
        // A format the canvas cannot read back — the shrunk copy is all there will be.
      }
      return { dataUrl, original };
    }
  }
  return { dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
}

/** The same, for a path the user granted us by picking it in a dialog. */
export async function readImageFile(file: string): Promise<{ dataUrl: string; original?: OriginalRef }> {
  assertAllowed(file);
  return toImageImport(file);
}
