import { CHAT_MS } from "../providers/timeouts.js";
import { describeError } from "../../shared/errors.js";
import { requestBytes } from "../../shared/payload.js";
import { attachProjectOriginals, keepOriginal, registerOriginal } from "./originals.js";
import { writeFileAtomic } from "./atomicWrite.js";
import { debugDir } from "../debugDump.js";
import { LEGACY_SLOT, isSlotId, sortSlots, keepDiscardedSlots, discardedName, discardedToPrune, type AutosaveSlot } from "../../shared/autosaveSlots.js";
import { ipcMain, dialog, BrowserWindow, app, shell, clipboard, nativeImage } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { IPC } from "../../shared/ipc.js";
import { registry } from "../providers/registry.js";
import { keyManager } from "../security/KeyManager.js";
import { serializeProject, deserializeProject } from "../project/ProjectSerializer.js";
import { licenseManager } from "../license/LicenseManager.js";
import {
  pickRoot,
  pickImages,
  readImageFile,
  readPromptFile,
  toImageImport,
  readSheet,
  scanDataset,
} from "./series.js";
import { addToMonth, backfillMonths } from "../../src/spend.js";
import type {
  BaseGenerationRequest,
  SpendData,
  SpendEntry,
  GenerationResult,
  IpcResult,
  Project,
} from "../../shared/types.js";

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}
function fail(error: unknown, uploadBytes = 0): IpcResult<never> {
  return { ok: false, error: describeError(error, uploadBytes) };
}


// --- Prompt-assistant chat: provider-agnostic payload + per-API adapters ---
export interface ChatPayload {
  provider: "openai" | "google" | "xai" | "anthropic";
  model: string;
  system: string;
  history: { role: "user" | "assistant"; text: string }[];
  /** Data-URL images attached to the LAST user message. */
  images?: string[];
}

function parseDataUrl(u: string): { mime: string; data: string } {
  const m = u.match(/^data:([^;]+);base64,(.*)$/);
  return m ? { mime: m[1], data: m[2] } : { mime: "image/png", data: u };
}

// Skill workflows send long templates to reasoning models, where the thinking
// tokens come out of the same budget — 900 left nothing for the visible answer.
const CHAT_MAX_TOKENS = 4000;

/** Empty completion: say WHY (length / filter / …) instead of a generic message. */
function emptyChatError(reason?: string): Error {
  if (reason === "length") {
    return new Error(
      "המודל נעצר באמצע (חריגה ממכסת הטוקנים) — קצר את הסקיל או בחר מודל אחר.",
    );
  }
  if (reason) return new Error(`לא התקבלה תשובה מהמודל (${reason})`);
  return new Error("לא התקבלה תשובה מהמודל");
}

