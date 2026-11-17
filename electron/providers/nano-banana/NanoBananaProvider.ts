import { fal } from "@fal-ai/client";
import { recreateOverride } from "../../../shared/erasePrompts.js";
import { fillPrompt, recreatePrompt } from "../../../shared/editPrompts.js";
import { v4 as uuid } from "uuid";
import { debugDir } from "../../debugDump.js";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { type ImageProvider, dataUrlToBuffer } from "../ImageProvider.js";
import type {
  BaseGenerationRequest,
  GenerationResult,
  GenerationMode,
  ProviderCapabilities,
  ModelInfo,
  ProviderOption,
  ValidationResult,
} from "../../../shared/types.js";
import { ASPECT_EDIT, ASPECT_GEN, FILL_RES, RATIO_RES, ASPECT_CONFORM, ALIGN_TO_SOURCE, EXPAND_BASE_PROMPT, RATIO_BASE_PROMPT } from "../options.js";
import { DOWNLOAD_MS } from "../timeouts.js";

const EDIT_ENDPOINT = "fal-ai/nano-banana-2/edit";
const GEN_ENDPOINT = "fal-ai/nano-banana-2";

const ASPECTS: [string, number][] = [
  ["21:9", 21 / 9],
  ["16:9", 16 / 9],
  ["3:2", 3 / 2],
  ["4:3", 4 / 3],
  ["5:4", 5 / 4],
  ["1:1", 1],
  ["4:5", 4 / 5],
  ["3:4", 3 / 4],
  ["2:3", 2 / 3],
  ["9:16", 9 / 16],
  ["4:1", 4],
  ["1:4", 1 / 4],
  ["8:1", 8],
  ["1:8", 1 / 8],
];

function pickAspect(w: number, h: number): string {
  const a = w / h;
  let best = ASPECTS[5];
  let diff = Infinity;
  for (const cand of ASPECTS) {
    const d = Math.abs(cand[1] - a);
    if (d < diff) {
      diff = d;
      best = cand;
    }
  }
  return best[0];
}

function pickResolution(longEdge: number): "0.5K" | "1K" | "2K" | "4K" {
  if (longEdge <= 640) return "0.5K";
  if (longEdge <= 1280) return "1K";
  if (longEdge <= 2560) return "2K";
  return "4K";
}

function pngSize(dataUrl: string): { w: number; h: number } {
  try {
    const { buffer } = dataUrlToBuffer(dataUrl);
    if (buffer.length > 24 && buffer.toString("ascii", 12, 16) === "IHDR") {
      return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
    }
  } catch {
    /* ignore */
  }
  return { w: 1024, h: 1024 };
}

// Nano Banana 2 (Gemini Flash Image) per-image pricing by resolution tier.
function estimateCost(resolution: string): number {
  return ({ "0.5K": 0.045, "1K": 0.067, "2K": 0.101, "4K": 0.151 } as Record<string, number>)[
    resolution
  ] ?? 0.067;
}

const TIERS = ["0.5K", "1K", "2K", "4K"] as const;
type Tier = (typeof TIERS)[number];
const asTier = (v: unknown): Tier | null => (TIERS.includes(v as Tier) ? (v as Tier) : null);

/** Resolution per mode (overridable by settings). */
function resolutionFor(mode: GenerationMode, req: BaseGenerationRequest): Tier {
  const st = req.settings;
  // Modes whose pixel size the app decides: follow that number, not a tier.
  // Fill: the size the app actually worked out for the crop — which follows the marked
  // area unless a fixed size was picked. (fillLongEdge is 0 for "match the area".)
  if (mode === "fill") {
    const sent = Math.max(Number(st?.outputWidth) || 0, Number(st?.outputHeight) || 0);
    return pickResolution(sent || Number(st?.fillLongEdge) || 1024);
  }
  if (mode === "ratio") return pickResolution(st?.ratioLongEdge ?? 4096);
  // The rest have their own control, one per mode — so the tier the user sees in the
  // dock is the tier that gets requested. A single shared key used to show "1K" while
  // the fallback below quietly sent 4K for an upscale.
  if (mode === "upscale") return asTier(st?.nanoUpscaleResolution) ?? "4K";
  if (mode === "recreate") return asTier(st?.nanoRecreateResolution) ?? "2K";
  return asTier(st?.nanoResolution) ?? "1K";
}

