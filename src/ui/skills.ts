// Prompt Skills — guided, multi-step workflows the assistant runs to produce one
// finished image-generation prompt. A skill is a list of steps; `ai` steps call the
// chat model (optionally with the attached images), and `{{stepId}}` interpolates an
// earlier step's answer into a later instruction. Built-ins live here; user skills
// persist in the store (mbrush.savedSkills).

import type { GenerationMode, GenerationSettings } from "../../shared/types";
import { type ChatProvider, isChatProvider } from "./chatModels";

export type StepKind = "text" | "choice" | "images" | "mode" | "ai";

export const STEP_KINDS: StepKind[] = ["text", "choice", "images", "mode", "ai"];

export interface SkillStep {
  id: string;
  kind: StepKind;
  /** What the step asks the user (or what the AI stage is doing). */
  title: string;
  hint?: string;
  /** choice: the options to pick from. */
  options?: string[];
  /** ai: the sub-prompt; may reference {{stepId}} of earlier steps. */
  instruction?: string;
  /** ai: show the output for review/editing before continuing. */
  editable?: boolean;
  /** ai: this output IS the finished prompt (ends the workflow). */
  final?: boolean;
  /** images: default state of the "use as reference in the final prompt" toggle. */
  refDefault?: boolean;
  /** The step may be passed over with nothing supplied (an optional reference). */
  optional?: boolean;
  /** ai: which images-steps' attachments this stage sees. Undefined = everything
   *  attached (how a single-images-step workflow has always behaved); an empty array =
   *  nothing, for a stage that works purely from earlier text. Naming the steps is what
   *  lets one workflow hold two separate sets of images. */
  usesImages?: string[];
  /** ai: pin this stage to a specific model. Empty = the tab's current model, which
   *  is what keeps a shared workflow runnable on whatever the user has a key for. */
  provider?: ChatProvider;
  model?: string;
}

export interface PromptSkill {
  id: string;
  name: string;
  description: string;
  steps: SkillStep[];
  /** Generation settings the skill dictates (e.g. a character sheet is a wide
   *  landscape frame). Applied to the generation box together with the prompt. */
  applySettings?: Partial<GenerationSettings>;
}

export type SavedSkill = PromptSkill & { lastUsed: number };

/** Every workflow ends by choosing the generation mode — appended automatically to
 *  any skill that doesn't declare its own `mode` step. */
export const MODE_STEP: SkillStep = {
  id: "mode",
  kind: "mode",
  title: "באיזה מצב יצירה להריץ את הפרומפט?",
  hint: "הבחירה תוצע לך בסוף, יחד עם הפרומפט",
};

/** The steps actually executed for a skill (guarantees the mode step). */
export function skillSteps(skill: PromptSkill): SkillStep[] {
  const steps = skill.steps;
  if (steps.some((s) => s.kind === "mode")) return steps;
  // Put the mode question just before the final AI stage, so the model knows the
  // mode it is writing for.
  const lastFinal = steps.findIndex((s) => s.kind === "ai" && s.final);
  if (lastFinal < 0) return [...steps, MODE_STEP];
  return [...steps.slice(0, lastFinal), MODE_STEP, ...steps.slice(lastFinal)];
}

/** Replace {{stepId}} with that step's answer. */
export function interpolate(tpl: string, answers: Record<string, string>): string {
  return tpl.replace(/\{\{(\w[\w-]*)\}\}/g, (_m, id) => answers[id] ?? "");
}