async function runChat(p: ChatPayload, apiKey: string): Promise<string> {
  const lastUserIdx = p.history.map((m) => m.role).lastIndexOf("user");
  const imgs = p.images ?? [];

  if (p.provider === "openai" || p.provider === "xai") {
    const { OpenAI } = await import("openai");
    const client = new OpenAI({
      apiKey,
      ...(p.provider === "xai" ? { baseURL: "https://api.x.ai/v1" } : {}),
    });
    const messages: any[] = [{ role: "system", content: p.system }];
    p.history.forEach((m, i) => {
      if (m.role === "user" && i === lastUserIdx && imgs.length) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: m.text },
            ...imgs.map((u) => ({ type: "image_url", image_url: { url: u } })),
          ],
        });
      } else {
        messages.push({ role: m.role, content: m.text });
      }
    });
    // Newer OpenAI models (gpt-5 family) accept only max_completion_tokens;
    // older ones and xAI still use max_tokens. Send the right one.
    const tokenParam = /^(gpt-5|o\d)/.test(p.model) && p.provider === "openai"
      ? { max_completion_tokens: CHAT_MAX_TOKENS }
      : { max_tokens: CHAT_MAX_TOKENS };
    const r = await client.chat.completions.create({ model: p.model, messages, ...tokenParam } as any);
    const text = r.choices?.[0]?.message?.content?.trim();
    if (!text) throw emptyChatError(r.choices?.[0]?.finish_reason ?? undefined);
    return text;
  }

  if (p.provider === "anthropic") {
    const messages = p.history.map((m, i) => {
      if (m.role === "user" && i === lastUserIdx && imgs.length) {
        return {
          role: "user",
          content: [
            ...imgs.map((u) => {
              const { mime, data } = parseDataUrl(u);
              return { type: "image", source: { type: "base64", media_type: mime, data } };
            }),
            { type: "text", text: m.text },
          ],
        };
      }
      return { role: m.role, content: m.text };
    });
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(CHAT_MS),
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: p.model, max_tokens: CHAT_MAX_TOKENS, system: p.system, messages }),
    });
    const j: any = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j?.error?.message || `Claude נכשל (${resp.status})`);
    const text = (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    if (!text) throw emptyChatError(j?.stop_reason === "max_tokens" ? "length" : j?.stop_reason);
    return text;
  }

  // google (Gemini)
  const contents = p.history.map((m, i) => {
    const parts: any[] = [{ text: m.text }];
    if (m.role === "user" && i === lastUserIdx && imgs.length) {
      for (const u of imgs) {
        const { mime, data } = parseDataUrl(u);
        parts.push({ inline_data: { mime_type: mime, data } });
      }
    }
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(CHAT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: p.system }] },
        contents,
        generationConfig: { maxOutputTokens: CHAT_MAX_TOKENS },
      }),
    },
  );
  const j: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j?.error?.message || `Gemini נכשל (${resp.status})`);
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((x: any) => x.text ?? "").join("").trim();
  if (!text) {
    const fr = j.candidates?.[0]?.finishReason;
    throw emptyChatError(fr === "MAX_TOKENS" ? "length" : fr);
  }
  return text;
}

