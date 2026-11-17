// Per-file batch runner — pure "data URL in → data URL out" helpers that call the
// stateless engine IPC (window.mbrush.generate) directly. No project is opened and
// the global store is never touched, so a batch never disturbs the open work.
import { downscaleToMax, imageSize, buildExpand, coverImage } from "./compositing";
import type { GenerationSettings, GenerationMode, ProviderInfo } from "../shared/types";

/** The subset of modes that make sense without a per-image marked region. */
export type BatchMode = "recreate" | "upscale" | "ratio" | "removebg";
export const BATCH_MODES: GenerationMode[] = ["recreate", "upscale", "ratio", "removebg"];

export interface BatchAction {
  mode: BatchMode;
  prompt: string;
  settings: GenerationSettings;
  providerId: string;
  modelId: string;
}

/** The long edge a run targets, given the mode and the user's resolution choice.
 *  Shared with the store so the batch dialog cannot ignore a resolution the user picked
 *  — which is exactly what happened while this file carried its own hard-coded ladder. */
export function targetLongEdge(
  mode: GenerationMode,
  settings: GenerationSettings | undefined,
  srcLongEdge: number,
): number {
  if (mode === "upscale") return Number(settings?.upscaleLongEdge) || 3840;
  if (mode === "recreate") return Number(settings?.recreateLongEdge) || srcLongEdge;
  if (mode === "removebg") return Number(settings?.removebgLongEdge) || srcLongEdge;
  return 1536;
}

/** Output dims for an explicit aspect choice — mirrors the derivation generate()
 *  uses (store.ts). Returns null on "auto". */
export function aspectOutputDims(
  mode: GenerationMode,
  aspectRatio: string | undefined,
  settings?: GenerationSettings,
  srcLongEdge = 2048,
): { outputWidth: number; outputHeight: number } | null {
  if (!aspectRatio || aspectRatio === "auto") return null;
  const [aw, ah] = aspectRatio.split(":").map(Number);
  if (!(aw > 0) || !(ah > 0)) return null;
  const a = aw / ah;
  const longEdge = targetLongEdge(mode, settings, srcLongEdge);
  return a >= 1
    ? { outputWidth: longEdge, outputHeight: Math.round(longEdge / a) }
    : { outputWidth: Math.round(longEdge * a), outputHeight: longEdge };
}

export interface BatchItemResult {
  src: string;
  width: number;
  height: number;
  cost: number;
}

/** Run ONE batch action on one image. Throws with a readable message on failure. */
export async function runBatchItem(
  srcDataUrl: string,
  action: BatchAction,
  provider: ProviderInfo | undefined,
): Promise<BatchItemResult> {
  const fit = await downscaleToMax(srcDataUrl, 4096);
  const img = fit.src;
  const { providerId, modelId, mode } = action;
  const prompt = action.prompt.trim() || undefined;
  const settings: GenerationSettings = { ...action.settings };
  if (mode === "removebg") {
    // The mode IS these settings — mirrors the store, so a batch and a single run
    // cannot produce different things from the same choice.
    settings.transparentBackground = true;
    settings.preserveIdentity = true;
    settings.preserveGeometry = true;
    settings.preserveColor = true;
  }

  if (mode === "ratio") {
    // Mirror runRatio: mask engines get the centered-extend + margin mask; others
    // (Gemini-style) get the bare image + target aspect. Either way the returned
    // image is used directly, cover-cropped to the exact target ratio.
    const target = String(settings.ratioTarget ?? "16:9");
    const [aw, ah] = target.split(":").map(Number);
    const ta = aw / ah;
    if (!isFinite(ta) || ta <= 0) throw new Error("יחס יעד לא תקין");
    const dims = await imageSize(img);
    if (Math.abs(ta - dims.width / dims.height) / (dims.width / dims.height) < 0.01) {
      // Already at the target ratio — pass through unchanged (no cost).
      return { src: img, width: dims.width, height: dims.height, cost: 0 };
    }
    const maskCapable = !!provider?.capabilities.supportsMasks;
    if (maskCapable) {
      const built = await buildExpand(img, ta, 4096);
      if (!built) return { src: img, width: dims.width, height: dims.height, cost: 0 };
      const res = await window.mbrush.generate({
        providerId,
        modelId,
        mode: "ratio",
        prompt,
        image: built.extended,
        mask: built.mask,
        settings: { ...settings, outputWidth: built.W2, outputHeight: built.H2 },
      });
      if (!res.ok || !res.data?.images?.[0]) throw new Error(res.error ?? "שינוי הפורמט נכשל");
      const src = await coverImage(res.data.images[0].src, built.W2, built.H2);
      return { src, width: built.W2, height: built.H2, cost: res.data.metadata?.costEstimate ?? 0 };
    }
    const res = await window.mbrush.generate({
      providerId,
      modelId,
      mode: "ratio",
      prompt,
      image: img,
      settings: { ...settings, aspectRatio: target },
    });
    if (!res.ok || !res.data?.images?.[0]) throw new Error(res.error ?? "שינוי הפורמט נכשל");
    let W2: number, H2: number;
    if (ta > dims.width / dims.height) {
      H2 = dims.height;
      W2 = Math.round(dims.height * ta);
    } else {
      W2 = dims.width;
      H2 = Math.round(dims.width / ta);
    }
    const longEdge = Math.max(W2, H2);
    const cap = Number(settings.ratioLongEdge) || 4096;
    if (longEdge > cap) {
      const k = cap / longEdge;
      W2 = Math.round(W2 * k);
      H2 = Math.round(H2 * k);
    }
    const src = await coverImage(res.data.images[0].src, W2, H2);
    return { src, width: W2, height: H2, cost: res.data.metadata?.costEstimate ?? 0 };
  }

  // recreate / upscale — one direct call. Same derivation as the store: the chosen
  // resolution sets the long edge, and the source framing is scaled to it.
  const d = await imageSize(img);
  const srcLong = Math.max(d.width, d.height);
  const dims = aspectOutputDims(mode, settings.aspectRatio, settings, srcLong);
  if (dims) {
    settings.outputWidth = dims.outputWidth;
    settings.outputHeight = dims.outputHeight;
  } else {
    const k = targetLongEdge(mode, settings, srcLong) / srcLong;
    settings.outputWidth = Math.round(d.width * k);
    settings.outputHeight = Math.round(d.height * k);
  }
  const res = await window.mbrush.generate({ providerId, modelId, mode, prompt, image: img, settings });
  if (!res.ok || !res.data?.images?.[0]) throw new Error(res.error ?? "הפעולה נכשלה");
  const out = res.data.images[0];
  return { src: out.src, width: out.width, height: out.height, cost: res.data.metadata?.costEstimate ?? 0 };
}
