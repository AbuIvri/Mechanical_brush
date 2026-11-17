import { v4 as uuid } from "uuid";
import { type ImageProvider, dataUrlToBuffer } from "../ImageProvider.js";
import type {
  BaseGenerationRequest,
  GenerationResult,
  ProviderCapabilities,
  ModelInfo,
  ProviderOption,
  ValidationResult,
} from "../../../shared/types.js";
import { CRYSTAL_SCALE, CRYSTAL_CREATIVITY } from "../options.js";
import { REQUEST_MS, POLL_MS, DOWNLOAD_MS } from "../timeouts.js";

// Crystal Upscaler (philz1337x, powered by Clarity AI) runs on Replicate.
// The model endpoint runs the latest version without needing a version hash.
const MODEL = "philz1337x/crystal-upscaler";
const PREDICT_URL = `https://api.replicate.com/v1/models/${MODEL}/predictions`;
const FILES_URL = "https://api.replicate.com/v1/files";
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Upload the source to Replicate's file store and return a served URL. Inlining a
 *  large image as a data URL in the request body can interrupt the prediction. */
async function uploadToReplicate(dataUrl: string, apiKey: string): Promise<string> {
  const { buffer, mime } = dataUrlToBuffer(dataUrl);
  const fd = new FormData();
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
  fd.append("content", new Blob([new Uint8Array(buffer)], { type: mime }), `source.${ext}`);
  const resp = await fetch(FILES_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: fd,
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const j: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j?.detail || `העלאת התמונה ל-Replicate נכשלה (${resp.status})`);
  const url = j?.urls?.get;
  if (!url) throw new Error("Replicate לא החזיר כתובת לקובץ שהועלה");
  return url;
}

/** Replicate billing is per-second; a rough per-run estimate. */
function estimateCost(scale: number): number {
  return scale >= 6 ? 0.06 : scale >= 4 ? 0.04 : 0.03;
}

function pngSize(buf: Buffer): { w: number; h: number } {
  if (buf.length > 24 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  return { w: 0, h: 0 };
}
function rawBase64(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CrystalProvider implements ImageProvider {
  readonly id = "crystal";
  readonly name = "Crystal Upscaler (אפסקייל)";
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
      notes: "Crystal Upscaler (Clarity AI) — אפסקייל חד ומדויק, מצוין לפנים ופורטרטים. דרך Replicate.",
    };
  }

  getModels(): ModelInfo[] {
    return [{ id: "crystal-upscaler", label: "Crystal Upscaler (Clarity AI)" }];
  }

  getOptions(): ProviderOption[] {
    return [CRYSTAL_SCALE, CRYSTAL_CREATIVITY];
  }

  requiresApiKey(): boolean {
    return true;
  }

  async validateApiKey(apiKey: string | undefined): Promise<ValidationResult> {
    if (!apiKey || apiKey.trim().length < 8) {
      return { valid: false, message: "טוקן Replicate חסר (מתחיל ב-r8_)" };
    }
    return { valid: true, message: "הטוקן יישמר; אימות מלא בהרצה הראשונה" };
  }

  async upscaleImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult> {
    if (!apiKey) throw new Error("חסר טוקן Replicate ל-Crystal");
    if (!req.image) throw new Error("חסרה תמונת מקור לאפסקייל");
    const s = req.settings ?? {};
    const scale = Number(s.crystalScale ?? 2);
    const t0 = Date.now();

    // Upload the source once, then reference it by URL (robust for large images).
    const imageUrl = await uploadToReplicate(req.image, apiKey);

    const runOnce = async (): Promise<any> => {
      const createResp = await fetch(PREDICT_URL, {
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_MS),
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          input: {
            image: imageUrl,
            scale_factor: scale,
            output_format: "png",
            ...(s.crystalCreativity != null ? { creativity: Number(s.crystalCreativity) } : {}),
          },
        }),
      });
      let pred: any = await createResp.json().catch(() => ({}));
      if (!createResp.ok) {
        const msg = pred?.detail || pred?.title || `שגיאה ${createResp.status}`;
        if (createResp.status === 401 || createResp.status === 402) {
          throw new Error(`Crystal/Replicate — גישה נדחתה (${createResp.status}). בדוק את הטוקן / היתרה בהגדרות.`);
        }
        throw new Error(`Crystal נכשל: ${msg}`);
      }
      const getUrl: string | undefined = pred?.urls?.get;
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (pred?.status !== "succeeded" && pred?.status !== "failed" && pred?.status !== "canceled") {
        if (Date.now() > deadline) throw new Error("Crystal — תם הזמן הקצוב לאפסקייל");
        if (!getUrl) break;
        await sleep(POLL_INTERVAL_MS);
        const r = await fetch(getUrl, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(POLL_MS) });
        pred = await r.json().catch(() => pred);
      }
      return pred;
    };

    // "Prediction interrupted" (code PA) is a transient Replicate condition — retry once.
    let pred = await runOnce();
    const interrupted = (p: any) => /interrupted|code:\s*PA/i.test(String(p?.error ?? ""));
    if (pred?.status !== "succeeded" && interrupted(pred)) {
      await sleep(1500);
      pred = await runOnce();
    }
    if (pred?.status === "failed" || pred?.status === "canceled") {
      throw new Error(`Crystal — האפסקייל נכשל${pred?.error ? ": " + pred.error : ""}`);
    }

    // Output is a URI string or an array with one URI.
    const out = pred?.output;
    const resultUrl: string = Array.isArray(out) ? out[0] : out;
    if (!resultUrl) throw new Error("Crystal לא החזיר תמונה");

    const imgResp = await fetch(resultUrl, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    const buf = Buffer.from(await imgResp.arrayBuffer());
    const ct = imgResp.headers.get("content-type") || "image/png";
    const src = `data:${ct};base64,${buf.toString("base64")}`;

    let dims = pngSize(buf);
    if (!dims.w || !dims.h) {
      const srcDims = pngSize(Buffer.from(rawBase64(req.image), "base64"));
      dims = srcDims.w ? { w: srcDims.w * scale, h: srcDims.h * scale } : { w: 2048, h: 2048 };
    }

    return {
      id: uuid(),
      providerId: this.id,
      modelId: "crystal-upscaler",
      images: [{ src, width: dims.w, height: dims.h }],
      metadata: { latencyMs: Date.now() - t0, costEstimate: estimateCost(scale) },
    };
  }

  recreateImage(): Promise<GenerationResult> {
    throw new Error("Crystal תומך באפסקייל בלבד — בחר מצב 'אפסקייל'.");
  }
  editImageWithMask(): Promise<GenerationResult> {
    throw new Error("Crystal תומך באפסקייל בלבד — אין מילוי גנרטיבי.");
  }
  expandImage(): Promise<GenerationResult> {
    throw new Error("Crystal תומך באפסקייל בלבד — אין הרחבה גנרטיבית.");
  }
  generateImage(): Promise<GenerationResult> {
    throw new Error("Crystal תומך באפסקייל בלבד — אין יצירה מטקסט.");
  }
}
