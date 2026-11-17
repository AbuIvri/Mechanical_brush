import { FLEXIBLE_MODELS, FIXED_SIZES, UMAGE2_DEFAULT_MODEL } from "./Umage2Types.js";
import type { GenerationMode, GenerationSettings } from "../../../shared/types.js";
// The model's size constraints are shared with the renderer, which shows the user the
// resulting dimensions before they spend. One source of truth for both.
import { fitFlexibleSize, boxToAspect, MAX_EDGE } from "../../../shared/gptImageSize.js";
import { REMOVEBG_BASE_PROMPT } from "../options.js";
import { recreateOverride } from "../../../shared/erasePrompts.js";
import { recreatePrompt } from "../../../shared/editPrompts.js";

/**
 * Choose an output size string for the provider call.
 * Goal: keep the source aspect ratio so the generated layer aligns cleanly.
 */
export function pickSize(
  modelId: string,
  srcW: number,
  srcH: number,
  settings?: GenerationSettings,
): string {
  const aspect = srcW / srcH;

  if (!FLEXIBLE_MODELS.has(modelId)) {
    // gpt-image-1 family: pick the closest of the 3 fixed aspect ratios.
    const candidates = FIXED_SIZES.map((s) => {
      const [w, h] = s.split("x").map(Number);
      return { s, diff: Math.abs(w / h - aspect) };
    });
    candidates.sort((a, b) => a.diff - b.diff);
    return candidates[0].s;
  }

  // Flexible model (GPT Image 2.5 / 2): target requested size, else fit a 4K box.
  let targetW = settings?.outputWidth;
  let targetH = settings?.outputHeight;

  if (!targetW || !targetH) {
    const box = boxToAspect(aspect, MAX_EDGE);
    targetW = box.w;
    targetH = box.h;
  }

  const { w, h } = fitFlexibleSize(targetW, targetH);
  return `${w}x${h}`;
}

/**
 * Per-image cost estimate (USD) from OpenAI's published pricing table.
 * Columns: [square 1024², portrait 1024×1536, landscape 1536×1024].
 * Pricing is NOT linear in pixels (non-square is often cheaper), so we look up
 * the right cell, then scale only when the output exceeds the documented size.
 */
const PRICE: Record<string, Record<string, [number, number, number]>> = {
  // GPT Image 2.5 — APPROXIMATE. OpenAI publishes token rates for these models ($5/$8/$30
  // per 1M, identical to GPT Image 2) but no per-image table, and states outright that the
  // GPT Image 2 calculator does not estimate 2.5 token consumption. Same rates with an
  // unknown token count per image means the real figure can differ; the rows below start
  // from GPT Image 2 and extend the ladder by its own step (~4x per level) for the two new
  // quality tiers. Treat the running spend total as an estimate on these models, and
  // replace this block the moment real numbers are published.
  "gpt-image-2.5-flare": {
    low: [0.006, 0.005, 0.005],
    medium: [0.053, 0.041, 0.041],
    high: [0.211, 0.165, 0.165],
    xhigh: [0.422, 0.33, 0.33],
    max: [0.844, 0.66, 0.66],
  },
  "gpt-image-2.5-sunburst": {
    low: [0.006, 0.005, 0.005],
    medium: [0.053, 0.041, 0.041],
    high: [0.211, 0.165, 0.165],
    xhigh: [0.422, 0.33, 0.33],
    max: [0.844, 0.66, 0.66],
  },
  "gpt-image-2": {
    low: [0.006, 0.005, 0.005],
    medium: [0.053, 0.041, 0.041],
    high: [0.211, 0.165, 0.165],
  },
  "gpt-image-1.5": {
    low: [0.009, 0.013, 0.013],
    medium: [0.034, 0.05, 0.05],
    high: [0.133, 0.2, 0.2],
  },
  "gpt-image-1": {
    low: [0.011, 0.016, 0.016],
    medium: [0.042, 0.063, 0.063],
    high: [0.167, 0.25, 0.25],
  },
  "gpt-image-1-mini": {
    low: [0.005, 0.006, 0.006],
    medium: [0.011, 0.015, 0.015],
    high: [0.036, 0.052, 0.052],
  },
};

