import { OpenAI } from "openai";
import { recreateOverride } from "../../../shared/erasePrompts.js";
import { fillPrompt, recreatePrompt } from "../../../shared/editPrompts.js";
import { v4 as uuid } from "uuid";
import { debugDir } from "../../debugDump.js";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { type ImageProvider } from "../ImageProvider.js";
import type {
  BaseGenerationRequest,
  GenerationResult,
  ProviderCapabilities,
  ModelInfo,
  ProviderOption,
  ValidationResult,
} from "../../../shared/types.js";
import { ASPECT_GEN_REVE, ASPECT_EDIT_REVE, GROK_RES, EXPAND_BASE_PROMPT, RATIO_BASE_PROMPT } from "../options.js";

// Grok (xAI) image generation. The /v1 API is OpenAI-compatible, so we reuse the
// OpenAI SDK with a baseURL override — the exact same pattern the prompt-assistant
// chat already uses for Grok (electron/ipc/handlers.ts).
const XAI_BASE_URL = "https://api.x.ai/v1";

// Grok Imagine models (grok-2-image-1212 was deprecated 2026-02-24). All accept
// aspect_ratio (incl. "auto") and resolution ("1k" | "2k"), and all go through the same
// two endpoints. docs.x.ai/developers/model-capabilities/imagine.
const GROK_IMAGE_2 = "grok-imagine-image-2.0";
const GROK_QUALITY = "grok-imagine-image-quality";
const GROK_FAST = "grok-imagine-image";

// Published xAI output pricing per image (USD), by model + resolution tier.
function estimateCost(model: string, resolution: string): number {
  if (model === GROK_IMAGE_2) return 0.04; // one published price, both tiers
  if (model === GROK_QUALITY) return resolution === "1k" ? 0.05 : 0.07;
  return 0.02; // grok-imagine-image — same price at 1k/2k
}

// Max source images the /images/edits endpoint accepts per docs.x.ai.
const MAX_REFS = 3;

/** Minimal dims reader for PNG and JPEG buffers (xAI returns JPG). */
function imageSize(buf: Buffer): { w: number; h: number } {
  // PNG: IHDR at fixed offset.
  if (buf.length > 24 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: scan markers for SOF0..SOF15 (excluding DHT/DAC/RST) frames.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
  }
  return { w: 1024, h: 768 };
}

export class GrokProvider implements ImageProvider {
  readonly id = "grok";
  readonly name = "Grok Image (xAI)";
  readonly version = "1.0";

  private client(apiKey?: string): OpenAI {
    if (!apiKey) throw new Error("חסר מפתח xAI ל-Grok. הזן אותו בהגדרות.");
    return new OpenAI({ apiKey, baseURL: XAI_BASE_URL });
  }

