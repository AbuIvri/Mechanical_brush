// Prompts that turn a recreate into an edit, shared by the renderer and every engine.
//
// Every engine's recreate prompt says, in its own words, "recreate this faithfully and
// preserve the composition". That is right for a recreate and fatal for anything that
// asks for a change: a pin that says "an attack spaceship emerges here" was sent last,
// after an instruction to change nothing, and the engine returned the same picture. So a
// run that exists to change something gets an edit prompt INSTEAD of the recreate base —
// never appended after it.
// Short and plain on purpose — every extra adjective is another pull in some direction.

/** How the result has to sit in the picture. The patch is composited back into the frame,
 *  so a tone that is merely close reads as a visible rectangle over the photo. */
const SEAMLESS =
  "Match the surrounding colour, brightness, contrast, grain and texture exactly, so the " +
  "edit is invisible: no colour shift, no patch, no box edges, no seam";

/** Per area. A copy of the crop with the brushed shape painted over travels as the second
 *  image — the brush stroke is an amorphous shape, and its bounding rectangle is what the
 *  engine is sent, so without the marks it cannot know which part of the box to clear.
 *  Fill providers wrap this as "Edit the image and <this>, without changing anything else". */
export const ERASE_FILL_PROMPT =
  "remove whatever is painted over in red-orange in the second image — the same crop with " +
  "the area marked — completely, and rebuild what was behind it so the background, lines, " +
  "textures and lighting continue naturally. Return the first image edited, with no " +
  "red-orange paint anywhere and nothing new in its place. " + SEAMLESS;

/** Whole image. The second image is the same picture with the areas painted over. */
export const ERASE_WHOLE_PROMPT =
  "Edit the first image. The second image is the same picture with the objects to remove " +
  "painted over in red-orange. Remove those objects completely and rebuild what was behind " +
  "them so the background, lines, textures and lighting continue naturally. Return the " +
  "first image edited, with no red-orange paint, nothing new in their place, and " +
  "everything else exactly as it is. " + SEAMLESS;

/** A recreate whose prompt carries pins. The pin lines follow this. */
export const PIN_EDIT_BASE =
  "Edit this image. Make each change listed below at its pin, and nothing else: keep the " +
  "rest of the picture as it is — composition, framing, people, text and style";

/** The base prompt a recreate should use instead of the engine's own, or null for an
 *  ordinary recreate. One function, so four engines cannot drift apart. */
export function recreateOverride(
  s: { pinEdit?: boolean; eraseObjects?: boolean } | undefined,
): string | null {
  if (s?.eraseObjects) return ERASE_WHOLE_PROMPT;
  if (s?.pinEdit) return PIN_EDIT_BASE;
  return null;
}

/** The umage2 model an erase should use, whatever the picker says.
 *
 *  Sunburst is the 2.5 variant built for edit precision; Flare is the fast default and
 *  gave patches whose tone did not match. Only within umage2 — another engine keeps the
 *  model it was given, since there is nothing to choose between. */
export const ERASE_MODEL_UMAGE2 = "gpt-image-2.5-sunburst";
export function eraseModelFor(
  providerId: string,
  modelId: string,
  models: { id: string }[] | undefined,
): string {
  if (providerId !== "umage2") return modelId;
  return models?.some((m) => m.id === ERASE_MODEL_UMAGE2) ? ERASE_MODEL_UMAGE2 : modelId;
}
