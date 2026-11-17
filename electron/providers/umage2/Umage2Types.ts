import type { ModelInfo } from "../../../shared/types.js";
// Configuration & constants specific to the umage2 (GPT image) adapter.

/** OpenAI's own guidance is to start with Flare: same token rates as GPT Image 2, better
 *  images, and about half the latency. Sunburst is the one to reach for when an edit has
 *  to hold precisely — it is slower and aimed at "premium visual workflows". */
export const UMAGE2_DEFAULT_MODEL = "gpt-image-2.5-flare";

// Models we know how to drive. The 2.5 family and gpt-image-2 support flexible sizes
// (any aspect ratio) and are required for region-accurate generative fill; the
// gpt-image-1 family is restricted to three fixed sizes.
/** Models that accept background="transparent" and return an RGBA PNG. The older
 *  gpt-image-1 family rejects it, so the switch is not offered for them at all. */
export const TRANSPARENT_MODELS = new Set([
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2",
]);

/** The 2.5 family adds two quality steps above `high`. Sending `xhigh` to gpt-image-2 is
 *  a 400, so the choice is offered per model and clamped again before the call. */
export const XQUALITY_MODELS = new Set(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);

export const UMAGE2_MODELS: ModelInfo[] = [
  { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare (מהיר — ברירת מחדל)" },
  { id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst (עריכה מדויקת, איטי יותר)" },
  { id: "gpt-image-2", label: "GPT Image 2 (כל יחס צלעות / 4K)" },
  { id: "gpt-image-1", label: "GPT Image 1" },
  { id: "gpt-image-1-mini", label: "GPT Image 1 mini" },
].map((m) => ({ ...m, supportsTransparency: TRANSPARENT_MODELS.has(m.id) }));

export const FLEXIBLE_MODELS = new Set([
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2",
  "gpt-image-1.5",
]);

/** Appended when transparency is on. background="transparent" steers the generation
 *  itself, so a prompt that asks for a studio floor is fighting the request. */
export const TRANSPARENT_PROMPT =
  " Isolated subject on a fully transparent background: no backdrop, no floor, no " +
  "ground plane, no cast shadow onto a surface, no environment. Clean, accurate edges, " +
  "including fine detail such as hair, fur and semi-transparent materials.";

// Fixed sizes for the gpt-image-1 family.
export const FIXED_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;

export type Quality = "low" | "medium" | "high" | "xhigh" | "max" | "auto";

/** Quality the given model will actually accept. A value the UI offered before the user
 *  switched models must not reach the API — it comes back as a 400, not as a downgrade. */
export function clampQuality(model: string, quality: string | undefined): Quality {
  const q = (quality ?? "high") as Quality;
  if ((q === "xhigh" || q === "max") && !XQUALITY_MODELS.has(model)) return "high";
  return q;
}
