import type { ProviderOption, ProviderOptionChoice, GenerationMode } from "../../shared/types.js";

const RATIOS: ProviderOptionChoice[] = [
  { value: "1:1", label: "1:1" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "3:2", label: "3:2" },
  { value: "2:3", label: "2:3" },
  { value: "21:9", label: "21:9" },
];

function aspect(modes: GenerationMode[], autoLabel: string, full = true): ProviderOption {
  const ratios = full ? RATIOS : RATIOS.filter((c) => c.value !== "21:9");
  return {
    key: "aspectRatio",
    label: "יחס צלעות",
    type: "select",
    default: "auto",
    modes,
    choices: [{ value: "auto", label: autoLabel }, ...ratios],
  };
}

// Editing keeps the source framing by default ("like source").
export const ASPECT_EDIT = aspect(["upscale", "recreate"], "כמו המקור", true);
export const ASPECT_EDIT_REVE = aspect(["upscale", "recreate"], "כמו המקור", false);
// Pure generation has no source, so "auto" means the model decides.
export const ASPECT_GEN = aspect(["generate"], "אוטומטי", true);
export const ASPECT_GEN_REVE = aspect(["generate"], "אוטומטי", false);

// Fill follows the marked area by default (0): the crop is generated at its own size in
// image pixels, so the patch lands 1:1 on what it covers. A fixed size stays available for
// whoever wants one — a softer, cheaper pass, or more detail than the area holds.
export const FILL_RES: ProviderOption = {
  key: "fillLongEdge",
  label: "רזולוציית אזור",
  type: "select",
  default: 0,
  modes: ["fill"],
  note: "מותאם לאזור: הג'נרוט נעשה בגודל האמיתי של השטח המסומן (בפיקסלים של השכבה שמתחתיו). גודל קבוע גובר עליו.",
  choices: [
    { value: 0, label: "מותאם לאזור" },
    { value: 1024, label: "1K" },
    { value: 1536, label: "1.5K" },
    { value: 2048, label: "2K" },
    { value: 3072, label: "3K" },
  ],
};

// gpt-image generate: long-edge of the requested output (the aspect option shapes
// it). The model's pixel budget is 8.29MP — exactly 3840×2160 (4K) at 16:9; wider
// aspects hit the budget sooner (a 1:1 "4K" tops out at 2880×2880), and pickSize
// clamps to it automatically per aspect.
export const GEN_RES: ProviderOption = {
  key: "genLongEdge",
  label: "רזולוציה",
  type: "select",
  default: 2048,
  modes: ["generate"],
  note: "4K = צלע ארוכה 3840 (למשל 3840×2160 ב-16:9). ביחס 1:1 המודל מוגבל ל-2880×2880.",
  choices: [
    { value: 1024, label: "1K" },
    { value: 1536, label: "1.5K" },
    { value: 2048, label: "2K" },
    { value: 3840, label: "4K" },
  ],
};

// Recreate used to be pinned to a hard-coded 2048 (or to the canvas size), so a small
// project could never be recreated any larger. 0 keeps the source's own long edge — the
// old behaviour, now a choice rather than a ceiling. All values are numbers on purpose:
// PromptBar decides string-vs-number from the FIRST choice, so one string would turn
// every value into a string.
export const RECREATE_RES: ProviderOption = {
  key: "recreateLongEdge",
  label: "רזולוציה",
  type: "select",
  default: 0,
  modes: ["recreate"],
  note: "4K = צלע ארוכה 3840. ביחס 1:1 המודל מוגבל ל-2880×2880 (תקציב הפיקסלים).",
  choices: [
    { value: 0, label: "כמו המקור" },
    { value: 1024, label: "1K" },
    { value: 1536, label: "1.5K" },
    { value: 2048, label: "2K" },
    { value: 3840, label: "4K" },
  ],
};

