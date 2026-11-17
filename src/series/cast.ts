// The cast file: one character per person, derived from their row in the sheet.
//
// This is the layer the agent authors and the user reviews. A source sheet holds raw
// material — trailer ideas, how they dress, an accessory people recognise them by, what
// they'd rather not see — and the model turns each row into a character brief. From
// there each person's brief becomes the `context` answer of the existing character-sheet
// workflow, alongside their photos. Nothing about the workflow changes.

/** How the finished image should look — this is what picks the workflow variant. */
export type RenderStyle = "photoreal" | "pixar" | "illustrated";
export const RENDER_STYLES: RenderStyle[] = ["photoreal", "pixar", "illustrated"];

export interface CastCharacter {
  /** Who they play, in one line: the character and the film it comes from. */
  role: string;
  /** The film / world the trailer idea points at. */
  film: string;
  /** Why this person suits it — the line that came out of their own answers. */
  why: string;
  wardrobe: string;
  accessories: string[];
  /** Look, palette, texture — what makes it feel like them. */
  style: string;
  pose: string;
  mood: string;
  render: RenderStyle;
}

export interface CastEntry {
  /** The person, exactly as the folder/sheet join named them. */
  name: string;
  /** The folder their photos live in, when one was matched. */
  folder?: string;
  /** Which trailer idea this came from (1 or 2), so the other stays available. */
  trailer: 1 | 2;
  character: CastCharacter;
  /** Hard limits taken from the sheet's "don't include" answers. Never creative input. */
  avoid: string[];
  /** Facts the brief needed and the row didn't have. Surfaced, never invented around. */
  missing: string[];
  /** The single paragraph that answers the workflow's `context` step. */
  context: string;
}

export interface CastFile {
  kind: "mbrush.cast";
  version: 1;
  project: string;
  brief: string;
  people: CastEntry[];
}

export interface CastParse {
  cast: CastFile | null;
  errors: string[];
  warnings: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter(Boolean) : str(v) ? [str(v)] : [];

/** Validate and normalise a cast file — from the model, a paste, or the editor.
 *  Never throws; a person with a broken entry is reported by name, because in a run of
 *  thirty-four the useful error is "מיכל ששון חסרה תפקיד", not "invalid JSON at people[17]". */
export function parseCast(input: unknown, knownNames?: string[]): CastParse {
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: any = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return { cast: null, errors: [`ה-JSON לא תקין: ${(e as Error).message}`], warnings };
    }
  }
  // A bare array of people is accepted as well as the wrapped file — a model asked for
  // "one entry per person" often answers with just the list.
  if (!raw || typeof raw !== "object") {
    return { cast: null, errors: ["מצופה אובייקט JSON אחד"], warnings };
  }
  const peopleRaw: any[] = Array.isArray(raw) ? raw : Array.isArray(raw.people) ? raw.people : [];
  if (!peopleRaw.length) errors.push("אין אנשים בקובץ (people)");

  const seen = new Set<string>();
  const people: CastEntry[] = [];
  peopleRaw.forEach((p, i) => {
    const where = `רשומה ${i + 1}`;
    if (!p || typeof p !== "object") {
      errors.push(`${where}: לא אובייקט`);
      return;
    }
    const name = str(p.name);
    if (!name) {
      errors.push(`${where}: חסר שם`);
      return;
    }
    if (seen.has(name)) {
      errors.push(`${name}: מופיע פעמיים`);
      return;
    }
    seen.add(name);
    if (knownNames?.length && !knownNames.includes(name)) {
      warnings.push(`${name}: לא נמצא ברשימת האנשים של המאגר`);
    }

    const c = (p.character ?? {}) as Record<string, unknown>;
    const role = str(c.role);
    if (!role) errors.push(`${name}: חסר תפקיד (character.role)`);
    const context = str(p.context);
    if (!context) errors.push(`${name}: חסרה פסקת ההקשר לוורקפלו (context)`);

    const render = RENDER_STYLES.includes(str(c.render) as RenderStyle)
      ? (str(c.render) as RenderStyle)
      : (() => {
          if (str(c.render)) warnings.push(`${name}: סגנון רנדר לא מוכר "${str(c.render)}" — נקבע photoreal`);
          return "photoreal" as RenderStyle;
        })();

    const trailer = p.trailer === 2 ? 2 : 1;
    people.push({
      name,
      folder: str(p.folder) || undefined,
      trailer,
      character: {
        role,
        film: str(c.film),
        why: str(c.why),
        wardrobe: str(c.wardrobe),
        accessories: strList(c.accessories),
        style: str(c.style),
        pose: str(c.pose),
        mood: str(c.mood),
        render,
      },
      avoid: strList(p.avoid),
      missing: strList(p.missing),
      context,
    });
  });

  const cast: CastFile = {
    kind: "mbrush.cast",
    version: 1,
    project: str(raw.project) || "ליהוק",
    brief: str(raw.brief),
    people,
  };
  // Returned even with errors, so the review table can show what DID come back.
  return { cast, errors, warnings };
}

