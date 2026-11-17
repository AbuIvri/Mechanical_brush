import { OpenAI, toFile } from "openai";
import { Agent } from "node:https";
import { PNG } from "pngjs";
import { v4 as uuid } from "uuid";
import {
  type ImageProvider,
  dataUrlToBuffer,
  bufferToDataUrl,
} from "../ImageProvider.js";
import type {
  BaseGenerationRequest,
  GenerationResult,
  ProviderCapabilities,
  ModelInfo,
  ProviderOption,
  ValidationResult,
} from "../../../shared/types.js";
import { ASPECT_EDIT, ASPECT_GEN, GEN_RES, RECREATE_RES, UPSCALE_RES, REMOVEBG_RES, RATIO_RES, FILL_RES, PRESERVE, ASPECT_CONFORM, ALIGN_TO_SOURCE, TRANSPARENT_BG, EXPAND_BASE_PROMPT, RATIO_BASE_PROMPT } from "../options.js";
import {
  TRANSPARENT_MODELS,
  TRANSPARENT_PROMPT,
  UMAGE2_DEFAULT_MODEL,
  UMAGE2_MODELS,
  XQUALITY_MODELS,
  clampQuality,
} from "./Umage2Types.js";
import { pickSize, buildModePrompt, estimateCost, costFromUsage } from "./Umage2Mapper.js";
import { fillPrompt } from "../../../shared/editPrompts.js";

/**
 * Generic app mask -> OpenAI mask.
 * App mask: white (high luminance) pixels = regenerate this region.
 * OpenAI mask: the edited region must have alpha = 0 (fully transparent);
 * kept region opaque. We threshold on luminance and write alpha accordingly.
 */
function convertMaskToOpenAI(maskBuf: Buffer): Buffer {
  const src = PNG.sync.read(maskBuf);
  const out = new PNG({ width: src.width, height: src.height });
  for (let i = 0; i < src.data.length; i += 4) {
    const r = src.data[i];
    const g = src.data[i + 1];
    const b = src.data[i + 2];
    const a = src.data[i + 3];
    const lum = (r + g + b) / 3;
    const regen = a > 16 && lum > 128; // marked area
    // Kept region: opaque black; edited region: fully transparent.
    out.data[i] = 0;
    out.data[i + 1] = 0;
    out.data[i + 2] = 0;
    out.data[i + 3] = regen ? 0 : 255;
  }
  return PNG.sync.write(out);
}