  // xAI's /images/edits endpoint is a custom JSON API (image_url/image_urls +
  // aspect_ratio/resolution) — NOT the OpenAI SDK's multipart images.edit(), so we
  // call it directly. It accepts data URIs for image_url(s), so references pass
  // through unchanged.
  private async editWithReferences(
    body: Record<string, unknown>,
    apiKey: string,
  ): Promise<{ b64_json?: string }> {
    await dumpSent(body).catch(() => {});
    const resp = await fetch(`${XAI_BASE_URL}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(`Grok נכשל: ${data?.error?.message || data?.error || resp.status}`);
    }
    return data?.data?.[0] ?? {};
  }

  getCapabilities(): ProviderCapabilities {
    return {
      // Output tops out at 2k — not an upscaler.
      supportsUpscale: false,
      // /images/edits does prompt-driven edits on source image(s) — recreate, the
      // app's crop-based fill (no mask needed, like Nano Banana), and reframing.
      supportsRecreate: true,
      supportsInpainting: true,
      supportsMasks: false,
      supportsTransparency: false,
      supportsReferenceImages: true,
      supportsMultipleReferenceImages: true,
      supportsNegativePrompt: false,
      supportsSeed: false,
      supportsVariations: true,
      supportsCustomOutputSize: false,
      // The edits endpoint takes 3 images TOTAL — with a source image attached,
      // that leaves room for 2 references.
      maxReferenceImages: MAX_REFS,
      supportedFormats: ["jpeg", "png"],
      notes: "Grok (xAI) — יצירה, יצירה מחדש, מילוי ושינוי פורמט (עד 3 תמונות לבקשה). בלי אפסקייל; פלט עד 2K.",
    };
  }

  getModels(): ModelInfo[] {
    return [
      { id: GROK_IMAGE_2, label: "Grok Imagine 2.0 (החדש — מומלץ)" },
      { id: GROK_QUALITY, label: "Grok Imagine Quality" },
      { id: GROK_FAST, label: "Grok Imagine (מהיר וזול)" },
    ];
  }

  getOptions(): ProviderOption[] {
    // xAI supports aspect_ratio (subset matching our list, no 21:9) + 1k/2k tiers.
    return [ASPECT_GEN_REVE, ASPECT_EDIT_REVE, GROK_RES];
  }

  requiresApiKey(): boolean {
    return true;
  }

  async validateApiKey(apiKey: string | undefined): Promise<ValidationResult> {
    if (!apiKey || !apiKey.trim().startsWith("xai-")) {
      return { valid: false, message: "מפתח xAI לא תקין (מתחיל ב-xai-)" };
    }
    try {
      await this.client(apiKey.trim()).models.list();
      return { valid: true };
    } catch (e: any) {
      return { valid: false, message: e?.message ?? "אימות מול xAI נכשל" };
    }
  }

  async generateImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult> {
    const model = req.modelId ?? GROK_IMAGE_2;
    const ar = String(req.settings?.aspectRatio ?? "auto");
    const resolution = String(req.settings?.grokResolution ?? "2k");
    const t0 = Date.now();

    let out: { b64_json?: string };
    if (req.references?.length) {
      if (!apiKey) throw new Error("חסר מפתח xAI ל-Grok. הזן אותו בהגדרות.");
      const urls = req.references.slice(0, MAX_REFS).map((r) => r.src);
      // Exact /images/edits schema (docs.x.ai REST reference): a single source goes
      // as image:{url}, multiple as images:[{url},…] — xAI silently IGNORES unknown
      // fields, so a wrong field name degrades to plain text-to-image.
      const body: Record<string, unknown> = {
        model,
        prompt: req.prompt ?? "",
        response_format: "b64_json",
        aspect_ratio: ar,
        resolution,
        ...(urls.length === 1
          ? { image: { url: urls[0] } }
          : { images: urls.map((u) => ({ url: u })) }),
      };
      out = await this.editWithReferences(body, apiKey);
    } else {
      // aspect_ratio/resolution are xAI extensions the OpenAI SDK doesn't type —
      // they pass through the request body as-is.
      const resp = await this.client(apiKey).images.generate({
        model,
        prompt: req.prompt ?? "",
        n: 1,
        response_format: "b64_json",
        aspect_ratio: ar,
        resolution,
      } as any);
      out = resp.data?.[0] ?? {};
    }
    if (!out?.b64_json) throw new Error("Grok לא החזיר תמונה");
    const buf = Buffer.from(out.b64_json, "base64");
    const dims = imageSize(buf);
    const mime = buf[0] === 0x89 ? "image/png" : "image/jpeg";
    return {
      id: uuid(),
      providerId: this.id,
      modelId: model,
      images: [{ src: `data:${mime};base64,${out.b64_json}`, width: dims.w, height: dims.h }],
      metadata: { latencyMs: Date.now() - t0, costEstimate: estimateCost(model, resolution) },
    };
  }

  /** Shared edit runner: source image first, then references (3 images total),
   *  through /images/edits, returning the standard GenerationResult. */
  private async runEdit(
    req: BaseGenerationRequest,
    prompt: string,
    apiKey: string | undefined,
    aspectOverride?: string,
  ): Promise<GenerationResult> {
    if (!apiKey) throw new Error("חסר מפתח xAI ל-Grok. הזן אותו בהגדרות.");
    if (!req.image) throw new Error("חסרה תמונת מקור");
    const model = req.modelId ?? GROK_IMAGE_2;
    const resolution = String(req.settings?.grokResolution ?? "2k");
    const ar = aspectOverride ?? String(req.settings?.aspectRatio ?? "auto");
    const urls = [req.image, ...(req.references ?? []).map((r) => r.src)].slice(0, MAX_REFS);
    const t0 = Date.now();
    const out = await this.editWithReferences(
      {
        model,
        prompt,
        response_format: "b64_json",
        aspect_ratio: ar,
        resolution,
        ...(urls.length === 1 ? { image: { url: urls[0] } } : { images: urls.map((u) => ({ url: u })) }),
      },
      apiKey,
    );
    if (!out?.b64_json) throw new Error("Grok לא החזיר תמונה");
    const buf = Buffer.from(out.b64_json, "base64");
    const dims = imageSize(buf);
    const mime = buf[0] === 0x89 ? "image/png" : "image/jpeg";
    return {
      id: uuid(),
      providerId: this.id,
      modelId: model,
      images: [{ src: `data:${mime};base64,${out.b64_json}`, width: dims.w, height: dims.h }],
      metadata: { latencyMs: Date.now() - t0, costEstimate: estimateCost(model, resolution) },
    };
  }

  recreateImage(req: BaseGenerationRequest, apiKey?: string) {
    const override = recreateOverride(req.settings);
    const prompt = override
      ? `${override}. ${req.prompt?.trim() ?? ""}`.trim()
      : recreatePrompt(req.prompt, req.settings);
    return this.runEdit(req, prompt, apiKey);
  }

  editImageWithMask(req: BaseGenerationRequest, apiKey?: string) {
    // The app's fill flow sends a CROP to edit in place (no mask) + a low-res view
    // of the whole picture as the LAST reference — same contract as Nano Banana.
    const prompt = fillPrompt(req.prompt, { contextImage: !!req.references?.length });
    // 3 images total; keep the LAST reference (the full-picture context the prompt
    // points at) when truncating.
    const refs = req.references ?? [];
    const kept = refs.length > MAX_REFS - 1 ? [...refs.slice(0, MAX_REFS - 2), refs[refs.length - 1]] : refs;
    // The crop's own shape must be preserved — "auto" keeps the source framing.
    return this.runEdit({ ...req, references: kept }, prompt, apiKey, "auto");
  }

  expandImage(req: BaseGenerationRequest, apiKey?: string) {
    const extra = req.prompt?.trim();
    const base = req.mode === "ratio" ? RATIO_BASE_PROMPT : EXPAND_BASE_PROMPT;
    return this.runEdit(req, base + (extra ? ` ${extra}` : ""), apiKey);
  }

  upscaleImage(): Promise<GenerationResult> {
    throw new Error("Grok לא תומך באפסקייל (פלט עד 2K) — בחר מנוע אחר, למשל Crystal או GPT.");
  }
}

/** Dump the exact /images/edits request (every source image + the full body) into
 *  <userData>/debug/ — xAI silently ignores unknown fields, so this is the only way
 *  to verify what was actually sent. Mirrors Nano Banana's dumpSent. */
async function dumpSent(body: Record<string, unknown>) {
  const dir = await debugDir();
  if (!dir) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const single = body.image as { url?: string } | undefined;
  const multi = body.images as { url?: string }[] | undefined;
  const urls = (single ? [single] : multi ?? []).map((x) => x?.url ?? "");
  const lines: string[] = [
    "endpoint: /v1/images/edits",
    `model: ${body.model}`,
    `aspect_ratio: ${body.aspect_ratio} · resolution: ${body.resolution}`,
    `images: ${urls.length}`,
    "",
  ];
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    if (u.startsWith("data:")) {
      const name = `${ts}_grok_edit_img${i}_REF.png`;
      await fsp.writeFile(path.join(dir, name), Buffer.from(u.split(",")[1] ?? "", "base64"));
      lines.push(`image[${i}] -> ${name}`);
    } else {
      lines.push(`image[${i}] -> (url) ${u.slice(0, 80)}`);
    }
  }
  lines.push("", "PROMPT:", String(body.prompt ?? ""));
  await fsp.writeFile(path.join(dir, `${ts}_grok_edit_REQUEST.txt`), lines.join("\n"));
  console.log(`[grok-sent] → ${dir} (${urls.length} image(s) + REQUEST.txt)`);
}