// ---------------------------------------------------------------------------
// דף דמות — a five-panel character sheet: three fixed turnaround views, one action
// pose, and a face close-up. Two AI stages produce it, each shown for correction
// before it is used — the identity paragraph (the identity lock, reusable across
// sheets) and the wardrobe-and-pose paragraph. The turnaround stays rigid because
// that rigidity is what makes the sheet usable as a reference; the action panel is
// where the character is allowed to move.
// ---------------------------------------------------------------------------
const CHARACTER_SHEET: PromptSkill = {
  id: "builtin-character-sheet",
  name: "דף דמות (Character Sheet)",
  description: "חמישה פאנלים של אותה דמות — שלוש זוויות סטטיות, פוזת אקשן וקלוז-אפ. מתמונות של האדם, ואפשר גם רפרנס לבוש.",
  // Five panels side by side need a wide landscape frame. If they come out cramped,
  // 21:9 gives each figure more room.
  applySettings: { aspectRatio: "16:9" },
  steps: [
    {
      id: "photo",
      kind: "images",
      title: "צרף תמונות של האדם",
      hint: "משכבה, מהאזור המסומן, מתמונות הייחוס — או העלה קובץ. רק האדם עצמו; הלבוש בשלב נפרד.",
      refDefault: true,
    },
    {
      id: "identity",
      kind: "ai",
      editable: true,
      title: "ניתוח זהות — פסקת הזהות של הדמות",
      hint: "עברו על הפסקה ותקנו לפני שממשיכים — זו נעילת הזהות שתחזור בכל דף נוסף",
      usesImages: ["photo"],
      instruction:
        "Attached is a reference photograph of one person. Write a forensic identity description of that person, " +
        "to be pasted into an image-generation prompt that will rebuild them from several angles. Describe only what is " +
        "physically true of the human being — face, head, hair, body, skin. Do NOT describe the clothing they happen " +
        "to be wearing, the background, the lighting, the camera angle, or anything about the photograph itself.\n\n" +
        "Write it as flowing prose in one paragraph, not a list and not with headings. Be specific and physical rather " +
        "than flattering — measurements, shapes, ratios and materials, not adjectives like \"striking\". Cover, in this " +
        "order: (1) apparent age and gender presentation, then build — estimated height in cm, frame, shoulder width " +
        "relative to hips, weight distribution, posture; (2) head and face — face shape and jaw line, cheekbone height, " +
        "chin, forehead and hairline, brow ridge, ear size and set; (3) features — eye shape, spacing, colour, lid type, " +
        "under-eye character; eyebrow thickness and shape; nose bridge, width, tip and nostrils; lip fullness, mouth " +
        "width, philtrum; (4) hair — length, exact colour including greying, texture, density, parting, recession, " +
        "finish, and facial hair or explicitly its absence; (5) skin — tone and undertone, texture, pores, lines, sun " +
        "damage, redness, and one or two genuine distinguishing marks with their exact location; (6) asymmetries.\n\n" +
        "Describe only what is visible or safely inferable — never invent a mark you cannot see. Do not soften, slim, " +
        "de-age or beautify anything. Do not name or guess at the identity of the person, and do not mention that a " +
        "reference image exists. Output the paragraph only, with no preamble and no closing comment.",
    },
    {
      id: "context",
      kind: "text",
      title: "מי הדמות? הקשר, תפקיד, עולם, תקופה — ובאיזה מדיום",
      hint:
        "ככל שתפרט יותר, כך הדמות תהיה מדויקת יותר. כאן גם נקבע המדיום: צילום ריאליסטי · " +
        "איור · תלת-ממד מונפש בסגנון פיקסר · קומיקס · ציור שמן. אם לא תגיד — יצא צילום. " +
        "למשל: בלש בעולם נואר של שנות ה-40, כאיור בדיו · נווד במדבר פוסט-אפוקליפטי, צילום",
    },
    {
      id: "wardrobeRef",
      kind: "images",
      optional: true,
      // Off by default: this image teaches the prompt what the clothes look like, and
      // must not travel to the image engine, where it would drag its own face and its
      // own medium into the result.
      refDefault: false,
      title: "רפרנס לבוש (רשות)",
      hint:
        "איור, פריים מסרט, צילום אופנה או לוח תלבושות — ממנו ייקראו הלבוש, האביזרים, הפוזה והאנרגיה " +
        "בלבד. אין צורך שיהיה אותו אדם, ולא משנה אם הוא מצויר. אם אין לך — דלג, והלבוש ייגזר מההקשר.",
    },
    {
      id: "wardrobe",
      kind: "ai",
      editable: true,
      usesImages: ["wardrobeRef"],
      title: "קריאת הלבוש והפוזה — מהרפרנס או מההקשר",
      hint:
        "השלב הזה רואה רק את רפרנס הלבוש, לא את תמונות האדם. ממנו נקראים בגדים, אביזרים, פוזה " +
        "ואנרגיה — לא פנים, לא גוף, ולא סגנון הציור. כאן גם נקבעת פוזת האקשן של הדמות, ואפשר לתקן אותה כאן.",
      instruction:
        "Read the attached WARDROBE reference for clothing only. Do not ask questions.\n\n" +
        "Character context: {{context}}\n\n" +
        "Any image attached to THIS stage is a wardrobe reference — an illustration, a film still, a fashion " +
        "photo, a costume plate, or a photograph of someone else entirely. If one is there, describe in a " +
        "single English paragraph: (1) every garment — type, fabric, cut, colour, how it hangs, its condition, and how " +
        "it is worn (buttoned or open, sleeves rolled, tucked or loose, layered over what); (2) the accessories and " +
        "what they signal — hat, eyewear, watch, bag, belt, jewellery, a tool carried; (3) the footwear in full; " +
        "(4) the pose and body language — where the weight sits, shoulders, hands, chin, where the eyes go; (5) the " +
        "attitude and energy the figure projects, in one short phrase; and (6) ONE ACTION POSE for this " +
        "character — the beat you would freeze if this were their trailer. Take it from who the character is " +
        "and from how the figure in the reference carries itself, and describe it physically: where the weight " +
        "is, what each arm and leg is doing, which way the body faces, what the hands hold or reach for, where " +
        "the eyes go, and what is in motion — a coat, hair, fabric, dust. Keep both feet in shot and keep it to " +
        "one clear readable silhouette, not a blur.\n\n" +
        "Take NOTHING else from that reference. Not the face, not the body type, not the age, not the gender, not the " +
        "background, not the lighting, not the camera, and above all not the medium: a drawn reference does not make " +
        "this character drawn, and a photographic one does not make it photographic. You are reading clothes off a " +
        "mannequin, not casting a person.\n\n" +
        "If no image is attached to this stage, the user skipped it: invent the wardrobe from the character " +
        "context instead, at the same level of detail, and say nothing about the absence.\n\n" +
        "Output the paragraph only, in English, with no preamble.",
    },
    {
      id: "sheet",
      kind: "ai",
      final: true,
      // Works from {{identity}} and {{wardrobe}}: both stages already looked at the
      // pictures, and sending them a third time only adds cost.
      usesImages: [],
      title: "בניית הפרומפט הסופי",
      instruction:
        "Build the final character-sheet image prompt. Do not ask questions.\n\n" +
        "The person's identity description (use it verbatim as the identity):\n{{identity}}\n\n" +
        "Character context: {{context}}\n\n" +
        "The wardrobe and poses, already worked out from the reference or from the context:\n{{wardrobe}}\n" +
        "Use that wardrobe as written — its garments, accessories and footwear. Its standing attitude belongs in " +
        "how the character holds themselves in the turnaround panels; its action pose belongs to panel 4 and " +
        "nowhere else. The framing of every panel is fixed below and is not open to interpretation. Nothing " +
        "tight, nothing technical, no logos, no branding.\n\n" +
        "MEDIUM. Read it from the character context above. If it names one — a photograph, an illustration, ink, " +
        "a 3D animated feature look, a comic panel, an oil painting — the whole sheet is rendered in that medium, and " +
        "every line below that describes rendering must be rewritten to suit it. If the context names none, the sheet " +
        "is a photograph. The medium applies to all five panels equally, and it never loosens the likeness: an " +
        "illustrated version of this person still has to be recognisably this person.\n\n" +
        "WEAVE, DO NOT STACK. The identity paragraph is physical truth and not one fact in it may change — but do not " +
        "paste it as a block and then hang an unrelated costume beside it. Write the person INTO the character: fit the " +
        "garments to this body and the way it is built, let the action pose sit on this posture, and let the " +
        "character\'s world account for what this face and this frame look like inside it. Where the reference gave an " +
        "attitude, express it through the features this person actually has. The reader of the finished prompt should " +
        "meet one character, not a description of a person followed by a description of a costume.\n\n" +
        "Fold the identity and the wardrobe into this template and return ONE clean prompt with no brackets left in it:\n\n" +
        "\"Use the attached reference images as follows. The photographs of the person are the identity reference: the " +
        "person in every panel below is that same individual and must be recognisable as them — same face, same bone " +
        "structure, same hair, same skin, same body proportions, same age. If any other reference is attached, it is a " +
        "wardrobe reference only: take the clothing, accessories and pose from it, and take nothing else — not its " +
        "face, not its body, not its lighting, and not its medium. If it is a drawing, the result is still a " +
        "photograph. Copy the person, not the photograph — ignore the identity photographs' clothing, background, " +
        "lighting, crop, pose and camera angle entirely, and rebuild the person under the studio conditions described " +
        "below.\n" +
        "A five-panel character sheet, a single wide landscape image. This image contains five views in total: " +
        "full-body front, full-body three-quarter, full-body back, a full-body action pose, and a tight " +
        "head-and-shoulders close-up. All five must be present, arranged left to right in that order, and all " +
        "five must show the same person in the same clothes.\n" +
        "Panel 1 — full-body front, standing straight and facing the camera in a relaxed pose, arms hanging at their " +
        "sides, full height from head to toe, no cropping at the feet or the top of the head. Head tilted slightly down " +
        "and away so the face is not clearly readable. Panel 2 — full-body three-quarter, rotated 45 degrees to their " +
        "left so both the front and one side of the body are visible. Panel 3 — full-body back, seen from directly " +
        "behind, face not visible at all. Panel 4 — full-body ACTION pose: [the action pose], the whole figure in " +
        "frame with nothing cropped at the feet or the head, in the same studio and the same lighting as the " +
        "others. This is the only panel whose pose is free; the clothes, the hair, the body and the light stay " +
        "identical to the rest. Panel 5 — tight head-and-shoulders close-up, front, looking directly into the " +
        "lens, mouth closed, calm neutral expression. This is the only readable face in the image, and it must " +
        "match the identity photographs exactly.\n" +
        "The character: [the identity and the character woven together — this person\'s real face, build and bearing " +
        "as they appear in this role]. [How this medium treats skin and surface: for a photograph, real skin texture " +
        "with visible pores, natural asymmetry and fine lines, no retouching, no beauty filter, no digital smoothing " +
        "and no glossy plastic skin; for any other medium, that medium\'s own equivalent]. Whatever the medium, do not " +
        "idealise, slim, de-age or beautify the person away from the reference.\n" +
        "Clothing: [garments, as worked out above]. [Accessories]. Footwear: [footwear]. Not tight, not technical, no " +
        "logos, no visible branding.\n" +
        "Bearing: [the pose and attitude, applied to how the character stands in panels 1 to 3 and 5].\n" +
        "Panel 1 clearly shows [what only the front reveals]. Panel 3 shows [what only the back reveals]. All five " +
        "panels matched exactly in scale, anatomy, hair, clothing and lighting — the same garments, the same hair, " +
        "the same body, the same studio. Panel 4 differs in pose alone: it is the same character caught mid-beat, " +
        "not a different design and not a different outfit.\n" +
        "Look: plain solid #7f7f7f mid-grey seamless background, flat even shadow-free lighting, matte surfaces with " +
        "no sheen. [The medium, made concrete: for a photograph, 85mm lens, f/8, photorealistic RAW detail; for any " +
        "other medium, the equivalent craft terms — line weight, brushwork, render quality.] One person alone in " +
        "frame — no props, no other objects, no second figure, no text, no watermark, no panel numbers, no borders, " +
        "no dividing lines between the panels. [The negative that protects this medium: for a photograph, not an " +
        "illustration and not a render; for a drawn or rendered medium, not a photograph and no photographic skin " +
        "texture.]\"\n\n" +
        "Return the finished prompt inside a fenced block exactly like this:\n```prompt\n<the prompt>\n```\n" +
        "Then, in two short lines in Hebrew, say what you decided on my behalf — the medium, and the wardrobe and " +
        "footwear — so I can correct it.",
    },
  ],
};

