// Full-resolution originals of photos too big to work on whole.
//
// Opening a picture over 4096px asks: shrink it, or cut a piece. A piece is cut from the
// original at full resolution, and its export can put it back into a copy of that
// original. Both need the original's pixels in the renderer — served on demand through a
// protocol rather than as a data URL: 86MB of image bytes as a base64 string over IPC is
// what used to make big files fail to open.
//
// The renderer never names a path. It gets an opaque token per registered file, and the
// protocol serves only those, so a renderer bug cannot turn into "read any file".

import { app, nativeImage, net, protocol } from "electron";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { OriginalRef, Project } from "../../shared/types.js";

import { ORIGINAL_SCHEME } from "../../shared/originalUrl.js";
export { ORIGINAL_SCHEME };

/** Formats Chromium can decode. A TIFF cannot be served to a canvas, so it is not kept. */
const DECODABLE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".bmp": "image/bmp",
};

const tokenToPath = new Map<string, string>();
const pathToToken = new Map<string, string>();

/** Must run before `app.whenReady`. CORS-enabled so a canvas that draws an original stays
 *  readable (toDataURL) — without it every export would throw "tainted canvas". */
export function registerOriginalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ORIGINAL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

export function handleOriginalProtocol(): void {
  protocol.handle(ORIGINAL_SCHEME, async (req) => {
    const token = decodeURIComponent(new URL(req.url).pathname.replace(/^\/+/, ""));
    const file = tokenToPath.get(token);
    if (!file || !existsSync(file)) return new Response("not found", { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    return new Response(res.body, {
      status: 200,
      headers: {
        "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
    });
  });
}

/** Make a file servable and say how big it really is. */
export function registerOriginal(file: string, dims?: { width: number; height: number }): OriginalRef {
  const abs = path.resolve(file);
  const ext = path.extname(abs).toLowerCase();
  if (!DECODABLE.has(ext)) throw new Error(`לא ניתן לשמור מקור בפורמט ${ext}`);
  if (!existsSync(abs)) throw new Error("קובץ המקור לא נמצא");
  let size = dims;
  if (!size || !size.width || !size.height) {
    const img = nativeImage.createFromPath(abs);
    if (img.isEmpty()) throw new Error("לא ניתן לפענח את קובץ המקור");
    size = img.getSize();
  }
  let token = pathToToken.get(abs);
  if (!token) {
    token = randomUUID();
    pathToToken.set(abs, token);
    tokenToPath.set(token, abs);
  }
  return { path: abs, width: size.width, height: size.height, token };
}

/** An image with no file behind it (pasted, dropped from a browser) is kept as a copy in
 *  the app's own folder, so it can be served the same way. Named by content, so the same
 *  picture pasted twice is stored once. */
export async function keepOriginal(dataUrl: string): Promise<OriginalRef> {
  const m = /^data:(image\/[a-z+.-]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("נתוני תמונה לא תקינים");
  const buf = Buffer.from(m[2], "base64");
  const ext = m[1] === "image/jpeg" ? ".jpg" : m[1] === "image/webp" ? ".webp" : ".png";
  const dir = path.join(app.getPath("userData"), "originals");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, createHash("sha256").update(buf).digest("hex").slice(0, 24) + ext);
  if (!existsSync(file)) await fs.writeFile(file, buf);
  const img = nativeImage.createFromBuffer(buf);
  return registerOriginal(file, img.isEmpty() ? undefined : img.getSize());
}

/** Re-register the original a piece project refers to, as it is opened. Tokens are
 *  per-session, so the one saved in the file means nothing now. A file that is gone is
 *  marked — the piece still opens and works; only putting it back needs the original, and
 *  the user is told and can point at it again.
 *
 *  Only image files are honoured, so a hand-edited project cannot make the protocol serve
 *  anything that is not a picture. */
export function attachProjectOriginals(project: Project): Project {
  const o = project.pieceSource?.original;
  if (!o?.path) return project;
  try {
    project.pieceSource!.original = { ...registerOriginal(o.path, { width: o.width, height: o.height }), missing: false };
  } catch {
    project.pieceSource!.original = { path: o.path, width: o.width, height: o.height, missing: true };
  }
  return project;
}