// --- Debug dump (development builds only): save what we SEND and what the model RETURNS, with
// pixel dimensions, so a fill/upscale generation can be inspected on its own. ---
function pngDims(buf: Buffer): string {
  if (buf.length > 24 && buf.toString("ascii", 12, 16) === "IHDR")
    return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
  return "unknown";
}
function dataUrlToBuf(s: string): Buffer {
  const i = s.indexOf(",");
  return Buffer.from(i >= 0 ? s.slice(i + 1) : s, "base64");
}
// Auto-archive every generated image as raw material in the user's Pictures
// folder under "פלט מהמכחול" — so nothing is ever lost, independent of saving.
/** Make a string safe as a single folder/file segment. */
function fsSafe(s: string | undefined, fallback = "unknown"): string {
  const clean = (s ?? "").replace(/[/\\:*?"<>|]/g, "-").trim();
  return clean || fallback;
}

async function archiveGenOutput(req: BaseGenerationRequest, result: GenerationResult) {
  try {
    if (!result.images?.length) return;
    // Nested per engine + model, so raw material is browsable by its source.
    const dir = path.join(
      app.getPath("pictures"),
      "פלט מהמכחול",
      fsSafe(req.providerId),
      fsSafe(result.modelId ?? req.modelId),
    );
    await fs.mkdir(dir, { recursive: true });
    const ts = new Date()
      .toISOString()
      .replace("T", "_")
      .replace(/:/g, "-")
      .replace(/\..+/, "");
    // Archive EVERY returned image (variations included), suffixed _1, _2, …
    for (let i = 0; i < result.images.length; i++) {
      const out = result.images[i];
      if (!out?.src) continue;
      const suffix = result.images.length > 1 ? `_${i + 1}` : "";
      const name = `${ts}_${req.mode}_${out.width}x${out.height}${suffix}.png`;
      await fs.writeFile(path.join(dir, name), dataUrlToBuf(out.src));
    }
  } catch (e) {
    console.warn("[gen-archive] failed:", e);
  }
}

async function dumpGenDebug(req: BaseGenerationRequest, result: GenerationResult) {
  try {
    // Development only (or MBRUSH_DEBUG=1), and capped: see electron/debugDump.ts.
    const dir = await debugDir();
    if (!dir) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const tag = `${req.mode}_${req.providerId}`;
    const lines: string[] = [];
    if (req.image) {
      const b = dataUrlToBuf(req.image);
      const p = path.join(dir, `${ts}_${tag}_SENT_${pngDims(b)}.png`);
      await fs.writeFile(p, b);
      lines.push(`SENT crop ${pngDims(b)} -> ${p}`);
    }
    const out = result.images?.[0];
    if (out?.src) {
      const b = dataUrlToBuf(out.src);
      const p = path.join(dir, `${ts}_${tag}_OUT_${out.width}x${out.height}.png`);
      await fs.writeFile(p, b);
      lines.push(`OUT raw ${out.width}x${out.height} (png ${pngDims(b)}) -> ${p}`);
    }
    console.log(`[gen-debug] ${tag}\n  ${lines.join("\n  ")}`);
  } catch (e) {
    console.warn("[gen-debug] dump failed:", e);
  }
}

// --- Cumulative spend tracking (persisted, never contains keys) ---
// Shapes come from shared/types: a local copy had already drifted from it once.
function spendFile() {
  return path.join(app.getPath("userData"), "spend.json");
}
async function readSpend(): Promise<SpendData> {
  try {
    const d = JSON.parse(await fs.readFile(spendFile(), "utf-8"));
    // A file written before months existed gets them seeded from its entries, once.
    return backfillMonths({
      total: d.total ?? 0,
      count: d.count ?? 0,
      entries: Array.isArray(d.entries) ? d.entries : [],
      months: d.months && typeof d.months === "object" ? d.months : undefined,
    });
  } catch {
    return { total: 0, count: 0, entries: [], months: {} };
  }
}
async function writeSpend(s: SpendData) {
  await writeFileAtomic(spendFile(), JSON.stringify(s), { mode: 0o600 });
}

// --- Recent projects (persisted, for the start gallery) ---
interface RecentEntry {
  path: string;
  name: string;
  thumbnail?: string;
  updatedAt: string;
  kind?: "project" | "image";
  /** Set once a picture's thumbnail has been remade square (or tried): not tried again. */
  thumbV?: number;
}
function recentsFile() {
  return path.join(app.getPath("userData"), "recents.json");
}
async function readRecents(): Promise<RecentEntry[]> {
  try {
    const arr = JSON.parse(await fs.readFile(recentsFile(), "utf-8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function writeRecents(list: RecentEntry[]) {
  await writeFileAtomic(recentsFile(), JSON.stringify(list), { mode: 0o600 });
}
async function addRecent(entry: RecentEntry): Promise<RecentEntry[]> {
  const list = (await readRecents()).filter((r) => r.path !== entry.path);
  list.unshift(entry);
  // The start screen is the whole history now, not a shortlist of twelve.
  const trimmed = list.slice(0, 500);
  await writeRecents(trimmed);
  return trimmed;
}

/** The gallery's square tile, as a JPEG cut from the middle of the picture — the same size
 *  the renderer makes (GALLERY_THUMB in compositing.ts). It used to be 280px on the LONG
 *  side, so a panorama's tile was a ~90px strip blown up. Undefined when the picture
 *  cannot be decoded here. */
const GALLERY_THUMB = 480;
const THUMB_V = 2;
function galleryThumb(img: Electron.NativeImage): string | undefined {
  if (img.isEmpty()) return undefined;
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  const out = Math.min(GALLERY_THUMB, side);
  const small = side > out ? square.resize({ width: out, height: out, quality: "best" }) : square;
  return `data:image/jpeg;base64,${small.toJPEG(84).toString("base64")}`;
}

/** The gallery lists the pictures worked on, not only saved projects: most work leaves the
 *  app as an exported image and is never saved as a .mbrush, so a gallery of projects
 *  alone stopped showing anything recent. Never fails what it rides along with. */
async function notePictureRecent(fp: string, buf?: Buffer): Promise<void> {
  try {
    const img = buf ? nativeImage.createFromBuffer(buf) : nativeImage.createFromPath(fp);
    await addRecent({
      path: fp,
      name: path.basename(fp).replace(/\.[^.]+$/, ""),
      thumbnail: galleryThumb(img),
      updatedAt: new Date().toISOString(),
      kind: "image",
      thumbV: THUMB_V,
    });
  } catch (e) {
    console.warn("[recents] could not note picture:", e);
  }
}

export function registerIpcHandlers() {
  ipcMain.handle(IPC.listProviders, async () => {
    try {
      return ok(registry.list());
    } catch (e) {
      return fail(e);
    }
  });

  // Copy a rendered image (data URL) straight to the system clipboard.
  ipcMain.handle(IPC.copyImage, (_e, dataUrl: string) => {
    try {
      clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });

  // ---- Autosave: a recovery slot per open document (see shared/autosaveSlots.ts) ----
  const autosaveDir = () => path.join(app.getPath("userData"), "autosave");
  /** The single slot of earlier versions: still listed, loaded and cleared. */
  const legacyFile = () => path.join(app.getPath("userData"), "autosave.mbrush");
  const legacyMeta = () => path.join(app.getPath("userData"), "autosave.meta.json");
  const slotFiles = (id: string) => {
    if (id === LEGACY_SLOT) return { file: legacyFile(), meta: legacyMeta() };
    if (!isSlotId(id)) throw new Error("מזהה שמירה אוטומטית לא תקין");
    return { file: path.join(autosaveDir(), `${id}.mbrush`), meta: path.join(autosaveDir(), `${id}.json`) };
  };
  async function listSlots(): Promise<AutosaveSlot[]> {
    const out: AutosaveSlot[] = [];
    const read = async (id: string) => {
      try {
        const { file, meta } = slotFiles(id);
        const m = JSON.parse(await fs.readFile(meta, "utf8"));
        await fs.access(file); // a meta with no project behind it is not a slot
        out.push({ id, name: String(m.name ?? ""), originalPath: m.originalPath ?? null, savedAt: Number(m.savedAt) || 0 });
      } catch {
        /* not there, or half-written: not offered */
      }
    };
    await read(LEGACY_SLOT);
    const names = await fs.readdir(autosaveDir()).catch(() => [] as string[]);
    for (const n of names) if (n.endsWith(".json") && isSlotId(n.slice(0, -5))) await read(n.slice(0, -5));
    return sortSlots(out);
  }

  ipcMain.handle(IPC.autosaveWrite, async (_e, project: Project, originalPath: string | null, docId?: string) => {
    try {
      const { file, meta } = slotFiles(docId ?? LEGACY_SLOT);
      await fs.mkdir(path.dirname(file), { recursive: true });
      // The project first: a meta is what makes a slot visible, so it must never point at
      // a project that is not fully on disk.
      await writeFileAtomic(file, serializeProject(project));
      await writeFileAtomic(meta, JSON.stringify({ name: project.name, originalPath, savedAt: Date.now() }));
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.autosaveList, async () => {
    try {
      return ok(await listSlots());
    } catch (e) {
      return fail(e);
    }
  });

  // Kept for anything that still asks the old question: the newest slot, or null.
  ipcMain.handle(IPC.autosaveCheck, async () => {
    try {
      const [newest] = await listSlots();
      return ok(newest ? { name: newest.name, originalPath: newest.originalPath, savedAt: newest.savedAt } : null);
    } catch {
      return ok(null);
    }
  });

  ipcMain.handle(IPC.autosaveLoad, async (_e, docId?: string) => {
    try {
      const { file, meta } = slotFiles(docId ?? LEGACY_SLOT);
      const raw = await fs.readFile(file, "utf8");
      const m = JSON.parse(await fs.readFile(meta, "utf8").catch(() => "{}"));
      return ok({ project: attachProjectOriginals(deserializeProject(raw)), originalPath: m.originalPath ?? null });
    } catch (e) {
      return fail(e);
    }
  });

  // One slot (a document that was saved or closed), or — with no id — all of them (the
  // recovery offer was declined). `discarded` says the work in it was thrown away rather
  // than saved: a development build keeps that copy (see shared/autosaveSlots.ts).
  ipcMain.handle(IPC.autosaveClear, async (_e, docId?: string, discarded?: boolean) => {
    try {
      const ids = docId ? [docId] : (await listSlots()).map((s) => s.id);
      const keep = !!discarded && keepDiscardedSlots(app.isPackaged, process.env);
      const keptDir = path.join(autosaveDir(), "discarded");
      if (keep) await fs.mkdir(keptDir, { recursive: true });
      for (const id of ids) {
        const { file, meta } = slotFiles(id);
        if (keep) {
          const at = new Date();
          // Project first: if the move stops halfway, the slot is still offered next launch.
          try {
            await fs.rename(file, path.join(keptDir, discardedName(id, at, "mbrush")));
            await fs.rename(meta, path.join(keptDir, discardedName(id, at, "json")));
          } catch {
            /* nothing there to keep — fall through to the delete */
          }
        }
        // Meta first: the slot stops being offered before its project goes.
        await fs.rm(meta, { force: true });
        await fs.rm(file, { force: true });
      }
      if (keep) {
        const names = await fs.readdir(keptDir).catch(() => [] as string[]);
        for (const n of discardedToPrune(names)) await fs.rm(path.join(keptDir, n), { force: true });
      }
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });

  // Prompt-assistant chat — multi-provider (OpenAI / Gemini / Grok / Claude),
  // each on the user's own key. Image attachments ride on the last user message.
  ipcMain.handle(IPC.chat, async (_e, payload: ChatPayload) => {
    try {
      const keyId =
        payload.provider === "openai"
          ? "umage2" // reuse the engine's OpenAI key
          : payload.provider === "google"
            ? "chat-google"
            : payload.provider === "xai"
              ? "chat-xai"
              : "chat-anthropic";
      const apiKey = await keyManager.get(keyId);
      if (!apiKey) {
        const names: Record<string, string> = {
          openai: "OpenAI (מוגדר דרך מנוע umage2 בהגדרות)",
          google: "Google Gemini",
          xai: "xAI Grok",
          anthropic: "Anthropic Claude",
        };
        throw new Error(`חסר מפתח API ל-${names[payload.provider]} — הזן אותו בחלון הצ'אט.`);
      }
      return ok(await runChat(payload, apiKey));
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.generate, async (_e, req: BaseGenerationRequest) => {
    try {
      const provider = registry.get(req.providerId);
      const apiKey = provider.requiresApiKey() ? await keyManager.get(req.providerId) : undefined;
      if (provider.requiresApiKey() && !apiKey) {
        throw new Error("לא הוגדר מפתח API לספק זה. פתח הגדרות והזן מפתח.");
      }
      const result = await registry.dispatch(req, apiKey);
      await dumpGenDebug(req, result);
      await archiveGenOutput(req, result); // auto-save raw output to ~/Pictures/פלט מהמכחול
      return ok(result);
    } catch (e) {
      console.error("[generate] failed:", e instanceof Error ? e.stack : e);
      // What the attempt weighed, so a transport failure can be told apart from a payload
      // that was never going to make it.
      return fail(e, requestBytes(req));
    }
  });

  ipcMain.handle(IPC.spendGet, async () => {
    try {
      return ok(await readSpend());
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(
    IPC.spendAdd,
    async (_e, amount: number, meta?: { providerId?: string; modelId?: string; mode?: string }) => {
      try {
        const s = await readSpend();
        const entry: SpendEntry = { ts: new Date().toISOString(), cost: amount || 0, ...meta };
        const entries = [...s.entries, entry].slice(-1000);
        const next: SpendData = {
          total: s.total + (amount || 0),
          count: s.count + 1,
          entries,
          // Incremented here rather than recomputed from `entries`, which is capped.
          months: addToMonth(s.months, entry.ts, entry.cost),
        };
        await writeSpend(next);
        return ok(next);
      } catch (e) {
        return fail(e);
      }
    },
  );

  ipcMain.handle(IPC.appInfo, async () =>
    ok({ version: app.getVersion(), platform: process.platform }),
  );

  ipcMain.handle(IPC.licenseStatus, async () => {
    try {
      return ok(await licenseManager.status());
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.licenseActivate, async (_e, code: string) => {
    try {
      return ok(await licenseManager.activate(code));
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(
    IPC.submitFeedback,
    async (_e, payload: { message: string; email?: string; version?: string; platform?: string }) => {
      try {
        const base = (
          process.env.MBRUSH_ACTIVATION_URL || "https://mbrush-activation.saundersnp.workers.dev"
        ).replace(/\/$/, "");
        const resp = await fetch(`${base}/feedback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json().catch(() => ({ ok: resp.ok }));
        if (!data?.ok) return fail(data?.error || "השליחה נכשלה");
        return ok(true);
      } catch {
        return fail("אין חיבור לשרת. בדוק אינטרנט ונסה שוב.");
      }
    },
  );

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    try {
      // Only allow safe schemes.
      if (!/^(https?:|mailto:)/i.test(url)) throw new Error("כתובת לא חוקית");
      await shell.openExternal(url);
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.keyStatus, async () => ok({ secure: keyManager.isSecure() }));

  ipcMain.handle(IPC.keyList, async () => {
    try {
      return ok(await keyManager.listConfigured());
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.keyGet, async (_e, providerId: string) => {
    try {
      const k = await keyManager.get(providerId);
      // Return only whether it exists + a masked hint — never the full key.
      return ok({ configured: !!k, hint: k ? `••••${k.slice(-4)}` : null });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.keySet, async (_e, providerId: string, key: string) => {
    try {
      await keyManager.set(providerId, key);
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.keyRemove, async (_e, providerId: string) => {
    try {
      await keyManager.remove(providerId);
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });

  // Batch: pick an output directory once per run.
  ipcMain.handle(IPC.chooseDirectory, async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const r = win
        ? await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] })
        : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
      return ok(r.canceled ? null : r.filePaths[0] ?? null);
    } catch (e) {
      return fail(e);
    }
  });

  // Batch: write one output image into the chosen directory (called per item as it
  // completes, so a cancelled run keeps its partial results).
  ipcMain.handle(IPC.writeImageTo, async (_e, dir: string, filename: string, dataUrl: string) => {
    try {
      await fs.mkdir(dir, { recursive: true });
      const safe = filename.replace(/[/\\:*?"<>|]/g, "-").trim() || "output.png";
      await fs.writeFile(path.join(dir, safe), dataUrlToBuf(dataUrl));
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });

  // ---- Series: the dataset a batch run works from -------------------------
  // Picking the root in a native dialog is what grants access; series.ts refuses
  // every read outside it.
  ipcMain.handle(IPC.datasetPick, async () => {
    try {
      return ok(await pickRoot());
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle(IPC.datasetScan, async (_e, root: string) => {
    try {
      return ok(await scanDataset(root));
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle(IPC.readSheet, async (_e, file: string) => {
    try {
      return ok(await readSheet(file));
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle(IPC.readImageFile, async (_e, file: string) => {
    try {
      return ok(await readImageFile(file));
    } catch (e) {
      return fail(e);
    }
  });

  // Series: the manifest and the per-item prompt files.
  ipcMain.handle(IPC.writeTextTo, async (_e, dir: string, filename: string, text: string) => {
    try {
      await fs.mkdir(dir, { recursive: true });
      const safe = filename.replace(/[/\\:*?"<>|]/g, "-").trim() || "notes.txt";
      await fs.writeFile(path.join(dir, safe), text, "utf8");
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });

  // Copy a stored key from one slot to another (e.g. reuse the xAI chat key for
  // Grok image generation) AFTER explicit user consent in the UI. The raw secret
  // never leaves the main process — the renderer only triggers the copy.
  ipcMain.handle(IPC.keyLink, async (_e, fromId: string, toId: string) => {
    try {
      const secret = await keyManager.get(fromId);
      if (!secret) return fail(new Error("המפתח המקורי לא נמצא"));
      await keyManager.set(toId, secret);
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });

  // A prompt list dropped on the app (the drop gave us its real path).
  ipcMain.handle(IPC.promptFileOpen, async (_e, file: string) => {
    try {
      return ok(await readPromptFile(file));
    } catch (e) {
      return fail(e);
    }
  });

  // ---- Full-resolution originals (see ipc/originals.ts) ----
  // A dropped file: the renderer has its path (from webUtils, i.e. a real drop).
  ipcMain.handle(IPC.originalRegister, async (_e, file: string) => {
    try {
      return ok(registerOriginal(file));
    } catch (e) {
      return fail(e);
    }
  });
  // No file behind it (pasted, dropped from a browser): keep a copy.
  ipcMain.handle(IPC.originalKeep, async (_e, dataUrl: string) => {
    try {
      return ok(await keepOriginal(dataUrl));
    } catch (e) {
      return fail(e);
    }
  });
  // The project's original moved: let the user point at it.
  ipcMain.handle(IPC.originalRelink, async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const r = await dialog.showOpenDialog(win!, {
        title: "איפה קובץ המקור?",
        properties: ["openFile"],
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
      });
      if (r.canceled || !r.filePaths[0]) return ok(null);
      return ok(registerOriginal(r.filePaths[0]));
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.keyValidate, async (_e, providerId: string, key: string) => {
    try {
      const res = await registry.get(providerId).validateApiKey(key);
      return ok(res);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.pickImages, async () => {
    try {
      return ok(await pickImages());
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.openImage, async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const r = await dialog.showOpenDialog(win!, {
        properties: ["openFile"],
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "tiff", "bmp"] }],
      });
      if (r.canceled || !r.filePaths[0]) return ok(null);
      const fp = r.filePaths[0];
      // Same path as the multi-file open: downscaled here rather than shipped whole.
      const img = { name: path.basename(fp), ...(await toImageImport(fp)) };
      await notePictureRecent(fp);
      return ok(img);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.saveProject, async (_e, project: Project, existingPath?: string) => {
    try {
      let target = existingPath;
      if (!target) {
        const win = BrowserWindow.getFocusedWindow() ?? undefined;
        const r = await dialog.showSaveDialog(win!, {
          defaultPath: `${project.name || "project"}.mbrush`,
          filters: [{ name: "Mechanical Brush", extensions: ["mbrush"] }],
        });
        if (r.canceled || !r.filePath) return ok(null);
        target = r.filePath;
      }
      // Atomic, and the version it replaces stays as <name>.mbrush.bak: a crash or a full
      // disk mid-save used to leave a truncated file where the only copy of the work was.
      await writeFileAtomic(target, serializeProject(project), { backup: true });
      const savedName = path.basename(target).replace(/\.mbrush$/i, "");
      await addRecent({
        path: target,
        name: savedName,
        thumbnail: project.thumbnail,
        updatedAt: new Date().toISOString(),
        kind: "project",
      });
      return ok({ path: target, name: savedName });
    } catch (e) {
      return fail(e);
    }
  });

  async function loadProjectFromPath(fp: string) {
    const raw = await fs.readFile(fp, "utf-8");
    const project = attachProjectOriginals(deserializeProject(raw));
    // Prefer the file's name (what the user named it) over the internal name.
    project.name = path.basename(fp).replace(/\.mbrush$/i, "");
    await addRecent({
      path: fp,
      name: project.name,
      thumbnail: project.thumbnail,
      updatedAt: new Date().toISOString(),
      kind: "project",
    });
    return { path: fp, project };
  }

  ipcMain.handle(IPC.openProject, async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const r = await dialog.showOpenDialog(win!, {
        properties: ["openFile"],
        filters: [{ name: "Mechanical Brush", extensions: ["mbrush"] }],
      });
      if (r.canceled || !r.filePaths[0]) return ok(null);
      return ok(await loadProjectFromPath(r.filePaths[0]));
    } catch (e) {
      return fail(e);
    }
  });

  // Unified open: pick an image OR a .mbrush project from one dialog.
  ipcMain.handle(IPC.openAny, async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const r = await dialog.showOpenDialog(win!, {
        properties: ["openFile"],
        filters: [
          { name: "תמונות, פרויקטים ורשימות", extensions: ["png", "jpg", "jpeg", "webp", "tiff", "bmp", "mbrush", "txt", "docx"] },
          { name: "Mechanical Brush", extensions: ["mbrush"] },
          { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "tiff", "bmp"] },
          { name: "רשימת פרומפטים", extensions: ["txt", "docx"] },
        ],
      });
      if (r.canceled || !r.filePaths[0]) return ok(null);
      const fp = r.filePaths[0];
      if (fp.toLowerCase().endsWith(".mbrush")) {
        return ok({ kind: "project" as const, ...(await loadProjectFromPath(fp)) });
      }
      // A text file is a list of prompts.
      if (/\.(txt|docx)$/i.test(fp)) {
        return ok({ kind: "text" as const, ...(await readPromptFile(fp)) });
      }
      // Shrunk here like every other import (this path used to ship the whole file), and
      // with its original registered when it was.
      const img = { kind: "image" as const, name: path.basename(fp), ...(await toImageImport(fp)) };
      await notePictureRecent(fp);
      return ok(img);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.openProjectPath, async (_e, fp: string) => {
    try {
      return ok(await loadProjectFromPath(fp));
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.recentsGet, async () => {
    try {
      return ok(await readRecents());
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(
    IPC.recentsAdd,
    async (_e, entry: { path: string; name: string; thumbnail?: string; kind?: "project" | "image" }) => {
      try {
        if (entry.kind === "image" && !entry.thumbnail) {
          await notePictureRecent(entry.path);
          return ok(await readRecents());
        }
        return ok(await addRecent({ ...entry, updatedAt: new Date().toISOString() }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  ipcMain.handle(IPC.recentsOpenImage, async (_e, fp: string) => {
    try {
      // Only a picture the gallery itself lists: the list is what grants the read.
      const listed = (await readRecents()).some((r) => r.path === fp && r.kind === "image");
      if (!listed) throw new Error("התמונה אינה ברשימת העבודות");
      const img = { name: path.basename(fp), ...(await toImageImport(fp)) };
      await notePictureRecent(fp); // opened again: to the top
      return ok(img);
    } catch (e) {
      return fail(e);
    }
  });

  // Remake older pictures' thumbnails square, up to `limit` per call (see the store's
  // upgradeGalleryThumbs). A picture that is gone or unreadable is marked too, so it is
  // not retried at every launch. Order and dates are left alone: this is not "opened".
  ipcMain.handle(IPC.recentsUpgradeThumbs, async (_e, limit = 12) => {
    try {
      const list = await readRecents();
      const todo = list.filter((r) => r.kind === "image" && (r.thumbV ?? 0) < THUMB_V);
      let changed = false;
      const batch = todo.slice(0, Math.max(1, Math.min(50, Number(limit) || 12)));
      for (const r of batch) {
        try {
          const t = galleryThumb(nativeImage.createFromPath(r.path));
          if (t) r.thumbnail = t;
        } catch {
          /* keep the old one */
        }
        r.thumbV = THUMB_V;
        changed = true;
      }
      if (changed) await writeRecents(list);
      return ok({ list, changed, remaining: todo.length - batch.length });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(IPC.recentsRemove, async (_e, fp: string) => {
    try {
      const list = (await readRecents()).filter((r) => r.path !== fp);
      await writeRecents(list);
      return ok(list);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle(
    IPC.exportImage,
    async (_e, dataUrl: string, suggestedName: string) => {
      try {
        const win = BrowserWindow.getFocusedWindow() ?? undefined;
        // The format was already chosen in the app (the data URL is encoded in it),
        // so offer ONLY that single extension — no redundant macOS "Format" picker,
        // no double extension.
        const ext = (suggestedName.match(/\.([a-z0-9]+)$/i)?.[1] || "png").toLowerCase();
        const r = await dialog.showSaveDialog(win!, {
          defaultPath: suggestedName || "export.png",
          filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
        });
        if (r.canceled || !r.filePath) return ok(null);
        const m = /^data:[^;]+;base64,(.*)$/s.exec(dataUrl);
        if (!m) throw new Error("נתוני תמונה לא תקינים");
        // Atomic: this may be overwriting the user's own photo (a piece written back).
        const out = Buffer.from(m[1], "base64");
        await writeFileAtomic(r.filePath, out);
        await notePictureRecent(r.filePath, out);
        return ok({ path: r.filePath });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