export const BUILTIN_SKILLS: PromptSkill[] = [CHARACTER_SHEET];

/** Modes a skill's mode step can offer (matches the visible generation modes). */
export const SKILL_MODES: GenerationMode[] = ["generate", "recreate", "fill", "ratio", "upscale"];

// ---------------------------------------------------------------------------
// Workflow planner — building a skill from inside the app.
//
// A workflow is DATA, so any chat model can author one: all it has to return is a
// JSON object. Nothing here is provider-specific. What differs between models is
// how well-formed that JSON is, which is what parseSkill() below absorbs.
// ---------------------------------------------------------------------------

/** Aspect ratios the generation box accepts (mirrors PromptBar's RATIOS). */
export const SKILL_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];

/** The only generation settings a workflow may dictate. Anything else the model
 *  invents is dropped rather than trusted into the generation box. */
const SETTING_KEYS = ["aspectRatio", "ratioTarget", "medium", "styleText", "quality", "variations"] as const;
const QUALITIES = ["low", "medium", "high", "auto"];

export function blankStep(kind: StepKind = "text", n = 1): SkillStep {
  return {
    id: `step${n}`,
    kind,
    title: "",
    ...(kind === "choice" ? { options: ["", ""] } : {}),
    ...(kind === "ai" ? { instruction: "" } : {}),
  };
}

