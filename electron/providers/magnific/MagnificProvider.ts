import { v4 as uuid } from "uuid";
import { type ImageProvider } from "../ImageProvider.js";
import type {
  BaseGenerationRequest,
  GenerationResult,
  ProviderCapabilities,
  ModelInfo,
  ProviderOption,
  ValidationResult,
} from "../../../shared/types.js";
import { MAGNIFIC_SCALE, MAGNIFIC_OPTIMIZED, MAGNIFIC_ENGINE, MAGNIFIC_CREATIVITY } from "../options.js";
import { REQUEST_MS, POLL_MS, DOWNLOAD_MS } from "../timeouts.js";

// Magnific upscaler is served by the Freepik API (Magnific was acquired by
// Freepik). Host + header are isolated here so a pure magnific.com key can be
// swapped in by changing these two constants.
const BASE = "https://api.freepik.com/v1/ai/image-upscaler";
const KEY_HEADER = "x-freepik-api-key";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // upscales can take a couple of minutes

/** Rough estimate (USD): a 2x upscale ~ $0.10, 4x ~ $0.20. */
function estimateCost(scale: string): number {
  return scale === "4x" ? 0.2 : 0.1;
}

function rawBase64(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MagnificProvider implements ImageProvider {
  readonly id = "magnific";
  readonly name = "Magnific (אפסקייל)";
  readonly version = "1.0";

  getCapabilities(): ProviderCapabilities {
    return {
      supportsUpscale: true,
      supportsRecreate: false,
      supportsInpainting: false,
      supportsMasks: false,
      supportsTransparency: false,
      supportsReferenceImages: false,
      supportsMultipleReferenceImages: false,
      supportsNegativePrompt: false,
      supportsSeed: false,
      supportsVariations: false,
      supportsCustomOutputSize: false,
      maxReferenceImages: 0,
      supportedFormats: ["png", "jpeg"],
      notes: "Magnific — אפסקייל איכותי עם הוספת פרטים (creative). אפסקייל בלבד.",
    };
  }

  getModels(): ModelInfo[] {
    return [{ id: "magnific-upscaler", label: "Magnific Upscaler" }];
  }

  getOptions(): ProviderOption[] {
    return [MAGNIFIC_SCALE, MAGNIFIC_OPTIMIZED, MAGNIFIC_ENGINE, MAGNIFIC_CREATIVITY];
  }

  requiresApiKey(): boolean {
    return true;
  }

  async validateApiKey(apiKey: string | undefined): Promise<ValidationResult> {
    if (!apiKey || apiKey.trim().length < 8) {
      return { valid: false, message: "מפתח Magnific/Freepik חסר או קצר מדי" };
    }
    return { valid: true, message: "המפתח יישמר; אימות מלא בהרצה הראשונה" };
  }

  // --- the only supported mode ---
  async upscaleImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult> {
    if (!apiKey) throw new Error("חסר מפתח API ל-Magnific");
    if (!req.image) throw new Error("חסרה תמונת מקור לאפסקייל");
    const s = req.settings ?? {};
    const scale = (s.magnificScale as string) || "2x";
    const t0 = Date.now();

    const body: Record<string, unknown> = {
      image: rawBase64(req.image),
      scale_factor: scale,
      optimized_for: (s.magnificOptimized as string) || "standard",
      engine: (s.magnificEngine as string) || "automatic",
      creativity: Number(s.magnificCreativity ?? 0),
      hdr: 0,
      resemblance: 0,
      fractality: 0,
    };
    if (req.prompt?.trim()) body.prompt = req.prompt.trim();

    // 1) Create the task.
    const createResp = await fetch(BASE, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_MS),
      headers: { "content-type": "application/json", [KEY_HEADER]: apiKey },
      body: JSON.stringify(body),
    });
    const created: any = await createResp.json().catch(() => ({}));
    if (!createResp.ok) {
      const msg = created?.message || created?.error || `שגיאה ${createResp.status}`;
      if (createResp.status === 401 || createResp.status === 403) {
        throw new Error(`Magnific — גישה נדחתה (${createResp.status}). בדוק את מפתח ה-API בהגדרות.`);
      }
      throw new Error(`Magnific נכשל ביצירת המשימה: ${msg}`);
    }
    const taskId = created?.data?.task_id || created?.data?.id || created?.task_id;
    if (!taskId) throw new Error("Magnific לא החזיר מזהה משימה");

    // 2) Poll until COMPLETED.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let resultUrl = "";
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const sResp = await fetch(`${BASE}/${taskId}`, { headers: { [KEY_HEADER]: apiKey }, signal: AbortSignal.timeout(POLL_MS) });
      const sj: any = await sResp.json().catch(() => ({}));
      const status = (sj?.data?.status || sj?.status || "").toUpperCase();
      if (status === "COMPLETED" || status === "SUCCESS" || status === "DONE") {
        const gen = sj?.data?.generated ?? sj?.data?.images ?? sj?.generated ?? [];
        resultUrl = Array.isArray(gen) ? gen[0] : gen;
        break;
      }
      if (status === "FAILED" || status === "ERROR") {
        throw new Error("Magnific — האפסקייל נכשל בצד השרת");
      }
    }
    if (!resultUrl) throw new Error("Magnific — תם הזמן הקצוב לאפסקייל (נסה שוב)");

    // 3) Fetch the result and return it as a data URL (CSP-safe, never expires).
    const imgResp = await fetch(resultUrl, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    const buf = Buffer.from(await imgResp.arrayBuffer());
    const ct = imgResp.headers.get("content-type") || "image/png";
    const src = `data:${ct};base64,${buf.toString("base64")}`;

    // Result dims: prefer PNG header; otherwise derive from source × scale factor
    // (Magnific upscales by exactly the chosen factor).
    let dims = pngSize(buf);
    if (!dims.w || !dims.h) {
      const srcDims = pngSize(Buffer.from(rawBase64(req.image), "base64"));
      const factor = scale === "4x" ? 4 : 2;
      dims = srcDims.w
        ? { w: srcDims.w * factor, h: srcDims.h * factor }
        : { w: 2048, h: 2048 };
    }

    return {
      id: uuid(),
      providerId: this.id,
      modelId: "magnific-upscaler",
      images: [{ src, width: dims.w, height: dims.h }],
      metadata: { latencyMs: Date.now() - t0, costEstimate: estimateCost(scale) },
    };
  }

  recreateImage(): Promise<GenerationResult> {
    throw new Error("Magnific תומך באפסקייל בלבד — בחר מצב 'אפסקייל'.");
  }
  editImageWithMask(): Promise<GenerationResult> {
    throw new Error("Magnific תומך באפסקייל בלבד — אין מילוי גנרטיבי.");
  }
  expandImage(): Promise<GenerationResult> {
    throw new Error("Magnific תומך באפסקייל בלבד — אין הרחבה גנרטיבית.");
  }
  generateImage(): Promise<GenerationResult> {
    throw new Error("Magnific תומך באפסקייל בלבד — אין יצירה מטקסט.");
  }
}

function pngSize(buf: Buffer): { w: number; h: number } {
  if (buf.length > 24 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  return { w: 0, h: 0 };
}
