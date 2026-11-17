// What a reference image is FOR, said to the engine in words.
//
// The role chosen on a reference used to travel to the main process and stop there: no
// provider read it. The engine got two images and "Recreate this image", with nothing to
// say what the second one was — so a slide sent along as a typography sample came back as
// the output, copied whole. A reference has to be declared as a reference, with what may
// be taken from it and what may not.
//
// Pure: no DOM, no store. The UI reads the labels from here and the store builds the text.

import type { ReferenceRole } from "./types.js";

export interface RoleSpec {
  id: ReferenceRole;
  /** The menu label. */
  label: string;
  /** One line under the chip: what the choice does, in the user's language. */
  hint: string;
  /** Goes into "Image N — <kind> reference". */
  kind: string;
  /** What the engine may take. */
  take: string;
  /** What it must not reproduce. Empty for the neutral role. */
  leave: string;
}

/** The roles the menu offers, in order. `general` first: it is the default. */
export const REF_ROLES: RoleSpec[] = [
  {
    id: "general",
    label: "לפי הפרומפט",
    hint: "משמשת כפי שכתוב בפרומפט · לא תוחזר כתמונה עצמה",
    kind: "general",
    take: "use it as the prompt describes",
    leave: "",
  },
  {
    id: "style",
    label: "סגנון",
    hint: "נלקח: צבעים, מראה ואווירה · לא מועתק: התוכן, הטקסט והפריסה",
    kind: "style",
    take: "take only its visual style — colour palette, rendering, mood and finish",
    leave: "its subject, its content, its text or its layout",
  },
  {
    id: "typography",
    label: "טיפוגרפיה",
    hint: "נלקח: סגנון האותיות · לא מועתק: המילים והפריסה",
    kind: "typography",
    take: "take only its lettering style — typeface, weight, proportions, colour and text treatment",
    leave: "its words, its layout or anything else in it",
  },
  {
    id: "identity",
    label: "דמות",
    hint: "נלקח: אותה דמות, פנים ותווים · לא מועתק: התנוחה, הבגדים והרקע",
    kind: "identity",
    take: "this is the same person or character — keep the face and features",
    leave: "the pose, the clothes or the background",
  },
  {
    id: "object",
    label: "אובייקט / לוגו",
    hint: "נלקח: האובייקט או הלוגו עצמו, בנאמנות · לא מועתק: הרקע שסביבו",
    kind: "object",
    take: "use this object or logo itself, reproduced faithfully",
    leave: "its background or surroundings",
  },
  {
    id: "composition",
    label: "קומפוזיציה",
    hint: "נלקח: פריסה, מסגור ותנוחה · לא מועתק: התוכן, הצבעים והסגנון",
    kind: "composition",
    take: "take only its layout, framing and pose",
    leave: "its content, its colours or its style",
  },
];

/** Roles from before the menu was cut down. Still valid in saved projects: each is an
 *  aspect of style, so it becomes `style` narrowed to that aspect. */
const LEGACY: Partial<Record<ReferenceRole, string>> = {
  texture: "its surface texture only",
  lighting: "its lighting only",
  color: "its colour palette only",
  material: "its materials only",
};

export const DEFAULT_REF_ROLE: ReferenceRole = "general";

/** The role the menu should show for a stored value. */
export function normalizeRole(role: ReferenceRole | undefined): ReferenceRole {
  if (!role) return DEFAULT_REF_ROLE;
  return LEGACY[role] ? "style" : role;
}

export function roleSpec(role: ReferenceRole | undefined): RoleSpec {
  return REF_ROLES.find((r) => r.id === normalizeRole(role)) ?? REF_ROLES[0];
}

/** A user's note, made safe to sit inside a quoted sentence in the prompt. */
function cleanNote(note: string | undefined): string {
  return (note ?? "").replace(/\s+/g, " ").replace(/["“”]/g, "'").trim().slice(0, 240);
}

export interface GuideRef {
  role: ReferenceRole;
  note?: string;
}

/** How many of the user's references an engine can take on this run. `reserved` is the
 *  number of slots the app itself needs (the source image, fill's context view, the erase
 *  marks), so a reference is never the thing that pushes those out. */
export function referencesThatFit<T>(refs: T[], maxImages: number | undefined, reserved: number): T[] {
  if (!maxImages || maxImages <= 0) return refs;
  return refs.slice(0, Math.max(0, maxImages - reserved));
}

/** The paragraph that tells the engine what each reference is for.
 *
 *  `hasSource`: the request carries the picture being worked on as image 1, and the
 *  references follow it — true for every mode except text-to-image, where the references
 *  are all there is. Numbering follows the order every engine already sends them in. */
export function referenceGuide(refs: GuideRef[], opts: { hasSource: boolean }): string {
  if (!refs.length) return "";
  const first = opts.hasSource ? 2 : 1;
  const head = opts.hasSource
    ? "Image 1 is the picture to work on: the result must show image 1's own content and " +
      "layout. The other images are references — never the picture to produce."
    : refs.length === 1
      ? "Image 1 is a reference, not the picture to produce."
      : `Images 1–${refs.length} are references, not the picture to produce.`;

  const lines = refs.map((r, i) => {
    const spec = roleSpec(r.role);
    const legacy = LEGACY[r.role];
    const take = legacy ? `take ${legacy}` : spec.take;
    const leave = spec.leave ? ` Do not copy ${spec.leave}.` : "";
    const note = cleanNote(r.note);
    return `Image ${first + i} — ${spec.kind} reference: ${take}.${leave}${note ? ` User note: "${note}".` : ""}`;
  });
  return [head, ...lines].join("\n");
}
