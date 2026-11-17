// Pure helpers for composing the prompt from a medium (prepended) and a style
// (appended as "in the style of <text>"). Kept side-effect-free so they're unit
// testable and reusable by the store. The medium/style words live INSIDE the
// editable prompt text; these helpers strip the old tokens and reinsert new ones so
// changing a selection swaps rather than stacks.

export const STYLE_CONNECTOR = "in the style of";

/** Remove a leading "<medium>, " / "<medium> " / "<medium>" from the prompt. */
export function stripMedium(prompt: string, medium: string): string {
  const m = medium.trim();
  if (!m) return prompt;
  if (prompt.startsWith(m + ", ")) return prompt.slice(m.length + 2);
  if (prompt.startsWith(m + " ")) return prompt.slice(m.length + 1);
  if (prompt === m) return "";
  return prompt;
}

/** Remove a trailing " in the style of <text>" (or without the leading space). */
export function stripStyle(prompt: string, styleText: string): string {
  const t = styleText.trim();
  if (!t) return prompt;
  const suffix = `${STYLE_CONNECTOR} ${t}`;
  if (prompt.endsWith(" " + suffix)) return prompt.slice(0, prompt.length - suffix.length - 1);
  if (prompt.endsWith(suffix)) return prompt.slice(0, prompt.length - suffix.length);
  return prompt;
}

/** Extract the user's "core" text by stripping the current medium + style tokens. */
export function extractCore(prompt: string, medium: string, styleText: string): string {
  return stripStyle(stripMedium(prompt, medium), styleText);
}

/** Compose "<medium>, <core> in the style of <styleText>", skipping empty parts. */
export function composePrompt(medium: string, core: string, styleText: string): string {
  const parts = [medium.trim(), core.trim()].filter(Boolean);
  let p = parts.join(", ");
  const t = styleText.trim();
  if (t) p = (p ? p + " " : "") + `${STYLE_CONNECTOR} ${t}`;
  return p;
}