export function blankSkill(): PromptSkill {
  return {
    id: `user-${Date.now().toString(36)}`,
    name: "",
    description: "",
    steps: [blankStep("text", 1), { ...blankStep("ai", 2), final: true }],
  };
}

/** The schema the planner hands the model. Kept in one place so the prompt and the
 *  validator can never drift apart. */
// Deliberately comment-free: a schema written as JSON-with-comments teaches the
// model to answer with JSON-with-comments, which is not JSON. The field rules live
// in the prose below instead.
export const PLANNER_SCHEMA = `{
  "name": "...",
  "description": "...",
  "applySettings": { "aspectRatio": "16:9" },
  "steps": [
    { "id": "photo", "kind": "images", "title": "...", "hint": "...", "refDefault": true },
    { "id": "audience", "kind": "choice", "title": "...", "options": ["...", "..."] },
    { "id": "final", "kind": "ai", "title": "...", "final": true, "instruction": "..." }
  ]
}`;

const PLANNER_FIELDS =
  "Fields:\n" +
  "- name: short Hebrew name. description: one Hebrew line saying what it produces.\n" +
  `- applySettings (optional): aspectRatio or ratioTarget, one of ${SKILL_RATIOS.join(" / ")} or "auto"; ` +
  `medium and styleText (free text); quality, one of ${QUALITIES.join(" / ")}; variations, 1-8.\n` +
  "- steps: 1 to 12 objects, run in order. Each has id (unique, letters/digits/_/-), " +
  "kind (text | choice | images | mode | ai), title (Hebrew), and optionally hint (Hebrew).\n" +
  "- choice steps also need options: an array of at least two strings.\n" +
  "- images steps may set refDefault: true, meaning the attached images become reference " +
  "images for the generated image.\n" +
  "- ai steps also need instruction (English), and may set editable: true (pause so the user " +
  "can correct the output) and final: true.";

