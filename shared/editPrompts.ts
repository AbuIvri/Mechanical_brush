// The two edit prompts every engine sends, written once so the engines cannot drift.
//
// Fill and recreate ask for opposite things, and the wording has to say so plainly:
//  · Fill is a SELECTIVE edit: one change, in one place, and every other pixel as it
//    was. The old fill prompt also demanded "MAXIMUM sharpness … ideally sharper", and
//    an engine that obeys that re-grades the whole crop: measured on real OpenAI fills,
//    saturation rose ~19% and contrast ~6% in areas nobody asked to touch.
//  · Recreate is a WHOLE re-render: the instruction applies to the entire frame, and
//    only the preserve switches the user turned on hold it back.
// Short and plain on purpose: every extra adjective is another pull in some direction.

import { recreateOverride } from "./erasePrompts.js";

type Guards = { preserveColor?: boolean; preserveGeometry?: boolean; preserveIdentity?: boolean };

/** One sentence, ending in a full stop, whatever the user typed. */
function sentence(text: string): string {
  const t = text.trim().replace(/[\s.]+$/, "");
  return t ? `${t}.` : "";
}

export const FILL_KEEP =
  "Change only what this edit needs, and only where it needs it. Everything else stays " +
  "exactly as it is in the input: the same colours, brightness, contrast, saturation and " +
  "white balance, the same sharpness, grain and noise. Do not enhance, re-grade, brighten, " +
  "sharpen or smooth the rest of the image.";

export const FILL_BLEND =
  "Anything new or changed takes its light, colour, perspective, texture and sharpness " +
  "from its surroundings, so it cannot be told apart from the original photograph. Keep " +
  "fine detail: no blur and no painterly softening.";

export const FILL_CONTEXT_NOTE =
  "The last image is a low-resolution view of the complete picture this crop belongs to: " +
  "use it only to understand the wider scene, lighting and scale. Edit and return only " +
  "the first image, the crop.";

/** Generative fill (and the per-area erase, which arrives as the instruction). */
export function fillPrompt(instruction: string | undefined, opts: { contextImage: boolean }): string {
  const edit = sentence(instruction ?? "") || "Subtly retouch the image.";
  return [`Make one selective edit to this image. The edit: ${edit}`, FILL_KEEP, FILL_BLEND, opts.contextImage ? FILL_CONTEXT_NOTE : ""]
    .filter(Boolean)
    .join(" ");
}

/** The preserve switches, as sentences. Empty when none is on. */
export function guardSentences(s: Guards | undefined): string[] {
  const out: string[] = [];
  if (s?.preserveColor) out.push("Keep the original colour palette and tone.");
  if (s?.preserveGeometry) out.push("Keep the composition, geometry and framing.");
  if (s?.preserveIdentity) out.push("Keep the subject's identity and product shape.");
  return out;
}

/**
 * Recreate: the whole frame, re-rendered. A recreate that exists to change one thing
 * (pins, the erase brush) gets its own edit base from `recreateOverride` instead — that
 * check comes first, so no engine can send this text in front of an edit.
 * `subject` names the input where an engine numbers its images ("the first image").
 */
export function recreatePrompt(
  instruction: string | undefined,
  settings: (Guards & { pinEdit?: boolean; eraseObjects?: boolean }) | undefined,
  subject = "this image",
): string {
  const override = recreateOverride(settings);
  if (override) return [sentence(override), sentence(instruction ?? "")].filter(Boolean).join(" ");
  const change = sentence(instruction ?? "");
  return [
    `Recreate ${subject} in full, as one complete new render at higher fidelity and realism.`,
    change
      ? `Apply this to the whole picture, not to one area: ${change}`
      : "Improve texture and detail and repair artifacts across the whole frame, without reinterpreting its style.",
    ...guardSentences(settings),
  ].join(" ");
}