// Upscale always ran at the 4K ceiling with no say in it. The default keeps that;
// the lower tiers are there for when 4K isn't worth the cost.
export const UPSCALE_RES: ProviderOption = {
  key: "upscaleLongEdge",
  label: "רזולוציה",
  type: "select",
  default: 3840,
  modes: ["upscale"],
  note: "הצלע הארוכה של התוצאה. 4K הוא המקסימום של המנוע.",
  choices: [
    { value: 1536, label: "1.5K" },
    { value: 2048, label: "2K" },
    { value: 3840, label: "4K (מקסימום)" },
  ],
};

// Background removal. A generative engine cannot literally cut the subject out — it
// redraws it — so the prompt spends every word it has on holding the subject still and
// leaves nothing behind it. The API's background="transparent" does the alpha; this
// stops the model from helpfully inventing a studio floor to stand the subject on.
export const REMOVEBG_BASE_PROMPT =
  "Keep the subject EXACTLY as it is — identical shape, pose, proportions, colours, " +
  "textures, materials, text, logos and fine edge detail. Do not redraw, restyle, " +
  "re-light, re-frame, crop, rotate or beautify it in any way. Change ONLY what is " +
  "behind it: remove the background completely. No backdrop, no floor, no horizon, no " +
  "cast shadow, no contact shadow, no reflection, no gradient, no vignette — nothing " +
  "but the isolated subject on empty transparency. Cut cleanly along the subject's true " +
  "silhouette, keeping hair, fur, glass and thin details intact at the edge.";

export const REMOVEBG_RES: ProviderOption = {
  key: "removebgLongEdge",
  label: "רזולוציה",
  type: "select",
  default: 2048,
  modes: ["removebg"],
  note: "ברירת המחדל 2K. 'כמו המקור' שומר על גודל התמונה הנוכחית.",
  choices: [
    { value: 0, label: "כמו המקור" },
    { value: 1024, label: "1K" },
    { value: 1536, label: "1.5K" },
    { value: 2048, label: "2K" },
    { value: 3840, label: "4K" },
  ],
};

// Reformat: the app decides the final pixel size itself (the engine's return is
// cover-cropped to it), so this one control works the same on every engine.
export const RATIO_RES: ProviderOption = {
  key: "ratioLongEdge",
  label: "רזולוציה",
  type: "select",
  default: 4096,
  modes: ["ratio"],
  note: "תקרה לצלע הארוכה של הפורמט החדש — הפריים גדל ליחס היעד ואז מוגבל לערך הזה.",
  choices: [
    { value: 1024, label: "1K" },
    { value: 2048, label: "2K" },
    { value: 4096, label: "4K" },
  ],
};

// Grok Imagine resolution tiers (the API accepts exactly "1k" | "2k"), applies to
// generation and to all /images/edits-based modes.
export const GROK_RES: ProviderOption = {
  key: "grokResolution",
  label: "רזולוציה",
  type: "select",
  default: "2k",
  modes: ["generate", "recreate", "fill", "ratio"],
  choices: [
    { value: "1k", label: "1K" },
    { value: "2k", label: "2K" },
  ],
};

// Reve always works on a ~1MP base internally; higher resolution comes from
// integer upscale postprocessing (×2 or ×4 only — ×3 is unsupported by Reve).
export const REVE_RES: ProviderOption = {
  key: "reveUpscale",
  label: "רזולוציה",
  type: "select",
  default: 1,
  modes: ["upscale", "recreate", "generate"],
  note: "Reve עובד על ~1MP פנימית; 2K/4K = הגדלה ×2/×4 (לא אפסקייל משמר-פרטים). לאפסקייל אמיתי השתמש ב-umage2.",
  choices: [
    { value: 1, label: "1K (בסיס)" },
    { value: 2, label: "2K (×2)" },
    { value: 4, label: "4K (×4)" },
  ],
};