/** People the brief could not be completed for — the run should stop on these. */
export function castGaps(cast: CastFile): { name: string; missing: string[] }[] {
  return cast.people.filter((p) => p.missing.length).map((p) => ({ name: p.name, missing: p.missing }));
}

/** The bridge into the existing workflow: this entry's answers for the skill's steps.
 *  `context` is the workflow's own step id in the built-in character sheet. */
export function castToAnswers(entry: CastEntry): Record<string, string> {
  const c = entry.character;
  const bits = [
    entry.context,
    c.wardrobe && `לבוש: ${c.wardrobe}`,
    c.accessories.length && `אביזרים: ${c.accessories.join(", ")}`,
    c.style && `סגנון: ${c.style}`,
    c.pose && `פוזה: ${c.pose}`,
    c.mood && `אווירה: ${c.mood}`,
    entry.avoid.length && `אסור להופיע: ${entry.avoid.join(", ")}`,
  ].filter(Boolean);
  return { context: bits.join("\n") };
}

// ---------------------------------------------------------------------------
// The briefing pass — the agent reads the sheet and writes the cast.
// ---------------------------------------------------------------------------

/** The cast file's shape, comment-free on purpose: a schema written as JSON with //
 *  comments teaches the model to answer with JSON-with-comments, which is not JSON. */
export const CAST_SCHEMA = `{
  "project": "...",
  "brief": "...",
  "people": [
    {
      "name": "...",
      "folder": "...",
      "trailer": 1,
      "character": {
        "role": "...", "film": "...", "why": "...",
        "wardrobe": "...", "accessories": ["...", "..."],
        "style": "...", "pose": "...", "mood": "...",
        "render": "photoreal"
      },
      "avoid": ["..."],
      "missing": ["..."],
      "context": "..."
    }
  ]
}`;

export const CAST_SYSTEM =
  "אתה מנהל ליהוק ומעצב דמויות. מולך טבלה שבה כל שורה היא אדם אמיתי, ומולך משימה: " +
  "להפוך כל שורה לדמות אחת שאותו אדם מגלם.\n\n" +
  "החומר בשורה:\n" +
  "· עמודות רעיון הטריילר הן הבסיס — הן כבר מציעות דמות, סרט וסיבה. בחר אחת מהן " +
  "(סמן ב-trailer איזו), ואל תמציא דמות אחרת אלא אם שתיהן ריקות.\n" +
  "· שאר העמודות הן חומר הגלם לעיצוב: איך הוא מתלבש, איזה אביזר מזוהה איתו, סגנון " +
  "וצבעים, אווירה, ז'אנרים וסרטים אהובים, תחביבים, ומה שחשוב לו שירגישו. עבור על כל " +
  "השורה — לפעמים הפרט שעושה את הדמות מסתתר בעמודה שלא ציפית לה. **זה המקום שבו אתה " +
  "תורם קריאייטיב**: לקשור בין האביזר האמיתי שלו לבין הדמות, ולתת לזה תפקיד בסצנה.\n" +
  "· עמודות מה שלא רוצים שיופיע ומה רגיש הן **קו אדום**, לא חומר קריאייטיבי. כל מה " +
  "שמופיע בהן נכנס ל-avoid, ואסור שייכנס לשום שדה אחר.\n\n" +
  "לכל אדם קבע: תפקיד (הדמות והסרט), לבוש, אביזרים, סגנון וצבעים, פוזה, אווירה, " +
  "וסגנון רנדר אחד מתוך photoreal / pixar / illustrated. בחר את סגנון הרנדר לפי הדמות " +
  "והאווירה — דמות מונפשת היא pixar, דמות אקשן חיה היא photoreal.\n\n" +
  "אם חסר מידע שבלעדיו הדמות לא מתעצבת — אל תמציא. רשום ב-missing מה חסר, במילים " +
  "של המשתמש, והמשך עם מה שכן יש.\n\n" +
  "שדה context הוא פסקה אחת קצרה בעברית: מי הדמות, באיזה עולם היא חיה, ומה מצב הרוח. " +
  "היא נכנסת כמו שהיא לתוך וורקפלו 'דף דמות', אז אל תתאר בה את האדם האמיתי (הפנים " +
  "מגיעות מהתמונות שלו) — רק את הדמות.\n\n" +
  "החזר JSON קפדני אחד בבלוק json: מרכאות כפולות, בלי הערות, בלי פסיק עודף, ובלי " +
  "טקסט מחוץ לבלוק. המבנה:\n```json\n" + CAST_SCHEMA + "\n```";

/** One row, flattened for the briefing prompt: every non-empty column, labelled.
 *  The whole row goes in — the useful detail is often in a column nobody predicted. */
export function rowForBriefing(row: Record<string, string>, name: string): string {
  const lines = Object.entries(row)
    .filter(([, v]) => (v ?? "").trim())
    .map(([k, v]) => `  ${k}: ${String(v).trim()}`);
  return `### ${name}\n${lines.join("\n")}`;
}
