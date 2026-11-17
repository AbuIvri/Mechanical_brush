// Turning what is on the canvas into what the assistant can see.
//
// The marking tool exists to say "this part, here" — so when the user asks a question
// with a region marked and nothing attached, the model gets the whole image AND a crop
// of the marked area, rather than being asked to guess. The manual "@" attachments and
// this automatic look build their images the same way, from here.

import type { Project } from "../../shared/types";
import type { Attachment } from "../state/chat";
import {
  type Box,
  type MaskState,
  cropRegion,
  downscaleToMax,
  flattenLayers,
  makeThumbnail,
  maskBounds,
  maskHasContent,
  padBox,
  rasterizeMask,
  withAnnotations,
} from "../compositing";
import { pinListNote, pinsOf } from "../pins";

/** What the chat model sees. Bigger buys nothing for "what is in this picture". */
const CHAT_EDGE = 768;
/** Padding around a marked region, as a fraction of its size — the model has to see
 *  what the region joins onto, not just the hole. */
const REGION_PAD = 0.15;

async function toAttachment(src: string, label: string, full: boolean): Promise<Attachment> {
  return {
    src: await makeThumbnail(src, CHAT_EDGE),
    // The ≤2048 copy only matters if the image may later be promoted to a generation
    // reference. The automatic look never is — it is already on the canvas.
    full: full ? (await downscaleToMax(src, 2048)).src : "",
    label,
    asRef: false,
  };
}

/** The markup the user drew to explain themselves, when the layer is switched on. */
function liveAnnotations(project: Project) {
  const a = project.annotations;
  return a?.visible ? a.items : [];
}

/** The canvas as one image. Callers that need it twice pass the result back in via
 *  `opts.flat` — flattening a large project is not something to do twice a turn. */
export function flattenProject(project: Project): Promise<string> {
  const { width, height, backgroundColor } = project.canvas;
  return flattenLayers(project.layers, width, height, backgroundColor || "#ffffff");
}

/** The flattened canvas as a chat attachment. */
export async function wholeCanvasImage(
  project: Project,
  opts: { full?: boolean; label?: string; flat?: string } = {},
): Promise<Attachment> {
  const flat = opts.flat ?? (await flattenProject(project));
  return toAttachment(flat, opts.label ?? "התמונה הפתוחה", !!opts.full);
}

/** The marked region, cropped with padding. Null when nothing is marked. */
export async function markedRegionImage(
  project: Project,
  mask: MaskState,
  opts: { full?: boolean; label?: string; flat?: string } = {},
): Promise<{ image: Attachment; box: Box } | null> {
  if (!maskHasContent(mask)) return null;
  const { width, height } = project.canvas;
  const tight = await maskBounds(rasterizeMask(mask, width, height), width, height);
  if (!tight) return null;
  const box = padBox(tight, Math.round(Math.max(tight.w, tight.h) * REGION_PAD), width, height);
  const flat = opts.flat ?? (await flattenProject(project));
  const crop = await cropRegion(flat, box);
  return { image: await toAttachment(crop, opts.label ?? "האזור המסומן", !!opts.full), box };
}

const pct = (n: number, of: number) => Math.round((n / of) * 100);

/** Where the region sits, in plain words. A crop tells the model *what*; this tells
 *  it *where*, which a bare crop cannot. */
export function describeRegion(box: Box, width: number, height: number): string {
  const x1 = pct(box.x, width);
  const x2 = pct(box.x + box.w, width);
  const y1 = pct(box.y, height);
  const y2 = pct(box.y + box.h, height);
  const area = Math.round((box.w * box.h * 100) / (width * height));
  return `${x1}%–${x2}% לרוחב, ${y1}%–${y2}% לגובה (כ-${area}% משטח התמונה)`;
}

/** The canvas with the user's markup drawn on it. Null when nothing is marked. */
export async function annotatedCanvasImage(
  project: Project,
  opts: { flat?: string; label?: string } = {},
): Promise<Attachment | null> {
  const items = liveAnnotations(project);
  if (!items.length) return null;
  const { width, height } = project.canvas;
  const flat = opts.flat ?? (await flattenProject(project));
  const marked = await withAnnotations(flat, items, width, height);
  return toAttachment(marked, opts.label ?? "התמונה עם הסימונים שלי", false);
}