// Engine-agnostic: how to reconcile a result whose aspect differs from the source.
// Many engines snap output to their own aspect buckets; "התאם למקור" crops it back.
export const ASPECT_CONFORM: ProviderOption = {
  key: "aspectConform",
  label: "יחס תוצאה",
  type: "select",
  default: "source",
  modes: ["upscale", "recreate", "fill"],
  note: "התאם למקור = חיתוך עדין ליחס הצלעות המקורי (בלי מתיחה). כפי שהמנוע מחזיר = ללא שינוי.",
  choices: [
    { value: "source", label: "התאם למקור" },
    { value: "model", label: "כפי שהמנוע מחזיר" },
  ],
};

// Engine-agnostic: auto-register the result onto the source layer (fill/upscale)
// so the generated pixels sit exactly on the layer beneath — fixes engine drift.
export const ALIGN_TO_SOURCE: ProviderOption = {
  key: "alignToSource",
  label: "יישר לשכבת המקור",
  type: "toggle",
  default: true,
  modes: ["upscale", "fill"],
  note: "מצמיד את התוצאה בול על שכבת המקור (תיקון הסחות/הזזה מהמנוע). כבה אם התוצאה שונה מאוד מהמקור.",
};

export const PRESERVE: ProviderOption[] = [
  { key: "preserveColor", label: "שמור צבעים", type: "toggle", modes: ["upscale", "recreate"] },
  { key: "preserveGeometry", label: "שמור גאומטריה", type: "toggle", modes: ["upscale", "recreate"] },
  { key: "preserveIdentity", label: "שמור זהות", type: "toggle", modes: ["upscale", "recreate"] },
];

// ---- Magnific upscaler options ----
export const MAGNIFIC_SCALE: ProviderOption = {
  key: "magnificScale",
  label: "פקטור הגדלה",
  type: "select",
  default: "2x",
  modes: ["upscale"],
  choices: [
    { value: "2x", label: "×2" },
    { value: "4x", label: "×4" },
  ],
};
export const MAGNIFIC_OPTIMIZED: ProviderOption = {
  key: "magnificOptimized",
  label: "מותאם ל-",
  type: "select",
  default: "standard",
  modes: ["upscale"],
  choices: [
    { value: "standard", label: "סטנדרטי" },
    { value: "soft_portraits", label: "פורטרט רך" },
    { value: "hard_portraits", label: "פורטרט חד" },
    { value: "art_n_illustration", label: "אמנות ואיור" },
    { value: "nature_n_landscapes", label: "טבע ונוף" },
    { value: "films_n_photography", label: "צילום וקולנוע" },
    { value: "3d_renders", label: "רינדור תלת-ממד" },
    { value: "videogame_assets", label: "משחקי וידאו" },
  ],
};
export const MAGNIFIC_ENGINE: ProviderOption = {
  key: "magnificEngine",
  label: "מנוע",
  type: "select",
  default: "automatic",
  modes: ["upscale"],
  note: "Magnific: Illusio = רך/אמנותי, Sharpy = חד/ריאליסטי, Sparkle = מאוזן.",
  choices: [
    { value: "automatic", label: "אוטומטי" },
    { value: "magnific_illusio", label: "Illusio" },
    { value: "magnific_sharpy", label: "Sharpy" },
    { value: "magnific_sparkle", label: "Sparkle" },
  ],
};
export const MAGNIFIC_CREATIVITY: ProviderOption = {
  key: "magnificCreativity",
  label: "יצירתיות",
  type: "select",
  default: 0,
  modes: ["upscale"],
  note: "כמה פרטים חדשים ה-AI ממציא. גבוה = יותר אגרסיבי (עלול לשנות תוכן).",
  choices: [
    { value: -5, label: "שמרני" },
    { value: 0, label: "מאוזן" },
    { value: 5, label: "יצירתי" },
    { value: 10, label: "מקסימלי" },
  ],
};

// Default instruction for Generative Expand when the user leaves the prompt empty:
// always complete the margins outward on every side with invisible joins, while
// preserving the original medium/style and the compositional hierarchy.
export const EXPAND_DEFAULT_INSTRUCTION =
  "complete the missing margins by continuing the scene OUTWARD on all sides with completely " +
  "invisible, seamless joins; preserve the original photographic medium and stylistic treatment " +
  "(grain, tonality, color grade, optics), and respect the compositional hierarchy and visual weight " +
  "of the original — extend only the environment and background that naturally belong there";