export function estimateCost(
  model: string,
  w: number,
  h: number,
  quality: string | undefined,
): number {
  const q = !quality || quality === "auto" ? "high" : quality;
  const tier = PRICE[model] ?? PRICE[UMAGE2_DEFAULT_MODEL];
  const row = tier[q] ?? tier.high;

  const aspect = w / h;
  // 0 = square, 1 = portrait, 2 = landscape
  const idx = Math.abs(aspect - 1) < 0.15 ? 0 : h > w ? 1 : 2;
  const base = row[idx];

  // Reference megapixels for the documented sizes.
  const refMp = idx === 0 ? (1024 * 1024) / 1e6 : (1024 * 1536) / 1e6;
  const outMp = (w * h) / 1e6;
  const scale = outMp > refMp * 1.2 ? outMp / refMp : 1; // only scale beyond documented size

  return Math.round(base * scale * 10000) / 10000;
}

/**
 * USD per 1M tokens: [text in, cached text in, image in, cached image in, image out].
 * OpenAI bills GPT Image by tokens, and returns the exact counts with every image
 * response (`usage`). Pricing from those counts is the real charge; the size table above
 * is only a guess at the output side and never counted the input images at all (a fill
 * sends the crop AND a picture of the whole scene, and image input is billed too).
 * Source: OpenAI's model pages (2.5 Flare and Sunburst share one rate card, 2026-11).
 */
const TOKEN_RATES: Record<string, [number, number, number, number, number]> = {
  "gpt-image-2.5-flare": [5, 1.25, 8, 2, 30],
  "gpt-image-2.5-sunburst": [5, 1.25, 8, 2, 30],
  "gpt-image-2": [5, 1.25, 8, 2, 30],
  "gpt-image-1.5": [5, 1.25, 8, 2, 32],
  "gpt-image-1": [5, 1.25, 10, 2.5, 40],
  "gpt-image-1-mini": [2, 0.2, 2.5, 0.25, 8],
};

export interface ImageUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number; cached_tokens?: number } | null;
}

/** The charge for one call from the token counts OpenAI reported, or null when the
 *  response carried none (then the caller falls back to `estimateCost`). */
export function costFromUsage(model: string, usage: ImageUsage | null | undefined): number | null {
  const r = TOKEN_RATES[model];
  if (!r || !usage || !(Number(usage.output_tokens) > 0)) return null;
  const d = usage.input_tokens_details ?? {};
  const input = Number(usage.input_tokens) || 0;
  let text = Number(d.text_tokens) || 0;
  let image = Number(d.image_tokens) || 0;
  if (!text && !image) image = input; // no breakdown: all of it at the image rate (the dearer)
  // Cached tokens are billed at the cached rate. OpenAI does not say which kind they
  // were; take them from the images first, which is where a repeated input repeats.
  let cached = Math.min(Number(d.cached_tokens) || 0, text + image);
  const cachedImage = Math.min(cached, image);
  image -= cachedImage;
  cached -= cachedImage;
  text -= cached;
  const usd =
    (text * r[0] + cached * r[1] + image * r[2] + cachedImage * r[3] + Number(usage.output_tokens) * r[4]) / 1e6;
  return Math.round(usd * 1e4) / 1e4;
}

/** Build a guidance prompt for upscale/recreate from the user's settings. */
export function buildModePrompt(
  mode: GenerationMode,
  userPrompt: string | undefined,
  settings?: GenerationSettings,
): string {
  const guards: string[] = [];
  if (settings?.preserveColor) guards.push("preserve the original color palette and tone");
  if (settings?.preserveGeometry) guards.push("preserve composition, geometry and framing exactly");
  if (settings?.preserveIdentity) guards.push("preserve subject identity and product shape");

  let base = "";
  if (mode === "upscale") {
    base =
      "Ultra high resolution remaster of this image. Enhance sharpness, fine " +
      "details, textures and colors. Reconstruct realistic detail while keeping " +
      "the original composition and visual identity unchanged.";
  } else if (mode === "recreate" && recreateOverride(settings)) {
    // Pins or the erase brush: a recreate in transport only. The recreate base below
    // ("avoid stylistic reinterpretation") told the model to change nothing, and it
    // obeyed that over the instruction that followed.
    base = recreateOverride(settings)!;
  } else if (mode === "recreate") {
    // The whole frame, re-rendered; shared with every engine (it carries the guards).
    return recreatePrompt(userPrompt, settings);
  } else if (mode === "removebg") {
    base = REMOVEBG_BASE_PROMPT;
  }

  // On an edit the guards cannot mean "preserve the geometry exactly" everywhere — the
  // pinned change IS a change. They hold for the rest of the picture.
  const guardText = guards.length
    ? (mode === "recreate" && recreateOverride(settings) ? `Everywhere else, ${guards.join("; ")}` : guards.join("; "))
    : "";
  return [base, guardText, userPrompt?.trim()].filter(Boolean).join(". ");
}