export const PLANNER_SYSTEM =
  "You design workflows for an image-editor prompt assistant. A workflow is a short " +
  "sequence of steps that collects what is needed from the user and ends with an AI step " +
  "that writes ONE finished image-generation prompt.\n\n" +
  "Read the user's request and break it down before writing anything: decide which " +
  "information only the user can supply (that becomes a text / choice / images step) and " +
  "which the model can work out on its own (that becomes an ai step). Then design the " +
  "shortest sequence that gets from what the user has to a finished prompt.\n\n" +
  "Rules:\n" +
  "- 'text', 'choice' and 'images' steps ask the USER for something. 'ai' steps call a " +
  "language model with their `instruction`. 'mode' asks which generation mode to run.\n" +
  "- An `instruction` may inject an earlier step's answer with {{stepId}} — the step must " +
  "come EARLIER in the list.\n" +
  "- Exactly one 'ai' step has \"final\": true, and it must be the last step. Its instruction " +
  "must tell the model to return the finished prompt inside a fenced ```prompt block.\n" +
  "- Keep it to the fewest steps that do the job. Titles and hints in Hebrew; `instruction` " +
  "text in English (image models respond better to English prompts).\n" +
  "- Do not add a 'mode' step unless the workflow really needs it — one is added automatically.\n\n" +
  PLANNER_FIELDS +
  "\n\nAnswer with ONE fenced json block and nothing else. It must be strict JSON: double " +
  "quotes, no comments, no trailing commas, no placeholder text left in it. Shape:\n" +
  "```json\n" + PLANNER_SCHEMA + "\n```";