/**
 * Nano Banana 2 (Gemini 3.1 Flash Image) via fal.ai.
 * Edits use the /edit endpoint with image_urls (data URIs); the model has no
 * mask param, which fits the app's maskless edit-in-place + composite-back flow.
 */
export class NanoBananaProvider implements ImageProvider {
  readonly id = "nano-banana";
  readonly name = "Nano Banana 2 (Gemini · fal)";
  readonly version = "2";

  getCapabilities(): ProviderCapabilities {
    return {
      supportsUpscale: true,
      supportsRecreate: true,
      supportsInpainting: true,
      supportsMasks: false,
      supportsTransparency: false,
      supportsReferenceImages: true,
      supportsMultipleReferenceImages: true,
      supportsNegativePrompt: false,
      supportsSeed: true,
      supportsVariations: true,
      supportsCustomOutputSize: false,
      maxReferenceImages: 6,
      supportedFormats: ["png", "jpeg", "webp"],
      notes:
        "מנוע fal.ai — בוחר יחס צלעות ורזולוציה (0.5K/1K/2K/4K) מתוך קבוצה. עריכה ללא מסכה (edit-in-place).",
    };
  }

  getModels(): ModelInfo[] {
    return [{ id: "nano-banana-2", label: "Nano Banana 2 (Gemini 3.1 Flash)" }];
  }

  getOptions(): ProviderOption[] {
    return [
      ASPECT_EDIT,
      ASPECT_GEN,
      // One per mode, so the displayed default is the one actually requested.
      ...(["generate", "recreate", "upscale"] as const).map((m) => ({
        key: m === "generate" ? "nanoResolution" : m === "recreate" ? "nanoRecreateResolution" : "nanoUpscaleResolution",
        label: "רזולוציה",
        type: "select" as const,
        default: m === "generate" ? "1K" : m === "recreate" ? "2K" : "4K",
        modes: [m],
        choices: [
          { value: "0.5K", label: "0.5K" },
          { value: "1K", label: "1K" },
          { value: "2K", label: "2K" },
          { value: "4K", label: "4K" },
        ],
      })),
      RATIO_RES,
      FILL_RES,
      ASPECT_CONFORM,
      ALIGN_TO_SOURCE,
    ];
  }

  requiresApiKey(): boolean {
    return true;
  }

  async validateApiKey(apiKey: string | undefined): Promise<ValidationResult> {
    const key = apiKey?.trim() ?? "";
    if (key.length < 8) {
      return { valid: false, message: "מפתח fal לא תקין" };
    }
    // fal keys are printable ASCII. A non-ASCII char (e.g. Hebrew) means the
    // wrong text was pasted, and would crash the HTTP header at request time.
    if (/[^\x20-\x7E]/.test(key)) {
      return {
        valid: false,
        message: "המפתח מכיל תווים לא חוקיים (אולי הודבק טקסט במקום מפתח). הדבק מפתח fal תקין (FAL_KEY).",
      };
    }
    // fal has no free validation endpoint; accept format and verify on first run.
    return { valid: true, message: "המפתח יישמר; אימות מלא יתבצע בג'נרוט הראשון" };
  }

  private cfg(apiKey?: string) {
    const key = apiKey?.trim();
    if (!key) throw new Error("חסר מפתח fal עבור Nano Banana");
    if (/[^\x20-\x7E]/.test(key)) {
      throw new Error(
        "מפתח ה-fal השמור אינו תקין (מכיל תווים לא לטיניים). פתח הגדרות ⚙ והדבק מחדש מפתח fal תקין.",
      );
    }
    fal.config({ credentials: key });
  }

  /**
   * Upload a data URI to fal storage and return a hosted URL.
   * Passing large base64 data URIs directly into image_urls can trip the fal
   * client's encoding (ByteString error), so we upload binary instead.
   */
  private async toFalUrl(src: string): Promise<string> {
    if (!src.startsWith("data:")) return src;
    const { buffer, mime } = dataUrlToBuffer(src);
    const file = new File([new Uint8Array(buffer)], "image.png", {
      type: mime || "image/png",
    });
    return await fal.storage.upload(file);
  }

