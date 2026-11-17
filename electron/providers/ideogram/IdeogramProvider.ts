import { PNG } from "pngjs";
import { v4 as uuid } from "uuid";
import { type ImageProvider, dataUrlToBuffer, bufferToDataUrl } from "../ImageProvider.js";
import type {
  BaseGenerationRequest,
  GenerationResult,
  ProviderCapabilities,
  ModelInfo,
  ProviderOption,
  ValidationResult,
} from "../../../shared/types.js";
import { recreateOverride } from "../../../shared/erasePrompts.js";
import { fillPrompt, recreatePrompt } from "../../../shared/editPrompts.js";
import { ASPECT_GEN, ASPECT_EDIT, ALIGN_TO_SOURCE, ASPECT_CONFORM } from "../options.js";
import { fitIdeogramSize, parseAspect, sizeForAspect, tierOf, upscaleFactor, IDEOGRAM_1K_PIXELS } from "../../../shared/ideogramSize.js";

// Ideogram 4.5 (developer.ideogram.ai). Multipart requests, an `Api-Key` header, and one
// endpoint per operation:
//   generate/ideogram-4-5      text-to-image; with images, "the first is edited, the rest
//                              are references" — the right tool for a recreate
//   precise-edit/ideogram-4-5  targeted edit that copies untouched pixels exactly, with an
//                              optional mask — fill, erase, and a recreate carrying pins
//   remove-background/…-1      a real cut-out with an alpha channel, not a redraw
//   upscale/auto               ×2 / ×4 / ×8, up to 8192px a side
//
// Every call runs ASYNC and is polled. A generation can take minutes; one HTTP request
// held open that long is exactly what a router drops mid-wait (that was the ECONNRESET
// on umage2). Polling also hands back what the run actually cost.

export const IDEOGRAM_MODEL = "ideogram-4-5";
const BASE_URL = "https://api.ideogram.ai";

const IDEOGRAM_RES: ProviderOption = {
  key: "ideogramResolution",
  label: "רזולוציה",
  type: "select",
  default: "2k",
  modes: ["generate"],
  note: "Ideogram מחייב לפי שתי מדרגות: עד 1024×1024 נחשב 1K, מעליו 2K. הפלט מוגבל ל-2048×2048 פיקסלים בסך הכול.",
  choices: [
    { value: "1k", label: "1K" },
    { value: "2k", label: "2K" },
  ],
};

const IDEOGRAM_RECREATE_RES: ProviderOption = {
  key: "recreateLongEdge",
  label: "רזולוציה",
  type: "select",
  default: 2048,
  modes: ["recreate"],
  note: "Ideogram מוגבל ל-2048×2048 פיקסלים בסך הכול — זו התקרה.",
  choices: [
    { value: 0, label: "כמו המקור (עד 2K)" },
    { value: 1024, label: "1K" },
    { value: 2048, label: "2K" },
  ],
};

const IDEOGRAM_FILL_RES: ProviderOption = {
  key: "fillLongEdge",
  label: "רזולוציית אזור",
  type: "select",
  default: 0,
  modes: ["fill"],
  note: "מותאם לאזור: הג'נרוט נעשה בגודל האמיתי של השטח המסומן. גודל קבוע גובר עליו.",
  choices: [
    { value: 0, label: "מותאם לאזור" },
    { value: 1024, label: "1K" },
    { value: 1536, label: "1.5K" },
    { value: 2048, label: "2K" },
  ],
};

const IDEOGRAM_QUALITY: ProviderOption = {
  key: "ideogramQuality",
  label: "איכות",
  type: "select",
  default: "auto",
  modes: ["generate", "recreate", "fill"],
  note: "איכות גבוהה איטית ויקרה יותר. 'טיוטה' זמינה רק כשיש תמונת מקור.",
  choices: [
    { value: "auto", label: "ברירת המחדל של Ideogram" },
    { value: "very_low", label: "טיוטה" },
    { value: "medium", label: "בינונית" },
    { value: "high", label: "גבוהה" },
  ],
};

const IDEOGRAM_MAGIC: ProviderOption = {
  key: "ideogramMagic",
  label: "שכתוב פרומפט",
  type: "select",
  default: "auto",
  modes: ["generate"],
  note: "Magic Prompt של Ideogram מרחיב ומשכתב את הפרומפט. כבה כדי שהניסוח שלך יישלח כפי שהוא. בעריכה הוא תמיד כבוי.",
  choices: [
    { value: "auto", label: "אוטומטי" },
    { value: "on", label: "פעיל" },
    { value: "off", label: "כבוי" },
  ],
};