/** What the markup is, what it is NOT, and what to do when it doesn't explain itself.
 *
 *  The last part exists because a mark is a question the user hasn't finished asking: a
 *  pin with no note, or a circle with no words, says "here" but not "what". Guessing
 *  produced confident prompts for changes nobody wanted. */
export function annotationNote(count: number, pinNote = ""): string {
  return (
    `התמונה האחרונה היא אותו קנבס עם ${count} סימונים שהמשתמש צייר או כתב עליו ` +
    "(קווים, חצים, מסגרות, הערות טקסט וסיכות ממוספרות). הסימונים האלה הם הוראות ממני אליך — הם לא חלק " +
    "מהתמונה. אל תתאר אותם, אל תזכיר אותם בפרומפט, ואל תבקש שהם יופיעו בתוצאה. " +
    "השתמש בהם רק כדי להבין על מה בדיוק מדובר ומה צריך להשתנות." +
    (pinNote ? `\n${pinNote}` : "") +
    "\nלכל סיכה בלי הערה, ולכל סימון שלא ברור מהשיחה מה רוצים לשנות בו — שאל את המשתמש מה " +
    "השינוי המבוקש שם, לפני שאתה מציע פתרון. אפשר לשאול על כמה מהם בהודעה אחת קצרה, לפי " +
    "המספרים. סיכה או סימון שכבר אומרים מה לשנות — קח אותם כבקשה עצמה ואל תשאל שוב."
  );
}

/** The one line of text that explains the attached images to the model.
 *
 *  `userImages` is how many images the USER attached after the canvas set. Without it the
 *  model reads them as more of the canvas — the note used to say "the attached image is
 *  the canvas", which was true only while the canvas travelled alone. */
export function canvasNote(project: Project | null, box: Box | null, userImages = 0): string {
  const extra =
    userImages > 0
      ? ` בנוסף מצורפות ${userImages === 1 ? "עוד תמונה אחת שהמשתמש צירף בעצמו" : `עוד ${userImages} תמונות שהמשתמש צירף בעצמו`} — הן באות אחרי תמונות הקנבס, והן לא חלק ממנו.`
      : "";
  if (!project) {
    // No project: whatever is attached is the user's, and there is no canvas to describe.
    return userImages > 0 ? "אין פרויקט פתוח. התמונות המצורפות הן של המשתמש." : "";
  }
  const { width, height } = project.canvas;
  const size = `הקנבס: ${width}×${height} פיקסלים.`;
  if (!box) return `${size} התמונה הראשונה היא הקנבס כפי שהוא כרגע. אין אזור מסומן.${extra}`;
  return (
    `${size} שתי התמונות הראשונות הן הקנבס: הראשונה הקנבס המלא, השנייה חיתוך של האזור ` +
    `שהמשתמש סימן — ${describeRegion(box, width, height)}, עם מעט שוליים סביבו. ` +
    `התייחס לאזור המסומן, והשתמש בתמונה המלאה כדי להבין את ההקשר סביבו.${extra}`
  );
}

/** What the model sees when the user attached nothing: the canvas, plus the marked
 *  region when there is one. Rebuilt on every turn — the canvas is live, and a
 *  snapshot kept from an earlier turn would be a lie by the next generation. */
export async function buildAutoContext(
  project: Project | null,
  mask: MaskState,
): Promise<{ images: Attachment[]; note: string; regionBox: Box | null; extraNote: string }> {
  if (!project) return { images: [], note: "", regionBox: null, extraNote: "" };
  const flat = await flattenProject(project);
  const whole = await wholeCanvasImage(project, { label: "התמונה הפתוחה (אוטומטי)", flat });
  const region = await markedRegionImage(project, mask, { label: "האזור המסומן (אוטומטי)", flat });
  // The clean canvas always goes first, so the model can tell the picture from the
  // markup drawn on top of it.
  const marked = await annotatedCanvasImage(project, { flat, label: "הסימונים שלי (אוטומטי)" });
  const images = [whole, ...(region ? [region.image] : []), ...(marked ? [marked] : [])];
  const regionBox = region?.box ?? null;
  // The markup note is separate so a caller that knows how many user images follow can
  // build the canvas line itself and still keep this.
  const live = liveAnnotations(project);
  const pins = pinListNote(pinsOf(live), project.canvas.width, project.canvas.height);
  const extraNote = marked ? " " + annotationNote(live.length, pins) : "";
  return { images, note: canvasNote(project, regionBox) + extraNote, regionBox, extraNote };
}