/** Read width/height from a PNG buffer (IHDR at fixed offset). */
function pngSize(buf: Buffer): { w: number; h: number } {
  if (buf.length > 24 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  return { w: 1024, h: 1024 }; // safe fallback
}

/** Transparency was asked for, and this model can actually do it. */
function wantsTransparency(model: string, req: BaseGenerationRequest): boolean {
  return !!req.settings?.transparentBackground && TRANSPARENT_MODELS.has(model);
}

/** The charge OpenAI reported (from its token counts), or the size-table guess. */
function priced(model: string, usage: unknown, dims: { w: number; h: number }, req: BaseGenerationRequest) {
  const reported = costFromUsage(model, usage as any);
  return reported != null
    ? { costEstimate: reported, costReported: true }
    : { costEstimate: estimateCost(model, dims.w, dims.h, clampQuality(model, req.settings?.quality)), costReported: false };
}

export class Umage2Provider implements ImageProvider {
  readonly id = "umage2";
  readonly name = "umage2 (GPT Image)";
  readonly version = "1.0";

  private modelId: string;

  constructor(modelId: string = UMAGE2_DEFAULT_MODEL) {
    this.modelId = modelId;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsUpscale: true,
      supportsRecreate: true,
      supportsInpainting: true,
      supportsMasks: true,
      supportsTransparency: true,
      supportsReferenceImages: true,
      supportsMultipleReferenceImages: true,
      supportsNegativePrompt: false,
      supportsSeed: false,
      supportsVariations: true,
      supportsCustomOutputSize: true,
      maxInputImageSize: 50 * 1024 * 1024,
      maxReferenceImages: 8,
      supportedFormats: ["png", "jpeg", "webp"],
      notes:
        "Masked edits use the OpenAI images.edit endpoint. Mask white areas are regenerated.",
    };
  }

  getModels(): ModelInfo[] {
    return UMAGE2_MODELS;
  }

  getOptions(): ProviderOption[] {
    const xq = [...XQUALITY_MODELS];
    return [
      {
        key: "quality",
        label: "איכות",
        type: "select",
        default: "high",
        note: "משפיע על רמת הפירוט והעלות — לא על הרזולוציה",
        choices: [
          { value: "low", label: "נמוכה" },
          { value: "medium", label: "בינונית" },
          { value: "high", label: "גבוהה" },
          { value: "xhigh", label: "גבוהה מאוד", models: xq },
          { value: "max", label: "מקסימלית", models: xq },
          { value: "auto", label: "אוטו׳" },
        ],
      },
      ASPECT_EDIT,
      ASPECT_GEN,
      GEN_RES,
      RECREATE_RES,
      UPSCALE_RES,
      REMOVEBG_RES,
      RATIO_RES,
      FILL_RES,
      ASPECT_CONFORM,
      ALIGN_TO_SOURCE,
      // Only where the API accepts it: gpt-image-1 rejects background="transparent",
      // and a control that fails at the engine is worse than one that isn't there.
      ...(TRANSPARENT_MODELS.has(this.modelId) ? [TRANSPARENT_BG] : []),
      ...PRESERVE,
    ];
  }

  requiresApiKey(): boolean {
    return true;
  }

  /** One agent for the process, with TCP keep-alive on.
   *
   *  A generation can wait minutes for its image with not one byte moving on the socket.
   *  To a NAT table or a CDN edge that is an idle connection, and idle connections get
   *  dropped — which arrived as `read ECONNRESET`: the upload was fine, the wait was not.
   *  Measured while chasing it: a 2MB upload to this endpoint landed 4/4 through curl and
   *  6/6 through this same SDK (including after 70s idle), so neither the payload nor the
   *  socket pool was the problem. Keep-alive probes every 20s keep the connection alive
   *  through the wait, and clear a dead pooled socket instead of failing on it. */
  private static agent = new Agent({ keepAlive: true, keepAliveMsecs: 20_000 });

  private client(apiKey?: string): OpenAI {
    if (!apiKey) throw new Error("חסר מפתח API עבור umage2");
    return new OpenAI({ apiKey, httpAgent: Umage2Provider.agent });
  }

  async validateApiKey(apiKey: string | undefined): Promise<ValidationResult> {
    if (!apiKey) return { valid: false, message: "לא הוזן מפתח" };
    if (!/^sk-/.test(apiKey)) return { valid: false, message: "פורמט מפתח לא תקין" };
    try {
      await this.client(apiKey).models.list();
      return { valid: true };
    } catch (e: any) {
      return { valid: false, message: e?.message ?? "אימות נכשל" };
    }
  }

  private async runEdit(
    req: BaseGenerationRequest,
    prompt: string,
    apiKey?: string,
  ): Promise<GenerationResult> {
    const client = this.client(apiKey);
    if (!req.image) throw new Error("חסרה תמונת מקור");

    const model = req.modelId ?? this.modelId;
    const { buffer: imgBuf } = dataUrlToBuffer(req.image);
    const { w, h } = pngSize(imgBuf);
    const size = pickSize(model, w, h, req.settings);

    const images = [await toFile(imgBuf, "image.png", { type: "image/png" })];
    // Reference images become additional inputs when supported.
    if (req.references?.length) {
      for (const r of req.references) {
        const { buffer } = dataUrlToBuffer(r.src);
        images.push(await toFile(buffer, `ref-${uuid()}.png`, { type: "image/png" }));
      }
    }

    const params: any = {
      model,
      image: images.length === 1 ? images[0] : images,
      prompt: wantsTransparency(model, req) ? prompt + TRANSPARENT_PROMPT : prompt,
      size,
      quality: clampQuality(model, req.settings?.quality),
    };
    if (wantsTransparency(model, req)) {
      // Both are required: the alpha only survives in a format that has one.
      params.background = "transparent";
      params.output_format = "png";
    }
    if (req.mask) {
      const { buffer: maskBuf } = dataUrlToBuffer(req.mask);
      // Convert the app's generic mask (white = regenerate) into the
      // OpenAI convention: the EDITED region must be fully transparent.
      const openaiMask = convertMaskToOpenAI(maskBuf);
      params.mask = await toFile(openaiMask, "mask.png", { type: "image/png" });
    }

    const t0 = Date.now();
    const resp = await client.images.edit(params);
    const out = resp.data?.[0];
    if (!out?.b64_json) throw new Error("הספק לא החזיר תמונה");
    const outBuf = Buffer.from(out.b64_json, "base64");
    const dims = pngSize(outBuf);

    return {
      id: uuid(),
      providerId: this.id,
      modelId: model,
      images: [{ src: bufferToDataUrl(outBuf), width: dims.w, height: dims.h }],
      metadata: {
        latencyMs: Date.now() - t0,
        ...priced(model, (resp as any).usage, dims, req),
      },
    };
  }

  upscaleImage(req: BaseGenerationRequest, apiKey?: string) {
    return this.runEdit(req, buildModePrompt("upscale", req.prompt, req.settings), apiKey);
  }

  recreateImage(req: BaseGenerationRequest, apiKey?: string) {
    // Also the entry point for removebg — the mode picks the base prompt.
    return this.runEdit(req, buildModePrompt(req.mode ?? "recreate", req.prompt, req.settings), apiKey);
  }

  editImageWithMask(req: BaseGenerationRequest, apiKey?: string) {
    // Seamless in-place EDIT of the selected region (a crop of the source that
    // includes surrounding context). We deliberately edit the real content
    // rather than inpaint a hole, so the change respects what is already there.
    const prompt = fillPrompt(req.prompt, { contextImage: !!req.references?.length });
    return this.runEdit(req, prompt, apiKey);
  }

  expandImage(req: BaseGenerationRequest, apiKey?: string) {
    // Fixed base prompt; ratio (reformat) and directional expand have their own. The
    // user's own text is appended when present.
    const extra = req.prompt?.trim();
    const base = req.mode === "ratio" ? RATIO_BASE_PROMPT : EXPAND_BASE_PROMPT;
    const prompt = base + (extra ? ` ${extra}` : "");
    return this.runEdit(req, prompt, apiKey);
  }

  async generateImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult> {
    const client = this.client(apiKey);
    const model = req.modelId ?? this.modelId;
    // Honor the chosen aspect ratio + resolution. Without an explicit target,
    // pickSize used to blow everything up to the 2880×2880 pixel-budget ceiling.
    const ar = String(req.settings?.aspectRatio ?? "auto");
    const long = Number(req.settings?.genLongEdge) || 2048;
    let a = 1;
    if (ar !== "auto") {
      const [w0, h0] = ar.split(":").map(Number);
      if (w0 > 0 && h0 > 0) a = w0 / h0;
    }
    const tw = a >= 1 ? long : Math.round(long * a);
    const th = a >= 1 ? Math.round(long / a) : long;
    const size = pickSize(model, tw, th, { ...req.settings, outputWidth: tw, outputHeight: th });
    const transparent = wantsTransparency(model, req);
    const genPrompt = (req.prompt ?? "") + (transparent ? TRANSPARENT_PROMPT : "");
    const alpha = transparent ? { background: "transparent", output_format: "png" } : {};
    const t0 = Date.now();
    // With reference images, generate-from-scratch must go through the EDIT
    // endpoint (image-conditioned generation) — images.generate is text-only and
    // would silently ignore them. Mirrors Nano Banana / Reve behavior. We don't
    // reuse runEdit() here because it hard-requires req.image, which generate
    // mode never has: the references themselves are the input images.
    let resp;
    if (req.references?.length) {
      const refFiles = await Promise.all(
        req.references.map((r, i) =>
          toFile(dataUrlToBuffer(r.src).buffer, `ref-${i}.png`, { type: "image/png" }),
        ),
      );
      resp = await client.images.edit({
        model,
        image: refFiles.length === 1 ? refFiles[0] : refFiles,
        prompt: genPrompt,
        size: size as any,
        quality: clampQuality(model, req.settings?.quality) as any,
        ...alpha,
      } as any);
    } else {
      resp = await client.images.generate({
        model,
        prompt: genPrompt,
        size: size as any,
        quality: clampQuality(model, req.settings?.quality) as any,
        ...alpha,
      } as any);
    }
    const out = resp.data?.[0];
    if (!out?.b64_json) throw new Error("הספק לא החזיר תמונה");
    const outBuf = Buffer.from(out.b64_json, "base64");
    const dims = pngSize(outBuf);
    return {
      id: uuid(),
      providerId: this.id,
      modelId: model,
      images: [{ src: bufferToDataUrl(outBuf), width: dims.w, height: dims.h }],
      metadata: {
        latencyMs: Date.now() - t0,
        ...priced(model, (resp as any).usage, dims, req),
      },
    };
  }
}