export interface ParseResult {
  /** The normalised workflow — present even when `errors` is non-empty, so the editor
   *  can open on a partial draft. Null only when the input wasn't a JSON object. */
  skill: PromptSkill | null;
  /** Blocking problems — the draft must not be run or saved until they are fixed. */
  errors: string[];
  /** Things silently corrected or dropped, worth telling the user about. */
  warnings: string[];
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Walk `src` outside of string literals, letting `at` decide what to emit/skip. */
function scanJson(src: string, at: (i: number, emit: (s: string) => void) => number | void): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    const jump = at(i, (s) => (out += s));
    if (typeof jump === "number") i = jump;
  }
  return out;
}

/** JSON.parse, but tolerant of what language models actually emit around it:
 *  // and /* *\/ comments, and trailing commas before a closing brace. Throws like
 *  JSON.parse when the text really isn't an object. */
export function looseJsonParse(src: string): unknown {
  try {
    return JSON.parse(src);
  } catch {
    /* fall through and clean it up */
  }
  const noComments = scanJson(src, (i, emit) => {
    if (src[i] === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      emit("\n");
      return j;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
      return j + 1;
    }
    emit(src[i]);
  });
  const noTrailingCommas = scanJson(noComments, (i, emit) => {
    if (noComments[i] === ",") {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (noComments[j] === "}" || noComments[j] === "]") return i; // drop the comma
    }
    emit(noComments[i]);
  });
  return JSON.parse(noTrailingCommas);
}

/** Validate and normalise a workflow object (from a model, a paste, or the editor).
 *  Never throws, never evaluates anything — unknown fields are dropped. */