const IDEOGRAM_UPSCALE: ProviderOption = {
  key: "ideogramUpscale",
  label: "הגדלה",
  type: "select",
  default: 2,
  modes: ["upscale"],
  note: "פי כמה להגדיל. הפלט מוגבל ל-8192 פיקסלים לצלע — מקדם גבוה מדי יורד אוטומטית.",
  choices: [
    { value: 2, label: "×2" },
    { value: 4, label: "×4" },
    { value: 8, label: "×8" },
  ],
};

interface IdeogramImage {
  url?: string | null;
  resolution?: string;
  is_image_safe?: boolean;
}

/** App mask (white + opaque = change this) → Ideogram's (black = edit, white = keep). */
function toIdeogramMask(maskDataUrl: string): Buffer {
  const src = PNG.sync.read(dataUrlToBuffer(maskDataUrl).buffer);
  const out = new PNG({ width: src.width, height: src.height });
  for (let i = 0; i < src.data.length; i += 4) {
    const lum = (src.data[i] + src.data[i + 1] + src.data[i + 2]) / 3;
    const edit = src.data[i + 3] > 16 && lum > 128;
    const v = edit ? 0 : 255;
    out.data[i] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return PNG.sync.write(out);
}

/** Width and height from a PNG or JPEG header — for the upscale factor check. */
function imageDims(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf.toString("ascii", 12, 16) === "IHDR") return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

function blobOf(dataUrl: string): Blob {
  const { buffer, mime } = dataUrlToBuffer(dataUrl);
  return new Blob([new Uint8Array(buffer)], { type: mime });
}

function extOf(mime: string): string {
  return mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
}

/** A price out of an unpublished PriceQuote shape: the first number under a key that
 *  names money, read in the unit the key names. Undefined rather than a guess. */
export function readQuoteUsd(quote: unknown): number | undefined {
  const seen: { key: string; value: number }[] = [];
  const walk = (v: unknown, key: string) => {
    if (typeof v === "number" && Number.isFinite(v)) seen.push({ key, value: v });
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(quote, "");
  const hit =
    seen.find((s) => /usd/i.test(s.key)) ?? seen.find((s) => /price|cost|amount|cents/i.test(s.key));
  if (!hit) return undefined;
  if (/micros/i.test(hit.key)) return hit.value / 1e6;
  if (/cents/i.test(hit.key)) return hit.value / 100;
  return hit.value;
}

/** What went wrong, in words the error handler can route. Billing refusals keep their
 *  reject_reason verbatim so shared/errors.ts recognises them as "out of credits". */
export function ideogramError(status: number, body: any): Error {
  const reason: string = body?.reject_reason ?? body?.failure_reason ?? "";
  const detail: string = body?.message ?? body?.detail ?? body?.error ?? "";
  const tail = [reason, typeof detail === "string" ? detail : JSON.stringify(detail)].filter(Boolean).join(" · ");
  if (status === 401) return new Error("מפתח Ideogram לא תקין או לא פעיל (401).");
  if (status === 422) return new Error(`Ideogram חסם את הבקשה בבדיקת הבטיחות שלו (422)${tail ? ` — ${tail}` : ""}.`);
  if (status === 402 && /daily_limit|inflight_limit|feature_limit/.test(reason)) {
    return new Error(`Ideogram הגביל את הקצב או המכסה היומית (${reason}). נסה שוב מאוחר יותר.`);
  }
  if (status === 429) return new Error(`Ideogram מגביל את קצב הבקשות כרגע (429)${tail ? ` — ${tail}` : ""}. נסה שוב בעוד רגע.`);
  return new Error(`Ideogram ${status}${tail ? `: ${tail}` : ""}`);
}

export class IdeogramProvider implements ImageProvider {
  readonly id = "ideogram";
  readonly name = "Ideogram 4.5";
  readonly version = "4.5";

  /** Price quotes by request shape, for runs whose result does not carry its own cost.
   *  A dry run is free, but it still uploads the images — once per shape is enough. */
  private quotes = new Map<string, number>();

  constructor(
    private readonly baseUrl = BASE_URL,
    private readonly pollMs = 1500,
    private readonly deadlineMs = 8 * 60_000,
  ) {}

  getCapabilities(): ProviderCapabilities {
    return {
      supportsUpscale: true,
      supportsRecreate: true,
      supportsInpainting: true,
      // precise-edit takes a real mask (black = edit). Fill normally sends none — the
      // crop is the region — but the erase brush does, and gets an exact edit.
      supportsMasks: true,
      // Via the dedicated remove-background endpoint: a true cut-out with alpha.
      supportsTransparency: true,
      supportsReferenceImages: true,
      supportsMultipleReferenceImages: true,
      supportsNegativePrompt: false,
      supportsSeed: false,
      supportsVariations: true,
      supportsCustomOutputSize: true,
      maxInputImageSize: 25 * 1024 * 1024,
      // Total images per request: generate takes 5, precise-edit one source + 4.
      maxReferenceImages: 5,
      supportedFormats: ["png", "jpeg", "webp"],
      notes:
        "Ideogram 4.5 — יצירה, יצירה מחדש, מילוי ומחיקה בעריכה מדויקת (פיקסלים שלא נגעו בהם נשמרים כמו שהם), " +
        "הסרת רקע אמיתית עם שקיפות, והגדלה פי 2/4/8. פלט עד 2048×2048. בלי הרחבה ושינוי פורמט.",
    };
  }

  getModels(): ModelInfo[] {
    return [{ id: IDEOGRAM_MODEL, label: "Ideogram 4.5", supportsTransparency: true }];
  }

  getOptions(): ProviderOption[] {
    return [
      IDEOGRAM_QUALITY,
      ASPECT_GEN,
      IDEOGRAM_RES,
      IDEOGRAM_MAGIC,
      { ...ASPECT_EDIT, modes: ["recreate"] },
      IDEOGRAM_RECREATE_RES,
      IDEOGRAM_FILL_RES,
      IDEOGRAM_UPSCALE,
      ASPECT_CONFORM,
      ALIGN_TO_SOURCE,
    ];
  }

  requiresApiKey(): boolean {
    return true;
  }

  /** A dry run: validates and prices without generating or billing, so checking a key
   *  costs nothing. */
  async validateApiKey(apiKey: string | undefined): Promise<ValidationResult> {
    const key = apiKey?.trim();
    if (!key) return { valid: false, message: "לא הוזן מפתח" };
    try {
      const form = new FormData();
      form.set("prompt", "a single red circle on white");
      form.set("size", "1024x1024");
      await this.post("/v2/image/generate/ideogram-4-5?dry_run=true", form, key);
      return { valid: true };
    } catch (e: any) {
      return { valid: false, message: e?.message ?? "אימות מול Ideogram נכשל" };
    }
  }

  // ---- transport -----------------------------------------------------------------

  private async post(path: string, form: FormData, apiKey: string): Promise<any> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Api-Key": apiKey },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const body: any = await resp.json().catch(() => ({}));
    if (!resp.ok) throw ideogramError(resp.status, body);
    return body;
  }

  /** Start a generation and wait for it by polling. */
  private async run(
    path: string,
    form: FormData,
    apiKey: string | undefined,
  ): Promise<{ images: IdeogramImage[]; cost?: number; id: string }> {
    if (!apiKey) throw new Error("חסר מפתח Ideogram. הזן אותו בהגדרות.");
    form.set("async", "true");
    const started = await this.post(path, form, apiKey);
    // Should an endpoint answer synchronously after all, take the answer.
    if (Array.isArray(started?.data) && started.data.length) {
      return { images: started.data, id: started.generation_id ?? uuid() };
    }
    const id: string | undefined = started?.generation_id;
    if (!id) throw new Error("Ideogram לא החזיר מזהה הרצה");

    const deadline = Date.now() + this.deadlineMs;
    let wait = this.pollMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, wait));
      const resp = await fetch(`${this.baseUrl}/v2/generations/${encodeURIComponent(id)}`, {
        headers: { "Api-Key": apiKey },
        signal: AbortSignal.timeout(30_000),
      });
      if (resp.status === 429) {
        const after = Number(resp.headers.get("retry-after"));
        wait = Number.isFinite(after) && after > 0 ? after * 1000 : Math.min(wait * 2, 10_000);
        continue;
      }
      const body: any = await resp.json().catch(() => ({}));
      if (!resp.ok) throw ideogramError(resp.status, body);
      if (body.status === "completed") {
        const micros = Number(body.usage_cost_usd_micros);
        return {
          images: Array.isArray(body.data) ? body.data : [],
          cost: Number.isFinite(micros) && micros > 0 ? micros / 1e6 : undefined,
          id,
        };
      }
      if (body.status === "failed") throw ideogramError(500, { failure_reason: body.failure_reason ?? "failed" });
      // Pending: back off gently, never past a few seconds — the user is watching.
      wait = Math.min(Math.round(wait * 1.3), 5000);
    }
    throw new Error("Ideogram לא סיים בזמן — ייתכן שההרצה עוד תסתיים ותחויב. בדוק בחשבון Ideogram.");
  }

  /** The first image as a data URL, with its size. */
  private async fetchImage(img: IdeogramImage, apiKey: string): Promise<{ src: string; width: number; height: number }> {
    if (!img?.url) {
      throw new Error(
        img?.is_image_safe === false
          ? "Ideogram חסם את התוצאה בבדיקת הבטיחות שלו — לא הוחזרה תמונה."
          : "Ideogram לא החזיר תמונה",
      );
    }
    let resp = await fetch(img.url, { signal: AbortSignal.timeout(60_000) });
    if (resp.status === 401 || resp.status === 403) {
      resp = await fetch(img.url, { headers: { "Api-Key": apiKey }, signal: AbortSignal.timeout(60_000) });
    }
    if (!resp.ok) throw new Error(`הורדת התוצאה מ-Ideogram נכשלה (${resp.status})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const mime = resp.headers.get("content-type")?.split(";")[0] || (buf[0] === 0xff ? "image/jpeg" : "image/png");
    const [w, h] = String(img.resolution ?? "").split("x").map(Number);
    const dims = w > 0 && h > 0 ? { w, h } : imageDims(buf) ?? { w: 1024, h: 1024 };
    return { src: bufferToDataUrl(buf, mime), width: dims.w, height: dims.h };
  }

  /** Price of a run whose result did not report one: a free dry run of the same request,
   *  remembered per shape. Undefined when Ideogram will not say — never a made-up number. */
  private async quote(path: string, form: FormData, apiKey: string, shape: string): Promise<number | undefined> {
    if (this.quotes.has(shape)) return this.quotes.get(shape);
    try {
      const dry = new FormData();
      for (const [k, v] of form.entries()) if (k !== "async") dry.append(k, v);
      const sep = path.includes("?") ? "&" : "?";
      const usd = readQuoteUsd(await this.post(`${path}${sep}dry_run=true`, dry, apiKey));
      if (usd !== undefined) this.quotes.set(shape, usd);
      return usd;
    } catch {
      return undefined;
    }
  }

  private async finish(
    req: BaseGenerationRequest,
    path: string,
    form: FormData,
    apiKey: string | undefined,
    shape: string,
  ): Promise<GenerationResult> {
    const t0 = Date.now();
    const done = await this.run(path, form, apiKey);
    const image = await this.fetchImage(done.images[0], apiKey!);
    const cost = done.cost ?? (await this.quote(path, form, apiKey!, shape));
    return {
      id: uuid(),
      providerId: this.id,
      modelId: req.modelId ?? IDEOGRAM_MODEL,
      images: [image],
      metadata: { requestId: done.id, latencyMs: Date.now() - t0, costEstimate: cost, costReported: done.cost != null },
    };
  }

  // ---- what each mode sends -----------------------------------------------------

  private quality(req: BaseGenerationRequest, hasSource: boolean): string | null {
    const q = String(req.settings?.ideogramQuality ?? "auto");
    if (q === "auto") return null;
    // "very_low" requires a source image; on a text-to-image it would be refused.
    if (q === "very_low" && !hasSource) return "medium";
    return q;
  }

  private addImage(form: FormData, field: string, dataUrl: string, name: string) {
    const blob = blobOf(dataUrl);
    form.append(field, blob, `${name}.${extOf(blob.type)}`);
  }

  async generateImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult> {
    const refs = (req.references ?? []).slice(0, 5);
    const form = new FormData();
    form.set("prompt", req.prompt ?? "");
    form.set("magic_prompt", String(req.settings?.ideogramMagic ?? "auto"));
    const tier = String(req.settings?.ideogramResolution ?? "2k");
    const aspect = parseAspect(req.settings?.aspectRatio);
    let size = "auto";
    if (aspect) {
      const s = sizeForAspect(aspect, tier === "1k" ? IDEOGRAM_1K_PIXELS : undefined);
      size = `${s.w}x${s.h}`;
    } else if (tier === "1k" && !refs.length) {
      size = "1024x1024";
    }
    form.set("size", size);
    const q = this.quality(req, refs.length > 0);
    if (q) form.set("quality", q);
    refs.forEach((r, i) => this.addImage(form, "images", r.src, `ref-${i + 1}`));
    const path = "/v2/image/generate/ideogram-4-5";
    try {
      return await this.finish(req, path, form, apiKey, `gen|${size}|${q}`);
    } catch (e: any) {
      // The preset list is not published; a computed size Ideogram does not offer comes
      // back as a 400 (not billed). Ask again with "auto" rather than fail the run.
      if (size !== "auto" && /^Ideogram 400/.test(e?.message ?? "") && /size/i.test(e?.message ?? "")) {
        form.set("size", "auto");
        return this.finish(req, path, form, apiKey, `gen|auto|${q}`);
      }
      throw e;
    }
  }

  /** A whole-frame edit. A recreate re-renders through `generate` with the source first;
   *  a recreate carrying pins, or an erase, is a targeted change and goes through
   *  precise-edit, which keeps every untouched pixel. */
  async recreateImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult> {
    if (!req.image) throw new Error("חסרה תמונת מקור");
    if (req.mode === "removebg") return this.removeBackground(req, apiKey);

    const override = recreateOverride(req.settings);
    if (override) {
      return this.preciseEdit(req, `${override}. ${req.prompt ?? ""}`.trim(), apiKey);
    }

    const prompt = recreatePrompt(req.prompt, req.settings, "the first image");
    const form = new FormData();
    form.set("prompt", prompt);
    // The app's own wording — the reference guide, preserve flags — has to arrive intact.
    form.set("magic_prompt", "off");
    const w = Number(req.settings?.outputWidth);
    const h = Number(req.settings?.outputHeight);
    let size = "source";
    if (w > 0 && h > 0) {
      const s = fitIdeogramSize(w, h);
      size = `${s.w}x${s.h}`;
    }
    form.set("size", size);
    const q = this.quality(req, true);
    if (q) form.set("quality", q);
    this.addImage(form, "images", req.image, "source");
    (req.references ?? []).slice(0, 4).forEach((r, i) => this.addImage(form, "images", r.src, `ref-${i + 1}`));
    const tier = size === "source" ? "src" : tierOf(...(size.split("x").map(Number) as [number, number]));
    return this.finish(req, "/v2/image/generate/ideogram-4-5", form, apiKey, `recreate|${tier}|${q}`);
  }

  private async preciseEdit(req: BaseGenerationRequest, prompt: string, apiKey?: string): Promise<GenerationResult> {
    if (!req.image) throw new Error("חסרה תמונת מקור");
    const form = new FormData();
    form.set("prompt", prompt);
    const q = this.quality(req, true);
    if (q) form.set("quality", q);
    this.addImage(form, "image", req.image, "source");
    // Four references at most, three when a mask comes along. The app puts its own
    // images last (the erase marks, then the full-picture context), and those are the
    // ones the prompt refers to — so trim from the user's references, never from those.
    const refs = req.references ?? [];
    const limit = req.mask ? 3 : 4;
    const own = refs.filter((r) => r.note === "full-image context" || r.note === "erase marks");
    const user = refs.filter((r) => !own.includes(r)).slice(0, Math.max(0, limit - own.length));
    [...user, ...own].slice(0, limit).forEach((r, i) => this.addImage(form, "reference_images", r.src, `ref-${i + 1}`));
    if (req.mask) form.append("mask", new Blob([new Uint8Array(toIdeogramMask(req.mask))], { type: "image/png" }), "mask.png");
    return this.finish(req, "/v2/image/precise-edit/ideogram-4-5", form, apiKey, `edit|${q}|${req.mask ? "m" : ""}`);
  }

  /** Fill and erase: the app sends the crop to edit (plus, for an erase, its mask). */
  editImageWithMask(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult> {
    const prompt = fillPrompt(req.prompt, {
      contextImage: !!req.references?.some((r) => r.note === "full-image context"),
    });
    return this.preciseEdit(req, prompt, apiKey);
  }

  private async removeBackground(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult> {
    const form = new FormData();
    this.addImage(form, "image", req.image!, "source");
    form.set("private", "true");
    return this.finish(req, "/v2/image/remove-background/ideogram-1", form, apiKey, "removebg");
  }

  async upscaleImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult> {
    if (!req.image) throw new Error("חסרה תמונת מקור");
    const dims = imageDims(dataUrlToBuffer(req.image).buffer);
    const long = dims ? Math.max(dims.w, dims.h) : 2048;
    const factor = upscaleFactor(long, Number(req.settings?.ideogramUpscale ?? 2));
    const form = new FormData();
    this.addImage(form, "image", req.image, "source");
    form.set("upscale_factor", String(factor));
    return this.finish(req, "/v2/image/upscale/auto", form, apiKey, `upscale|${factor}`);
  }

  async expandImage(): Promise<GenerationResult> {
    throw new Error("Ideogram לא תומך כאן בהרחבה ובשינוי פורמט — בחר מנוע אחר למצב הזה.");
  }
}