// The FIXED base prompt for Generative Expand, sent verbatim to every model. The
// target image is a cropped piece (visible detail + white margins to fill); the
// reference image is the full scene for context. The user's own text is appended.
export const EXPAND_BASE_PROMPT =
  "Edit the target image by filling all white empty margins with a natural, seamless continuation of " +
  "the visible detailed area. The completed regions must logically extend the original scene, matching " +
  "the subject, perspective, lighting, colors, textures, fabric details, background, scale, and camera " +
  "angle. Use the reference image only to understand the full context, composition, and missing visual " +
  "information, since the target image is a cropped section of that reference. Do not change the existing " +
  "visible content. Do not add unrelated objects, text, artifacts, borders, or stylized elements. The " +
  "result should look like one continuous, realistic image with no visible seams or signs of editing.";

// The FIXED base prompt for שינוי פורמט (reformat / aspect change). The model gets the
// original centered on an extended canvas and regenerates a naturally wider/taller
// version — it MAY reposition the subject slightly for harmony. The user's own text
// is appended when present.
export const RATIO_BASE_PROMPT =
  "Extend the image canvas by adding new margins in the requested direction, preserving the original " +
  "image exactly as the visual anchor. " +
  "Fill the newly added empty areas with a seamless, natural continuation of the existing background, " +
  "lighting, texture, perspective, atmosphere, and color palette. The extension should feel like it was " +
  "always part of the original photograph/image. " +
  "Do not change the hierarchy, story, focal point, or composition of the original image. Do not alter " +
  "the subject, pose, expression, scale, proportions, cropping, lighting on the main subject, or any " +
  "existing elements. " +
  "The added margins should only complete the composition harmoniously, expanding the surrounding " +
  "negative space or environment in a subtle and believable way. Maintain the original style, depth of " +
  "field, grain, sharpness, lens characteristics, and overall mood. " +
  "The final image should look like a naturally wider/taller version of the original, not like an edited " +
  "or artificially extended image.";

// ---- Crystal Upscaler (Clarity AI, via Replicate) options ----
export const CRYSTAL_SCALE: ProviderOption = {
  key: "crystalScale",
  label: "פקטור הגדלה",
  type: "select",
  default: 2,
  modes: ["upscale"],
  choices: [
    { value: 2, label: "×2" },
    { value: 4, label: "×4" },
    { value: 6, label: "×6" },
  ],
};
export const CRYSTAL_CREATIVITY: ProviderOption = {
  key: "crystalCreativity",
  label: "יצירתיות",
  type: "select",
  default: 0,
  modes: ["upscale"],
  note: "0–10: כמה פרטים ה-AI ממציא. נמוך = נאמן למקור (מומלץ לפנים), גבוה = יותר פרטים.",
  choices: [
    { value: 0, label: "0 — נאמן למקור" },
    { value: 3, label: "3 — מעט" },
    { value: 6, label: "6 — בינוני" },
    { value: 10, label: "10 — מקסימלי" },
  ],
};

/** Ask for a real alpha channel. Only offered by engines that can actually deliver one:
 *  a switch that silently does nothing is worse than no switch. */
export const TRANSPARENT_BG: ProviderOption = {
  key: "transparentBackground",
  label: "רקע שקוף",
  type: "toggle",
  default: false,
  modes: ["generate", "recreate"],
  note:
    "מחזיר PNG עם ערוץ אלפה אמיתי, לא רקע לבן לחיתוך. שים לב: זו לא הסרת רקע בדיעבד — " +
    "הבקשה משפיעה על היצירה עצמה, ולכן התאורה, הצללים והסילואט עשויים לצאת שונים מאותו " +
    "פרומפט על רקע אטום. ה-API בגרסת preview.",
};