export function parseSkill(input: unknown): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: any = input;
  if (typeof raw === "string") {
    try {
      raw = looseJsonParse(raw);
    } catch (e) {
      return { skill: null, errors: [`ה-JSON לא תקין: ${(e as Error).message}`], warnings };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { skill: null, errors: ["מצופה אובייקט JSON אחד"], warnings };
  }
  // An exported skill or session wraps the workflow in { skill: ... } — accept it, so
  // anything this app exports can be pasted straight back in.
  if (!Array.isArray(raw.steps) && raw.skill && typeof raw.skill === "object") raw = raw.skill;

  const name = isStr(raw.name) ? raw.name.trim() : "";
  if (!name) errors.push("חסר שם לוורקפלו (name)");
  const description = isStr(raw.description) ? raw.description.trim() : "";
  if (!description) warnings.push("אין תיאור (description) — נוסף תיאור ריק");

  // Settings: keep only real, valid GenerationSettings fields.
  let applySettings: Partial<GenerationSettings> | undefined;
  if (raw.applySettings && typeof raw.applySettings === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw.applySettings)) {
      if (!(SETTING_KEYS as readonly string[]).includes(k)) {
        warnings.push(`הגדרה לא מוכרת הוסרה: ${k}`);
        continue;
      }
      if ((k === "aspectRatio" || k === "ratioTarget") && !(v === "auto" || SKILL_RATIOS.includes(String(v)))) {
        warnings.push(`יחס צלעות לא חוקי הוסר: ${String(v)}`);
        continue;
      }
      if (k === "quality" && !QUALITIES.includes(String(v))) {
        warnings.push(`ערך quality לא חוקי הוסר: ${String(v)}`);
        continue;
      }
      if (k === "variations" && !(typeof v === "number" && v >= 1 && v <= 8)) {
        warnings.push("variations חייב להיות 1–8 — הוסר");
        continue;
      }
      out[k] = v;
    }
    if (Object.keys(out).length) applySettings = out as Partial<GenerationSettings>;
  }

  const rawSteps: any[] = Array.isArray(raw.steps) ? raw.steps : [];
  if (!rawSteps.length) errors.push("אין שלבים (steps)");

  const seen = new Set<string>();
  const steps: SkillStep[] = [];
  rawSteps.forEach((s, i) => {
    const where = `שלב ${i + 1}`;
    if (!s || typeof s !== "object") {
      errors.push(`${where}: לא אובייקט`);
      return;
    }
    let id = isStr(s.id) ? s.id.trim() : "";
    if (!/^\w[\w-]*$/.test(id)) {
      errors.push(`${where}: מזהה (id) חסר או לא חוקי${id ? ` — "${id}"` : ""}`);
      id = `step${i + 1}`;
    }
    if (seen.has(id)) {
      errors.push(`${where}: המזהה "${id}" מופיע פעמיים`);
      return;
    }
    seen.add(id);

    const kind = STEP_KINDS.includes(s.kind) ? (s.kind as StepKind) : null;
    if (!kind) {
      errors.push(`${where}: סוג לא חוקי "${String(s.kind)}" (${STEP_KINDS.join(" / ")})`);
      return;
    }
    if (!isStr(s.title)) errors.push(`${where}: חסרה כותרת (title)`);

    const step: SkillStep = { id, kind, title: isStr(s.title) ? s.title.trim() : "" };
    if (isStr(s.hint)) step.hint = s.hint.trim();

    if (kind === "choice") {
      const options = Array.isArray(s.options) ? s.options.filter(isStr).map((o: string) => o.trim()) : [];
      if (options.length < 2) errors.push(`${where}: שלב בחירה צריך לפחות שתי אפשרויות`);
      step.options = options;
    }
    if (kind === "images" && typeof s.refDefault === "boolean") step.refDefault = s.refDefault;
    if (typeof s.optional === "boolean") step.optional = s.optional;
    if (kind === "ai") {
      if (!isStr(s.instruction)) errors.push(`${where}: שלב AI חייב הוראה (instruction)`);
      step.instruction = isStr(s.instruction) ? s.instruction : "";
      if (s.editable === true) step.editable = true;
      if (s.final === true) step.final = true;
      if (isChatProvider(s.provider)) step.provider = s.provider;
      if (isStr(s.model)) step.model = s.model.trim();
      if (Array.isArray(s.usesImages)) step.usesImages = s.usesImages.filter(isStr).map((x: string) => x.trim());
    }
    steps.push(step);
  });

  // A workflow has to end in a written prompt.
  const aiSteps = steps.filter((s) => s.kind === "ai");
  const finals = aiSteps.filter((s) => s.final);
  if (!aiSteps.length) {
    errors.push("הוורקפלו חייב שלב AI אחד לפחות שמנסח את הפרומפט");
  } else if (!finals.length) {
    aiSteps[aiSteps.length - 1].final = true;
    warnings.push(`אף שלב לא סומן כסופי — סומן "${aiSteps[aiSteps.length - 1].id}"`);
  } else if (finals.length > 1) {
    finals.slice(0, -1).forEach((s) => delete s.final);
    warnings.push("יותר משלב סופי אחד — נשמר האחרון בלבד");
  }

  // An ai stage can only read images a step BEFORE it collected.
  steps.forEach((s, i) => {
    if (!s.usesImages) return;
    const earlierImages = new Set(steps.slice(0, i).filter((x) => x.kind === "images").map((x) => x.id));
    for (const id of s.usesImages) {
      if (!earlierImages.has(id)) errors.push(`שלב ${i + 1}: usesImages מפנה ל-"${id}" שאינו שלב תמונות קודם`);
    }
  });

  // {{refs}} must point at a step that already ran.
  steps.forEach((s, i) => {
    const earlier = new Set(steps.slice(0, i).map((x) => x.id));
    for (const m of (s.instruction ?? "").matchAll(/\{\{(\w[\w-]*)\}\}/g)) {
      if (!earlier.has(m[1])) errors.push(`שלב ${i + 1}: {{${m[1]}}} לא מפנה לשלב קודם`);
    }
  });

  const id = /^[\w-]+$/.test(String(raw.id ?? "")) ? String(raw.id) : `user-${Date.now().toString(36)}`;
  const skill: PromptSkill = { id, name, description, steps, ...(applySettings ? { applySettings } : {}) };
  // The skill comes back even when it has errors, so the editor can open on what the
  // model DID produce instead of throwing the whole draft away. Callers must gate on
  // `errors.length` before running or saving it.
  return { skill, errors, warnings };
}