  private async run(
    endpoint: string,
    input: Record<string, unknown>,
    resolution: string,
    apiKey?: string,
  ): Promise<GenerationResult> {
    this.cfg(apiKey);
    const t0 = Date.now();

    // Dump exactly what we're about to send (images + prompt) for inspection.
    await dumpSent(endpoint, input).catch(() => {});

    // Upload any data-URI inputs to fal storage and replace with hosted URLs.
    const finalInput: Record<string, unknown> = { ...input };
    if (Array.isArray(finalInput.image_urls)) {
      finalInput.image_urls = await Promise.all(
        (finalInput.image_urls as string[]).map((u) => this.toFalUrl(u)),
      );
    }

    let res: any;
    try {
      res = await fal.subscribe(endpoint, {
        input: { output_format: "png", num_images: 1, sync_mode: true, ...finalInput },
        logs: false,
      });
    } catch (e: any) {
      const status = e?.status || e?.response?.status || e?.body?.status;
      const detail =
        e?.body?.detail || e?.message || (typeof e === "string" ? e : "שגיאת fal לא ידועה");
      console.error("[nano-banana] subscribe failed:", status, e?.stack || e);
      // 401/403 = the fal key is missing, wrong, revoked, out of credits, or has
      // no access to this model. This is the common "forbidden" case.
      if (status === 401 || status === 403 || /forbidden|unauthor/i.test(String(detail))) {
        throw new Error(
          "Nano Banana — גישה נדחתה (403). בדוק את מפתח fal בהגדרות: ייתכן שהוא שגוי, סובב, אזל מקרדיט, " +
            "או שאין לו גישה למודל. הפק/העתק מפתח חדש מ-fal.ai/dashboard/keys והזן אותו מחדש.",
        );
      }
      throw new Error(`Nano Banana נכשל: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    }

    const img = res?.data?.images?.[0];
    if (!img?.url) throw new Error("Nano Banana לא החזיר תמונה");

    // Normalize to a data URI so the renderer can load it under CSP and it
    // never depends on an expiring hosted URL.
    let src: string = img.url;
    if (!src.startsWith("data:")) {
      const resp = await fetch(src, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
      const ab = Buffer.from(await resp.arrayBuffer());
      const ct = resp.headers.get("content-type") || "image/png";
      src = `data:${ct};base64,${ab.toString("base64")}`;
    }
    const dims = img.width && img.height ? { w: img.width, h: img.height } : pngSize(src);
    return {
      id: uuid(),
      providerId: this.id,
      modelId: "nano-banana-2",
      images: [{ src, width: dims.w, height: dims.h }],
      metadata: {
        requestId: res?.requestId,
        latencyMs: Date.now() - t0,
        costEstimate: estimateCost(resolution),
      },
    };
  }

  private editInputs(req: BaseGenerationRequest) {
    const imageUrls: string[] = [];
    if (req.image) imageUrls.push(req.image);
    if (req.references?.length) imageUrls.push(...req.references.map((r) => r.src));
    const { w, h } = req.image ? pngSize(req.image) : { w: 1024, h: 1024 };
    const ar = req.settings?.aspectRatio;
    const aspect = ar && ar !== "auto" ? ar : pickAspect(w, h);
    return { imageUrls, aspect };
  }

  upscaleImage(req: BaseGenerationRequest, apiKey?: string) {
    const { imageUrls, aspect } = this.editInputs(req);
    const resolution = resolutionFor("upscale", req);
    const prompt =
      "Upscale and enhance this image to ultra-high resolution. Add realistic fine " +
      "detail and sharpness while preserving the exact composition, colors and identity. " +
      (req.prompt?.trim() ?? "");
    return this.run(
      EDIT_ENDPOINT,
      { prompt, image_urls: imageUrls, aspect_ratio: aspect, resolution, seed: req.settings?.seed },
      resolution,
      apiKey,
    );
  }

  recreateImage(req: BaseGenerationRequest, apiKey?: string) {
    const { imageUrls, aspect } = this.editInputs(req);
    const resolution = resolutionFor("recreate", req);
    const override = recreateOverride(req.settings);
    const prompt = override
      ? `${override}. ${req.prompt?.trim() ?? ""}`.trim()
      : recreatePrompt(req.prompt, req.settings);
    return this.run(
      EDIT_ENDPOINT,
      { prompt, image_urls: imageUrls, aspect_ratio: aspect, resolution, seed: req.settings?.seed },
      resolution,
      apiKey,
    );
  }

  editImageWithMask(req: BaseGenerationRequest, apiKey?: string) {
    const { imageUrls, aspect } = this.editInputs(req);
    const resolution = resolutionFor("fill", req);
    const prompt = fillPrompt(req.prompt, { contextImage: !!req.references?.length });
    return this.run(
      EDIT_ENDPOINT,
      { prompt, image_urls: imageUrls, aspect_ratio: aspect, resolution, seed: req.settings?.seed },
      resolution,
      apiKey,
    );
  }

  expandImage(req: BaseGenerationRequest, apiKey?: string) {
    // Fixed base prompt (same for every model); aspect_ratio keeps the piece's shape.
    const { imageUrls, aspect } = this.editInputs(req);
    const resolution = resolutionFor("upscale", req);
    const extra = req.prompt?.trim();
    const base = req.mode === "ratio" ? RATIO_BASE_PROMPT : EXPAND_BASE_PROMPT;
    const prompt = base + (extra ? ` ${extra}` : "");
    return this.run(
      EDIT_ENDPOINT,
      { prompt, image_urls: imageUrls, aspect_ratio: aspect, resolution, seed: req.settings?.seed },
      resolution,
      apiKey,
    );
  }

  generateImage(req: BaseGenerationRequest, apiKey?: string) {
    const resolution = resolutionFor("generate", req);
    const prompt = req.prompt ?? "";
    // With reference images, use the edit endpoint for image-conditioned generation.
    if (req.references?.length) {
      const aspect = "auto";
      return this.run(
        EDIT_ENDPOINT,
        {
          prompt,
          image_urls: req.references.map((r) => r.src),
          aspect_ratio: aspect,
          resolution,
          seed: req.settings?.seed,
        },
        resolution,
        apiKey,
      );
    }
    const ar = req.settings?.aspectRatio;
    return this.run(
      GEN_ENDPOINT,
      { prompt, aspect_ratio: ar && ar !== "auto" ? ar : "auto", resolution, seed: req.settings?.seed },
      resolution,
      apiKey,
    );
  }
}

/**
 * Dump the exact request we send to Nano Banana — every input image plus the full
 * prompt — into <userData>/debug/, so you can see precisely what was sent.
 */
async function dumpSent(endpoint: string, input: Record<string, unknown>) {
  const dir = await debugDir();
  if (!dir) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const tag = `nano_${endpoint.split("/").pop() || "edit"}`;
  const urls = Array.isArray(input.image_urls) ? (input.image_urls as string[]) : [];
  const lines: string[] = [`endpoint: ${endpoint}`, `aspect_ratio: ${input.aspect_ratio ?? "-"}`, `images: ${urls.length}`, ""];
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    if (typeof u === "string" && u.startsWith("data:")) {
      const b = Buffer.from(u.split(",")[1] ?? "", "base64");
      const name = `${ts}_${tag}_img${i}${i === 0 ? "_TARGET" : "_REF"}.png`;
      await fsp.writeFile(path.join(dir, name), b);
      lines.push(`image[${i}] (${i === 0 ? "target piece" : "reference"}) -> ${name}`);
    } else {
      lines.push(`image[${i}] -> (hosted url) ${String(u).slice(0, 80)}`);
    }
  }
  lines.push("", "PROMPT:", String(input.prompt ?? ""));
  await fsp.writeFile(path.join(dir, `${ts}_${tag}_REQUEST.txt`), lines.join("\n"));
  console.log(`[nano-sent] ${tag} → ${dir} (${urls.length} image(s) + REQUEST.txt)`);
}
