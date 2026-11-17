import { v4 as uuid } from "uuid";
import { recreateOverride } from "../../../shared/erasePrompts.js";
import { fillPrompt, recreatePrompt } from "../../../shared/editPrompts.js";
import { type ImageProvider } from "../ImageProvider.js";
import type {
  BaseGenerationRequest,
  GenerationResult,
  GenerationMode,
  GenerationSettings,
  ProviderCapabilities,
  ModelInfo,
  ProviderOption,
  ValidationResult,
} from "../../../shared/types.js";
import { ASPECT_EDIT_REVE, ASPECT_GEN_REVE, REVE_RES, FILL_RES, ASPECT_CONFORM, ALIGN_TO_SOURCE, RATIO_RES } from "../options.js";

const BASE = "https://api.reve.com";
const CREATE = "/v1/image/create";
const EDIT = "/v1/image/edit";
const REMIX = "/v1/image/remix";

const ASPECTS = ["16:9", "9:16", "3:2", "2:3", "4:3", "3:4", "1:1"];

/** Reve pricing: ~$0.04 per 30 credits ⇒ ~$0.00133 per credit. */
const USD_PER_CREDIT = 0.0013333;

function pngSize(buf: Buffer): { w: number; h: number } {
  if (buf.length > 24 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  return { w: 1024, h: 1024 };
}

/** Strip a data URL to raw base64 (Reve wants bare base64). */
function rawBase64(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

/**
 * Reve rejects large input images (INVALID_PARAMETER_VALUE) and downsamples
 * every edit to ~1MP internally anyway, so we shrink the source to a safe long
 * edge before sending. Loses nothing Reve would have used, and avoids the error.
 * Tested: 2496px input is accepted, 4992px is rejected — 2048 leaves headroom.
 */
const REVE_MAX_INPUT_EDGE = 2048;

async function fitForReve(dataUrl: string): Promise<string> {
  try {
    const { nativeImage } = await import("electron");
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return dataUrl;
    const { width, height } = img.getSize();
    const long = Math.max(width, height);
    if (long <= REVE_MAX_INPUT_EDGE) return dataUrl;
    const scale = REVE_MAX_INPUT_EDGE / long;
    const resized = img.resize({
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      quality: "best",
    });
    return resized.toDataURL();
  } catch {
    // Outside Electron (e.g. unit tests) — send as-is.
    return dataUrl;
  }
}

/** Reve only supports integer upscale factors 1, 2 or 4 (×3 fails). */
function allowedFactor(raw: unknown): number {
  const f = Math.min(4, Math.max(1, Number(raw) || 1));
  if (f >= 3) return 4;
  if (f >= 2) return 2;
  return 1;
}

function mapAspect(ar: string | undefined): string | undefined {
  if (!ar || ar === "auto") return undefined;
  if (ASPECTS.includes(ar)) return ar;
  if (ar === "21:9") return "16:9"; // closest supported
  return undefined;
}

function instructionFor(
  mode: GenerationMode,
  userPrompt: string | undefined,
  settings?: GenerationSettings,
): string {
  const p = userPrompt?.trim();
  if (mode === "upscale") {
    return (
      "Enhance resolution, sharpness and fine detail. Keep the composition, " +
      "colors and identity exactly the same. " + (p ?? "")
    ).trim();
  }
  if (mode === "recreate" && recreateOverride(settings)) {
    return `${recreateOverride(settings)}. ${p ?? ""}`.trim();
  }
  if (mode === "recreate") return recreatePrompt(p, settings);
  // fill — Reve gets no full-picture context image
  return fillPrompt(p, { contextImage: false });
}

export class ReveProvider implements ImageProvider {
  readonly id = "reve";
  readonly name = "Reve 2.0";
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
      supportsSeed: false,
      supportsVariations: false,
      supportsCustomOutputSize: false,
      maxReferenceImages: 6,
      supportedFormats: ["png", "jpeg", "webp"],
      notes:
        "Reve (Halfmoon) — מצוין ברינדור טקסט ובעריכה. יחס צלעות מתוך קבוצה; אפסקייל דרך postprocessing.",
    };
  }

  getModels(): ModelInfo[] {
    return [
      { id: "reve", label: "Reve 2.0 (איכותי)" },
      { id: "reve-fast", label: "Reve 2.0 Fast (מהיר/זול)" },
    ];
  }

  getOptions(): ProviderOption[] {
    return [
      ASPECT_EDIT_REVE,
      ASPECT_GEN_REVE,
      REVE_RES,
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
    if (!apiKey || !apiKey.startsWith("papi.")) {
      return { valid: false, message: "מפתח Reve לא תקין (מתחיל ב-papi.)" };
    }
    return { valid: true, message: "המפתח יישמר; אימות מלא בג'נרוט הראשון" };
  }

  private pickVersion(modelId: string | undefined, endpoint: string): string {
    // Only edit/remix support the *-fast variants.
    if (modelId === "reve-fast" && endpoint !== CREATE) return "latest-fast";
    return "latest";
  }

  private async call(
    endpoint: string,
    body: Record<string, unknown>,
    apiKey: string | undefined,
    mode: GenerationMode,
    modelId?: string,
  ): Promise<GenerationResult> {
    if (!apiKey) throw new Error("חסר מפתח Reve");
    const t0 = Date.now();
    let resp: Response;
    try {
      resp = await fetch(`${BASE}${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      throw new Error("אין חיבור ל-Reve. בדוק אינטרנט ונסה שוב.");
    }
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.image) {
      const code = data?.error_code ? `${data.error_code}: ` : "";
      throw new Error(`Reve נכשל — ${code}${data?.message || resp.status}`);
    }
    const buf = Buffer.from(data.image, "base64");
    const dims = pngSize(buf);
    return {
      id: uuid(),
      providerId: this.id,
      modelId: modelId ?? "reve",
      images: [{ src: `data:image/png;base64,${data.image}`, width: dims.w, height: dims.h }],
      metadata: {
        requestId: data.request_id,
        latencyMs: Date.now() - t0,
        costEstimate:
          typeof data.credits_used === "number"
            ? Math.round(data.credits_used * USD_PER_CREDIT * 10000) / 10000
            : undefined,
      },
    };
  }

  /** Edit / upscale / recreate / fill — image present. */
  private async edit(
    req: BaseGenerationRequest,
    mode: GenerationMode,
    apiKey: string | undefined,
  ): Promise<GenerationResult> {
    if (!req.image) throw new Error("חסרה תמונת מקור");
    // For fill, keep the crop's own aspect so it composites back exactly.
    const aspect = mode === "fill" ? undefined : mapAspect(req.settings?.aspectRatio);
    // Drop the app's auto-attached full-image context ref: any reference forces
    // Reve onto the REMIX endpoint (regenerate-from-refs), which drifts colors
    // and content — Reve's EDIT endpoint is far more faithful for fill. The
    // renderer's color-match step compensates for tone instead.
    const refs = (req.references ?? []).filter((r) => r.note !== "full-image context");
    let instruction = instructionFor(mode, req.prompt, req.settings);
    if (mode === "fill" && refs.length > 0) {
      instruction +=
        " The last reference image is a low-resolution view of the COMPLETE picture this crop " +
        "belongs to — use it only to understand the wider scene, lighting, scale and continuity. " +
        "Edit and return ONLY the crop.";
    }
    // Resolution above the ~1MP base comes from integer upscale postprocessing.
    let factor = allowedFactor(req.settings?.reveUpscale);
    if (mode === "upscale" && factor < 2) factor = 2; // upscale mode must actually upscale
    const postprocessing =
      factor >= 2 ? [{ process: "upscale", upscale_factor: factor }] : undefined;
    const tts = Math.min(5, Math.max(1, Number(req.settings?.testTimeScaling) || 1));

    // Shrink large inputs so Reve doesn't reject them (and to skip wasted upload).
    const mainImage = await fitForReve(req.image);

    if (refs.length > 0) {
      // Use remix when extra reference images are supplied.
      const refImages = await Promise.all(refs.map((r) => fitForReve(r.src)));
      const reference_images = [rawBase64(mainImage), ...refImages.map(rawBase64)].slice(0, 6);
      const body: Record<string, unknown> = {
        prompt: instruction,
        reference_images,
        version: this.pickVersion(req.modelId, REMIX),
      };
      if (aspect) body.aspect_ratio = aspect;
      if (postprocessing) body.postprocessing = postprocessing;
      if (tts > 1) body.test_time_scaling = tts;
      return this.call(REMIX, body, apiKey, mode, req.modelId);
    }

    const body: Record<string, unknown> = {
      edit_instruction: instruction,
      reference_image: rawBase64(mainImage),
      version: this.pickVersion(req.modelId, EDIT),
    };
    if (aspect) body.aspect_ratio = aspect;
    if (postprocessing) body.postprocessing = postprocessing;
    if (tts > 1) body.test_time_scaling = tts;
    return this.call(EDIT, body, apiKey, mode, req.modelId);
  }

  upscaleImage(req: BaseGenerationRequest, apiKey?: string) {
    return this.edit(req, "upscale", apiKey);
  }
  recreateImage(req: BaseGenerationRequest, apiKey?: string) {
    return this.edit(req, "recreate", apiKey);
  }
  editImageWithMask(req: BaseGenerationRequest, apiKey?: string) {
    return this.edit(req, "fill", apiKey);
  }

  expandImage(): Promise<GenerationResult> {
    throw new Error("Reve לא תומך בהרחבה גנרטיבית — השתמש ב-umage2 או Nano Banana 2.");
  }

  async generateImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult> {
    const aspect = mapAspect(req.settings?.aspectRatio);
    const refs = req.references ?? [];
    const tts = Math.min(5, Math.max(1, Number(req.settings?.testTimeScaling) || 1));
    const factor = allowedFactor(req.settings?.reveUpscale);
    const postprocessing =
      factor >= 2 ? [{ process: "upscale", upscale_factor: factor }] : undefined;
    if (refs.length > 0) {
      const refImages = await Promise.all(refs.map((r) => fitForReve(r.src)));
      const body: Record<string, unknown> = {
        prompt: req.prompt ?? "",
        reference_images: refImages.map(rawBase64).slice(0, 6),
        version: "latest",
      };
      if (aspect) body.aspect_ratio = aspect;
      if (tts > 1) body.test_time_scaling = tts;
      if (postprocessing) body.postprocessing = postprocessing;
      return this.call(REMIX, body, apiKey, "generate", req.modelId);
    }
    const body: Record<string, unknown> = {
      prompt: req.prompt ?? "",
      version: "latest",
    };
    if (aspect) body.aspect_ratio = aspect;
    if (tts > 1) body.test_time_scaling = tts;
    if (postprocessing) body.postprocessing = postprocessing;
    return this.call(CREATE, body, apiKey, "generate", req.modelId);
  }
}
