import { useEffect, useRef, useState } from "react";
import { roleSpec } from "../../shared/referenceGuide";
import { DOCK_MODES } from "../../shared/modes";
import { useStore, modeLabel, formatDuration } from "../state/store";
import type { GenerationMode } from "../../shared/types";
import { useLayout } from "../state/layout";
import { contextForSend, useChat, type Attachment, type ChatMsg, type ChatSession } from "../state/chat";
import { makeThumbnail, maskHasContent } from "../compositing";
import {
  BUILTIN_SKILLS,
  PLANNER_SYSTEM,
  SKILL_MODES,
  interpolate,
  parseSkill,
  skillSteps,
  type PromptSkill,
  type SkillStep,
} from "./skills";
import { PROVIDERS, providerDef, type ChatProvider } from "./chatModels";
import { Markdown, splitBlocks } from "./miniMarkdown";
import { asPromptBlock, asPromptListBlock, gateOpen, promptBlocks, wordCount, type PromptBlock, type PromptListBlock } from "./promptBlocks";
import { useBatch } from "../state/batch";
import { annotatedCanvasImage, buildAutoContext, canvasNote, markedRegionImage, wholeCanvasImage } from "./canvasContext";
import { buildSessionExport, buildSkillExport, saveJson } from "./exportJson";
import { ChatTabs } from "./ChatTabs";
import { WorkflowPlanner } from "./WorkflowPlanner";
import { Splitter } from "./Docks";
import { useDismiss } from "./useDismiss";
import { useFileDrop } from "./useFileDrop";
import { downscaleToMax } from "../compositing";
import { Icon } from "./Icon";

const LS_PROVIDER = "mbrush.chat.provider";
const LS_MODELS = "mbrush.chat.models";

// The assistant is a conversation partner about image editing, not a prompt vending
// machine. The rule that matters most is first and stated as a prohibition: an earlier
// version asked nicely for conversation and then ended with "give the prompt in two
// versions", and the model followed the concrete instruction every time. The two-version
// format now lives under "when asked" and nowhere else.
const SYSTEM_PROMPT =
  "אתה עוזר בתוך 'המכחול המכני' — עורך תמונות מבוסס שכבות שבו AI מבצע מילוי גנרטיבי " +
  "(עריכת אזור מסומן), אפסקייל, יצירה מחדש, הסרת רקע, שינוי פורמט ויצירה מטקסט.\n\n" +
  "הכלל הראשון: אתה לא מחלק פרומפטים. המשתמש בא עם בעיה, ותפקידך קודם כל להבין אותה " +
  "ולעזור לו להבין מה הוא בעצם צריך. פרומפט נכתב רק כשהוא מבוקש.\n\n" +
  "איך מנהלים את השיחה:\n" +
  "· תסתכל על מה שצורף לפני שאתה עונה, ותתבסס על מה שאתה באמת רואה.\n" +
  "· אם משהו לא ברור — שאל שאלה אחת קצרה. אחת, לא רשימה.\n" +
  "· אם הבנת — נסח את המטרה במשפט אחד לאישור, ואם יש כמה דרכים להשיג אותה, אמור אותן " +
  "בקצרה כדי שהמשתמש יבחר.\n" +
  "· 'לא בטוח שהבנתי — להסיר את הכתם או להחליף אותו במשהו?' היא תשובה טובה ומלאה.\n" +
  "· ענה בעברית, קצר.\n\n" +
  "**מה אפשר להציע כאן, ומה לא:**\n" +
  "הכלי היחיד שעומד לרשות המשתמש הוא עריכה גנרטיבית — על אזור מסומן או על הפריים כולו. " +
  "אין כאן שכבות טקסט, אין כלי טקסט, אין וקטורים, אין מברשת ריטוש ידנית ואין תוכנה " +
  "אחרת שאפשר לעבור אליה. לכן:\n" +
  "· לעולם אל תציע פעולה שאינה גנרטיבית — 'תערוך את שכבת הטקסט', 'תשתמש בכלי הטקסט', " +
  "'עדיף לתקן את זה ידנית', 'תעשה את זה בפוטושופ/אילוסטרייטור' וכל וריאציה על זה. " +
  "עצה כזאת חסרת ערך למשתמש שעומד מול הכלי הזה.\n" +
  "· טקסט בתמונה מתוקן כמו כל דבר אחר: מסמנים את האזור ומבקשים מהמודל לכתוב אותו נכון. " +
  "אם זה קשה — אמור שזה קשה ואיך לנסח כדי להצליח, לא שצריך כלי אחר.\n" +
  "· אם מה שהמשתמש רוצה באמת לא ניתן להשגה בעריכה גנרטיבית, אמור זאת ישירות ובקצרה, " +
  "והצע את הדבר הקרוב ביותר שכן אפשרי כאן.\n\n" +
  "**כשמבקשים ממך פרומפט** — ורק אז:\n" +
  "· קצר, פשוט ומדויק. תגיד מה משתנה, מה חייב להישאר, ואם צריך — דבר אחד שאסור לעשות.\n" +
  "· רעיון אחד לכל פסוקית. שתיים עד ארבע שורות קצרות, לא יותר.\n" +
  "· בלי ערימות תארים, בלי מילים נרדפות, ובלי מילוי כמו 'photorealistic, high quality, " +
  "seamless blend' — המודל כבר יודע. כל תואר מיותר הוא עוד משיכה לכיוון אחר.\n" +
  "· אל תתאר חלקים בתמונה שלא נוגעים למשימה.\n" +
  "· דוגמה לסגנון הנכון: 'הסר את הכתם המטושטש האדמדם והשלם את משטח החיתוך ואת הדג " +
  "האחרון שגובל בו, תוך החזרת פרטים והתאמת הטקסטורה לשאר הדגים. אל תוסיף עוד דג.'\n" +
  "· תן אותו בשתי גרסאות, אותו תוכן, שתיהן קצרות — עברית ואנגלית, כל אחת בבלוק משלה:\n" +
  "```prompt\n<הגרסה בעברית>\n```\n```prompt-en\n<the English version>\n```\n" +
  "בלוקים כאלה שמורים לפרומפט מוכן לשימוש בלבד. אל תעטוף בהם שום דבר אחר.\n\n" +
  "**כשמבקשים ממך כמה פרומפטים בבת אחת** (רשימה, סדרה, וריאציות לקמפיין): כתוב את כולם " +
  "בבלוק אחד ```prompts — פרומפט אחד בכל פסקה ושורה ריקה ביניהם, באנגלית בלבד. כל אחד " +
  "נשלח לבד ליצירת תמונה, אז כל אחד צריך לעמוד בפני עצמו. מותר להתחיל פרומפט ב-[16:9] " +
  "(או יחס אחר) אם הוא צריך יחס משלו. בלי מספור ובלי כותרות בתוך הבלוק.";

/** The one instruction that decides whether this turn may end in a prompt. Sent with
 *  every turn, because the standing rules alone were not enough. */
function gateDirective(open: boolean): string {
  return open
    ? "המשתמש ביקש פרומפט. נסח אותו עכשיו, בשתי הגרסאות. " +
      "אם המשימה שסיכמתם לא מתאימה למצב שהפרומפט נכתב עבורו — אמור זאת במשפט אחד לפני " +
      "הפרומפט, וכתוב אותו בכל זאת עבור המצב שנבחר."
    : "בתור הזה אסור לך לכתוב בלוק prompt, אלא אם המשתמש ביקש זאת במפורש במילים שלו. " +
        "במקום זה: הבן את הבעיה, שאל שאלה אחת אם חסר לך משהו, וסיים בשורה אחת שמציעה " +
        "לנסח פרומפט כשתהיו מסוכמים.";
}

// Mode-specific guidance: what the prompt is about in this mode, and the mistake
// worth naming for it. This describes the mode the prompt is being WRITTEN FOR, which
// the user picks when asking — not necessarily the mode the app happens to be in.
const MODE_GUIDE: Record<string, string> = {
  fill:
    "המצב הנוכחי מילוי גנרטיבי — עריכה סלקטיבית: שינוי אחד, במקום אחד. הפרומפט אומר רק מה " +
    "משתנה באזור המסומן ואיך הוא מתחבר לסביבה. האפליקציה כבר מוסיפה בעצמה ששאר התמונה נשאר " +
    "כמו שהוא, באותם צבעים, ניגודיות וחדות — אל תכתוב את זה שוב (בלי 'Edit the image and', " +
    "בלי 'change only what I request', בלי 'keep the background unchanged'). אל תתאר את שאר " +
    "התמונה, ואל תוסיף אובייקטים שלא נתבקשו.",
  upscale:
    "המצב הנוכחי אפסקייל: הפרומפט על פרטים וחדות בלבד — לא על תוכן, קומפוזיציה או צבע.",
  recreate:
    "המצב הנוכחי יצירה מחדש — רינדור מחדש של התמונה כולה: הפרומפט מתאר שינוי שחל על כל הפריים " +
    "(תאורה, עונה, חומר, סגנון, איכות), לא תיקון במקום אחד. כתוב מה משתנה בכל התמונה, ומה חייב " +
    "להישאר אם זה חשוב (קומפוזיציה, זווית, זהות הנושא). שינוי באזור אחד מתאים למילוי גנרטיבי — " +
    "אמור זאת במשפט אחד. " +
    "אם יש סיכות על הקנבס ושינוי נקודתי נוגע אליהן, כתוב כל שינוי בשורה משלו שמתחילה בתג הסיכה — " +
    "📍1 ואחריו השינוי — והאפליקציה תמיר את התג לקואורדינטות. אל תכתוב אחוזים בעצמך.",
  generate:
    "המצב הנוכחי יצירה מטקסט: נושא, סביבה, תאורה וזווית. מה שלא נאמר — המודל יבחר, וזה בסדר.",
  removebg:
    "המצב הנוכחי הסרת רקע: הפרומפט כמעט תמיד מיותר — המצב עצמו כבר מבקש לשמר את הנושא " +
    "ולהסיר את כל מה שמאחוריו. הוסף משפט רק אם יש משהו ספציפי שקשה להפריד (שיער, זכוכית, " +
    "צל שנוגע בנושא), ואז תאר רק אותו.",
};

// Skill stages carry their own full instruction (format, language, output shape),
// so they get a minimal system prompt that doesn't override it.
const SKILL_SYSTEM =
  "You are executing one stage of an image-prompt workflow inside an image editor. " +
  "Follow the user's instruction exactly, including its required output format and language. " +
  "Do not ask questions and do not add commentary beyond what the instruction requests.";

function extractPrompt(text: string): string {
  const m = text.match(/```(?:prompt)?\s*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

/** Pull the workflow JSON out of a planner reply: a fenced block (```json, ```JSON
 *  or bare), else the widest {...} span in the text. */
function extractJson(text: string): string {
  const blocks = splitBlocks(text).filter((b) => b.kind === "code");
  const block =
    blocks.find((b) => (b.lang ?? "").toLowerCase() === "json") ?? blocks.find((b) => !b.lang) ?? blocks[0];
  if (block) return block.content;
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  return s >= 0 && e > s ? text.slice(s, e + 1) : text;
}

/** Live "the model is thinking" indicator — skill stages can take a while, so show
 *  elapsed time rather than a silent spinner. */
function Thinking({ since, label }: { since: number; label: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((v) => v + 1), 500);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="skill-thinking">
      <span className="spinner-sm" />
      <span>{label} · {formatDuration(Math.max(0, Date.now() - since))}</span>
    </div>
  );
}

/** The brevity lesson as a one-click follow-up. */
const SHORTEN_ASK = "קצר את הפרומפט לעיקר בלבד: מה משתנה, מה נשאר, ומה אסור. בלי תארים מיותרים.";

/** A proposed LIST of prompts. One action — open it in the batch window, prefilled, to
 *  look over before anything is spent. It exists only on an answer that has a list, so
 *  the chat gains nothing permanent. */
function PromptListCard({ block }: { block: PromptListBlock }) {
  return (
    <div className="prompt-card">
      <div className="prompt-card-head">
        <span className="prompt-card-lang">רשימת פרומפטים</span>
        <span className="prompt-card-count">{block.count} תמונות</span>
      </div>
      <pre className="md-code is-prompt plist-card" dir="ltr">{block.text}</pre>
      <div className="chat-msg-actions">
        <button className="chat-use" onClick={() => useBatch.getState().openPrompts(block.text)}>
          צור {block.count} תמונות
        </button>
        <button
          className="chat-use"
          onClick={() => {
            navigator.clipboard.writeText(block.text).catch(() => {});
            useStore.setState({ status: "הרשימה הועתקה ללוח." });
          }}
        >
          העתק
        </button>
      </div>
    </div>
  );
}

/** A proposed prompt — the only thing in a chat answer that is meant to be used as
 *  one, so it is the only thing that carries the "use it" actions. */
function PromptCard({
  block,
  images,
  forMode,
}: {
  block: PromptBlock;
  images: Attachment[];
  /** The mode this prompt was written for, when it differs from the open one. */
  forMode?: GenerationMode;
}) {
  const setPrompt = useStore((s) => s.setPrompt);
  const addReference = useStore((s) => s.addReference);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const modeMismatch = !!forMode && forMode !== mode;
  const promptLibrary = useStore((s) => s.promptLibrary);
  const togglePromptInLibrary = useStore((s) => s.togglePromptInLibrary);
  // Checked by default: an image attached during this conversation was attached on
  // purpose. The choice is made here, in front of the finished prompt, rather than on a
  // toggle noticed earlier or — as before — not offered at all.
  const [picked, setPicked] = useState<Set<number>>(() => new Set(images.map((_, i) => i)));
  const toggle = (i: number) =>
    setPicked((cur) => {
      const next = new Set(cur);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const use = () => {
    setPrompt(block.text);
    // A prompt written for one mode is wrong in another — switching is the whole point
    // of having asked for that mode.
    if (modeMismatch) setMode(forMode!);
    const chosen = images.filter((_, i) => picked.has(i));
    // The full-quality copy, not the 768px the model was shown. Neutral role: the prompt
    // being applied is what says how these are used ("the logo from the reference image"),
    // and "identity" — the old value — now really tells the engine "this is the same person".
    chosen.forEach((a) => void addReference(a.full, "general"));
    const bits = [
      "הפרומפט נכנס לתיבת היצירה",
      modeMismatch ? `המצב הוחלף ל${modeLabel(forMode!)}` : "",
      chosen.length ? `${chosen.length} תמונות ייחוס נוספו` : "",
    ].filter(Boolean);
    useStore.setState({ status: bits.join(" · ") });
  };

  return (
    <div className="prompt-card">
      <div className="prompt-card-head">
        <span className="prompt-card-lang">{block.lang === "he" ? "עברית" : "English"}</span>
        <span className="prompt-card-count">{wordCount(block.text)} מילים</span>
      </div>
      <pre className="md-code is-prompt" dir={block.lang === "en" ? "ltr" : "rtl"}>{block.text}</pre>
      {modeMismatch && (
        <div className="prompt-card-mode">
          נכתב עבור <b>{modeLabel(forMode!)}</b> — לחיצה על "השתמש" תחליף גם את המצב
        </div>
      )}
      {images.length > 0 && (
        <div className="prompt-card-refs">
          <div className="prompt-card-refs-head">
            תמונות ייחוס שיעברו לתיבת היצירה ({picked.size}/{images.length})
          </div>
          <div className="prompt-card-refs-row">
            {images.map((a, i) => (
              <button
                key={i}
                className={`pc-ref ${picked.has(i) ? "on" : ""}`}
                title={a.label}
                onClick={() => toggle(i)}
              >
                <img src={a.src} alt={a.label} />
                <span className="pc-ref-tick">{picked.has(i) ? "נבחר" : ""}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="chat-msg-actions">
        <button className="chat-use" onClick={use}>
          השתמש
        </button>
        <button
          className="chat-use"
          onClick={() => {
            navigator.clipboard.writeText(block.text).catch(() => {});
            useStore.setState({ status: "הפרומפט הועתק ללוח." });
          }}
        >
          העתק
        </button>
        <button
          className={`chat-use ${promptLibrary.includes(block.text) ? "on" : ""}`}
          onClick={() => togglePromptInLibrary(block.text)}
        >
          לספרייה
        </button>
      </div>
    </div>
  );
}

const QUICK_STARTS = [
  "יש לי בעיה בתמונה — בוא נחשוב עליה יחד",
  "מה הכי כדאי לעשות עם האזור שסימנתי?",
  "שפר את הפרומפט הנוכחי שלי",
];

export function ChatDock() {
  const chatOpen = useLayout((s) => s.chatOpen);
  const toggleChat = useLayout((s) => s.toggleChat);
  const mode = useStore((s) => s.mode);
  const engineId = useStore((s) => s.providerId);
  const currentPrompt = useStore((s) => s.prompt);
  const setPrompt = useStore((s) => s.setPrompt);
  const project = useStore((s) => s.project);
  const activeLayerId = useStore((s) => s.activeLayerId);
  const mask = useStore((s) => s.mask);
  const references = useStore((s) => s.references);
  const savedSkills = useStore((s) => s.savedSkills);
  const bumpSkillUsed = useStore((s) => s.bumpSkillUsed);
  const removeSavedSkill = useStore((s) => s.removeSavedSkill);
  const addReference = useStore((s) => s.addReference);
  const updateSettings = useStore((s) => s.updateSettings);
  const pickMode = useStore((s) => s.pickMode);
  const setSkillRun = useStore((s) => s.setSkillRun);
  const savedRun = useStore((s) => s.project?.skillRun ?? null);
  const chatWidth = useLayout((s) => s.chatWidth);
  const setChatWidth = useLayout((s) => s.setChatWidth);
  const chatMax = useLayout((s) => s.chatMax);
  const toggleChatMax = useLayout((s) => s.toggleChatMax);
  const togglePromptInLibrary = useStore((s) => s.togglePromptInLibrary);

  // The visible conversation. Everything below writes back through patchSession(sid),
  // never through "the active tab" — a run that finishes while you are in another tab
  // must land where it started.
  const session = useChat((s) => s.sessions.find((x) => x.id === s.activeId) ?? s.sessions[0]) as ChatSession;
  const patchSession = useChat((s) => s.patchSession);
  const resetSession = useChat((s) => s.resetSession);
  const sid = session.id;
  const { provider, model, msgs, attachments, carry, input, busy, busySince, error } = session;
  const pDef = providerDef(provider);

  // Key presence is a HINT for the banner only — the main process is authoritative
  // and returns a clear missing-key error. Two independent signals, because a stale
  // or failed probe must never lock the user out of the assistant.
  const [keyProbe, setKeyProbe] = useState(true);
  const configuredKeys = useStore((s) => s.configuredKeys);
  const keyOk = keyProbe || configuredKeys.includes(pDef.keyId);
  const [keyInput, setKeyInput] = useState("");
  const [keyDismissed, setKeyDismissed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // The two composer menus: "/" for skills, "@" for context (Cursor-style).
  const [menu, setMenu] = useState<null | "skills" | "context">(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  // The whole composer block is the boundary: a click outside it closes the open
  // menu, while the 🎓/📎 chips inside it keep working as toggles.
  const composerRef = useRef<HTMLDivElement>(null);
  useDismiss(composerRef, () => setMenu(null), menu !== null);
  // Dropped images join the current step's pool, exactly like the 📎 upload does.
  const chatDrop = useFileDrop({
    onFiles: (files) => {
      const target = sid;
      files.forEach(async (f) => {
        try {
          const att = await mkAttachment(f.dataUrl, f.name, true);
          patchSession(target, (s) => ({ attachments: [...s.attachments, att] }));
        } catch (e: any) {
          patchSession(target, { error: e?.message ?? "העלאת התמונה נכשלה" });
        }
      });
    },
  });

  const patch = (p: Partial<ChatSession> | ((s: ChatSession) => Partial<ChatSession>)) => patchSession(sid, p);
  const setError = (e: string | null) => patch({ error: e });
  const setInput = (v: string) => patch({ input: v });
  const addMsg = (m: ChatMsg, id = sid) => patchSession(id, (s) => ({ msgs: [...s.msgs, m] }));

  const run = session.skill;
  const activeSkill = run?.skill ?? null;
  const stepIdx = run?.stepIdx ?? 0;
  const answers = run?.answers ?? {};
  const stepDraft = run?.stepDraft ?? "";
  const finalPrompt = run?.finalPrompt ?? null;
  const askMode = run?.askMode ?? false;
  const patchRun = (p: Partial<NonNullable<ChatSession["skill"]>>, id = sid) =>
    patchSession(id, (s) => ({ skill: s.skill ? { ...s.skill, ...p } : s.skill }));

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    // stepIdx too: moving to a step (or to its thinking indicator) must scroll it
    // into view, otherwise the card can appear below the fold.
  }, [msgs, busy, stepIdx, finalPrompt, sid]);

  // Check whether the selected provider's key is configured.
  useEffect(() => {
    let alive = true;
    window.mbrush.keyGet(pDef.keyId).then((r) => {
      if (alive) setKeyProbe(!!(r.ok && r.data?.configured));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, chatOpen]);

  // Which mode the next requested prompt is written for. Follows the app's mode until
  // the user aims it somewhere else, then stays where they put it for this tab.
  //
  // These MUST stay above the early return below. They were under it, so opening the
  // panel ran four more hooks than closing it had — React throws and the whole tree
  // unmounts, which is the black screen. tsc cannot see it and no test renders this.
  const [promptModeRaw, setPromptMode] = useState<GenerationMode | null>(null);
  const promptForMode = promptModeRaw ?? mode;
  const [promptModeOpen, setPromptModeOpen] = useState(false);
  const promptModeRef = useRef<HTMLDivElement>(null);
  useDismiss(promptModeRef, () => setPromptModeOpen(false), promptModeOpen);

  if (!chatOpen) {
    return (
      <button className="chat-rail" onClick={toggleChat} title="עוזר הפרומפטים — פתח צ'אט לניסוח פרומפטים">
        עוזר פרומפטים
      </button>
    );
  }

  // The picked provider/model belong to this tab, and also become the defaults a new
  // tab opens with.
  const pickProvider = (p: ChatProvider) => {
    patch({ provider: p, model: providerDef(p).models[0] });
    localStorage.setItem(LS_PROVIDER, p);
  };
  const pickModel = (m: string) => {
    patch({ model: m });
    try {
      const cur = JSON.parse(localStorage.getItem(LS_MODELS) || "{}");
      localStorage.setItem(LS_MODELS, JSON.stringify({ ...cur, [provider]: m }));
    } catch {
      /* the tab still has it */
    }
  };
  const saveKey = async () => {
    const k = keyInput.trim();
    if (!k) return;
    const r = await window.mbrush.keySet(pDef.keyId, k);
    if (r.ok) {
      setKeyProbe(true);
      setKeyInput("");
      setError(null);
    } else setError(r.error ?? "שמירת המפתח נכשלה");
  };

  // ---- One model call -----------------------------------------------------
  /** Every model round-trip in this panel goes through here: marks the session busy,
   *  honours a per-step model override, and writes the result back to `id` even if the
   *  user has since switched tabs. Returns null on failure (the error is on the tab). */
  const callModel = async (
    id: string,
    o: { system: string; history: { role: "user" | "assistant"; text: string }[]; images?: string[]; provider?: ChatProvider; model?: string },
  ): Promise<string | null> => {
    const s = useChat.getState().session(id);
    let p = o.provider ?? s.provider;
    let m = o.model || (o.provider ? providerDef(o.provider).models[0] : s.model);
    // A workflow shared by someone else may pin a provider this user has no key for.
    // Fall back rather than dead-end — but only on a positive signal that the key is
    // missing, never on an empty (not-yet-loaded) list.
    const keys = useStore.getState().configuredKeys;
    if (o.provider && keys.length && !keys.includes(providerDef(p).keyId)) {
      addMsg({ role: "assistant", notice: true, content: `אין מפתח ל-${providerDef(p).label} — השלב רץ על ${s.model}` }, id);
      p = s.provider;
      m = s.model;
    }
    patchSession(id, { busy: true, busySince: Date.now(), error: null });
    const res = await window.mbrush.chatSend({ provider: p, model: m, system: o.system, history: o.history, images: o.images?.length ? o.images : undefined });
    patchSession(id, { busy: false });
    if (!res.ok || !res.data) {
      patchSession(id, { error: res.error ?? "השליחה נכשלה" });
      return null;
    }
    return res.data;
  };

  // ---- Context ("@"): open image / active layer / marked region / refs / upload ----
  // The workflow's steps (a mode step is always guaranteed) and the current one.
  const steps = activeSkill ? skillSteps(activeSkill) : [];
  const step: SkillStep | null = activeSkill && stepIdx < steps.length ? steps[stepIdx] : null;
  /** Images collected BY a skill's images-step were added to build this prompt, so
   *  they default to travelling to the generation box as references. */
  const stepWantsRef = step?.kind === "images" && step.refDefault !== false;

  /** Build both copies: 768 for the chat model, ≤2048 if promoted to a reference.
   *  Tagged with the step that collected it, so a workflow can keep two sets apart. */
  const mkAttachment = async (src: string, label: string, asRef = false): Promise<Attachment> => ({
    src: await makeThumbnail(src, 768),
    full: (await downscaleToMax(src, 2048)).src,
    label,
    asRef,
    ...(step?.kind === "images" ? { stepId: step.id } : {}),
  });

  /** The images a given images-step collected. */
  const imagesOfStep = (list: Attachment[], stepId: string) => list.filter((a) => a.stepId === stepId);
  const pushAttachments = (...atts: Attachment[]) =>
    patch((s) => ({ attachments: [...s.attachments, ...atts] }));

  const addAttachment = async (kind: string) => {
    try {
      setMenu(null);
      // Drop the "@" (or "/") that opened the menu.
      if (input === "@" || input === "/") setInput("");
      if (kind === "upload") return uploadRef.current?.click();
      if (!project) return setError("אין פרויקט פתוח — אפשר להעלות קובץ ישירות");
      const tag = step?.kind === "images" ? { stepId: step.id } : {};
      if (kind === "image") {
        const att = await wholeCanvasImage(project, { full: true });
        pushAttachments({ ...att, asRef: stepWantsRef, ...tag });
      } else if (kind === "layer") {
        const layer = project.layers.find((l) => l.id === activeLayerId);
        if (!layer) return setError("אין שכבה פעילה");
        pushAttachments(await mkAttachment(layer.src, `שכבה: ${layer.name}`, stepWantsRef));
      } else if (kind === "region") {
        const region = await markedRegionImage(project, mask, { full: true });
        if (!region) return setError("אין אזור מסומן");
        pushAttachments({ ...region.image, asRef: stepWantsRef, ...tag });
      } else if (kind === "notes") {
        const marked = await annotatedCanvasImage(project);
        if (!marked) return setError("אין סימוני הסבר על הקנבס");
        pushAttachments({ ...marked, ...tag });
      } else if (kind === "references") {
        if (!references.length) return setError("אין תמונות ייחוס");
        // Already references on the canvas — don't re-add them on apply.
        pushAttachments(...(await Promise.all(references.map((r) => mkAttachment(r.src, `ייחוס: ${roleSpec(r.role).label}`, stepWantsRef)))));
      }
    } catch (e: any) {
      setError(e?.message ?? "צירוף התמונה נכשל");
    }
  };

  /** Direct upload into the chat (files never touch the canvas). An uploaded file
   *  was brought in to build this prompt, so it defaults to being a reference — it
   *  travels to the generation box together with the finished prompt. */
  const onUpload = (files: FileList | null) => {
    if (!files?.length) return;
    const target = sid;
    Array.from(files).forEach((f) => {
      const r = new FileReader();
      r.onload = async () => {
        try {
          const att = await mkAttachment(String(r.result), f.name, true);
          patchSession(target, (s) => ({ attachments: [...s.attachments, att] }));
        } catch (e: any) {
          patchSession(target, { error: e?.message ?? "העלאת התמונה נכשלה" });
        }
      };
      r.readAsDataURL(f);
    });
  };

  /** Images from this conversation that could become generation references.
   *
   *  Read through contextForSend, not from `attachments`: sending moves the staged
   *  images into `carry` and empties `attachments`, so by the time an answer renders the
   *  staged list is always empty — which is why nothing ever reached the reference
   *  shelf. */
  const promotable = contextForSend(attachments, carry).filter((a) => a.full && !a.stale);

  const toggleRef = (i: number) =>
    patch((s) => ({ attachments: s.attachments.map((x, j) => (j === i ? { ...x, asRef: !x.asRef } : x)) }));

  /** The images (and the line describing them) for this turn.
   *
   *  The canvas is where the assistant STARTS, not a fallback for when nothing was
   *  attached — it used to be the latter, so a single attached image blinded it to the
   *  open project, and `carry` then pushed that image forward and kept it blind for the
   *  rest of the conversation. The canvas comes first so the model orients itself before
   *  it looks at anything the user added. */
  const turnContext = async (): Promise<{ images: Attachment[]; note: string; carried: Attachment[] }> => {
    const given = contextForSend(attachments, carry);
    // buildAutoContext already returns nothing when no project is open, so generating
    // from scratch needs no branch of its own.
    const auto = session.autoContext ? await buildAutoContext(project, mask) : null;
    // Automatic images are never carried: they are rebuilt from the live canvas every
    // turn, so a snapshot can't go stale behind the user's back.
    return {
      images: [...(auto?.images ?? []), ...given],
      note: auto ? canvasNote(project, auto.regionBox, given.length) + auto.extraNote : "",
      carried: given,
    };
  };

  /** `forMode` is the generation mode the prompt is being written FOR. It defaults to
   *  the mode the app is in, but the user can aim it elsewhere from the ✍️ button —
   *  asking for a prompt while parked in the wrong mode used to produce a prompt for
   *  that wrong mode, however clearly the conversation had said otherwise. */
  const send = async (text: string, wantPrompt = false, forMode?: GenerationMode) => {
    const content = text.trim();
    if (!content || busy) return;
    const target = sid;
    // The images belong to this turn: what's staged wins, otherwise the previous
    // turn's set carries forward, otherwise the canvas itself. A skill owns its images
    // for the whole workflow, so its pills are left alone until the workflow ends.
    const { images: ctx, note, carried } = await turnContext();
    // Captured before the patch below clears it: a request for a prompt belongs to ONE
    // turn. It used to be sticky, so the first ✍️ press opened the gate for the rest of
    // the tab and the assistant stopped conversing entirely.
    const askedForPrompt = wantPrompt || session.promptRequested;
    const next: ChatMsg[] = [...msgs, { role: "user", content, ctxLabels: ctx.map((a) => a.label) }];
    patch({
      msgs: next,
      input: "",
      carry: carried,
      promptRequested: false,
      ...(activeSkill ? {} : { attachments: [] }),
    });
    const target_mode = forMode ?? mode;
    const context =
      `הקשר נוכחי: מצב=${modeLabel(mode)}, מנוע=${engineId}` +
      (target_mode !== mode
        ? `. הפרומפט הזה נכתב עבור מצב ${modeLabel(target_mode)}, ולא עבור המצב שפתוח כרגע`
        : "") +
      (currentPrompt.trim() ? `, הפרומפט הנוכחי בתיבה: "${currentPrompt.trim()}"` : ", תיבת הפרומפט ריקה") +
      ".\n" +
      (note ? `${note}\n` : "") +
      (MODE_GUIDE[target_mode] ?? "");
    // The gate is decided from the state as it was BEFORE this turn: pressing ✍️ sets
    // promptRequested, and once a prompt has been proposed we're iterating on it.
    const gate = gateDirective(gateOpen(msgs, askedForPrompt));
    const out = await callModel(target, {
      system: SYSTEM_PROMPT + "\n" + context + "\n\n" + gate,
      history: next.map((m) => ({ role: m.role, text: m.sendText ?? m.content })),
      images: ctx.map((a) => a.src),
    });
    if (out != null) {
      addMsg({ role: "assistant", content: out, ...(wantPrompt ? { promptMode: target_mode } : {}) }, target);
    }
  };

  // ---- Skill workflow ----------------------------------------------------
  /** Run an `ai` step: interpolate its instruction, call the model, return the text.
   *  Declared before its callers — a workflow whose FIRST step is an AI stage calls
   *  this synchronously from startSkill. */
  const runAiStep = async (s: SkillStep, acc: Record<string, string>, target: string) => {
    const sess = useChat.getState().session(target);
    // Undefined = every attachment (the long-standing behaviour). A list names the
    // images-steps this stage reads, which is how one workflow holds two sets.
    const pool = s.usesImages
      ? sess.attachments.filter((a) => a.stepId && s.usesImages!.includes(a.stepId))
      : sess.attachments;
    const given = pool.filter((a) => a.src && !a.stale);
    // A workflow that never collected images still gets to see what's on the canvas.
    const auto = given.length || !sess.autoContext ? null : await buildAutoContext(project, mask);
    return callModel(target, {
      // Skill stages must follow their own instruction exactly — the chat system
      // prompt (answer in Hebrew, always fence a prompt) would fight it.
      system: SKILL_SYSTEM,
      history: [
        {
          role: "user",
          text: interpolate(s.instruction ?? "", acc) + (auto?.note ? `\n\n(${auto.note})` : ""),
        },
      ],
      images: (auto ? auto.images : given).map((a) => a.src),
      provider: s.provider,
      model: s.model,
    });
  };

  const startSkill = (skill: PromptSkill) => {
    setMenu(null);
    // Drop the "/" (or "@") that opened the menu.
    if (input === "/" || input === "@") setInput("");
    bumpSkillUsed(skill.id);
    patch((s) => ({
      title: skill.name,
      titleAuto: false,
      planner: null,
      // A workflow is a new task and collects its own images — leftovers from the
      // previous one must not quietly satisfy its images step.
      attachments: [],
      carry: [],
      promptRequested: false,
      msgs: [...s.msgs, { role: "assistant", notice: true, content: `**${skill.name}** — ${skill.description}` } as ChatMsg],
      skill: { skill, stepIdx: 0, answers: {}, stepDraft: "", finalPrompt: null, askMode: false },
    }));
    // A workflow that opens with an AI stage runs it immediately.
    const first = skillSteps(skill)[0];
    if (first?.kind === "ai") {
      const target = sid;
      void (async () => {
        const out = await runAiStep(first, {}, target);
        if (out == null) return;
        const v = extractPrompt(out);
        if (first.final) {
          addMsg({ role: "assistant", content: out }, target);
          patchRun({ finalPrompt: v, stepIdx: skillSteps(skill).length }, target);
        } else {
          patchRun({ answers: { [first.id]: v }, stepDraft: v }, target);
        }
      })();
    }
  };

  /** Pick up the workflow that produced the open project. The run comes out of a file
   *  this session did not write, so it goes through parseSkill before anything runs it —
   *  and it lands finished, on the trail, where stepping back to a question is what
   *  makes a second variant cheap. */
  const resumeSavedRun = () => {
    if (!savedRun) return;
    const { skill, errors } = parseSkill(savedRun.skill);
    if (!skill || errors.length) {
      setError(`רצף הסקיל בפרויקט לא תקין: ${errors[0] ?? "מבנה לא מוכר"}`);
      return;
    }
    patch((s) => ({
      title: skill.name,
      titleAuto: false,
      planner: null,
      promptRequested: true,
      msgs: [
        ...s.msgs,
        {
          role: "assistant",
          notice: true,
          content: `↩ **${skill.name}** — הרצף שנשמר עם הפרויקט נטען. חזור לשלב כדי להוציא גרסה נוספת.`,
        } as ChatMsg,
      ],
      skill: {
        skill,
        stepIdx: skillSteps(skill).length,
        answers: savedRun.answers ?? {},
        stepDraft: "",
        finalPrompt: savedRun.finalPrompt || null,
        askMode: false,
      },
    }));
  };

  const startSkillById = (id: string) => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === id) ?? savedSkills.find((s) => s.id === id);
    if (skill) startSkill(skill);
  };

  // Ending a workflow ends its task: its collected images go with it.
  const cancelSkill = () => patch({ skill: null, attachments: [], carry: [] });

  /** Go back to a step already visited, keeping every answer.
   *
   *  The point is that the expensive stages stay done: re-entering the character step
   *  to try a second character does not re-run the identity analysis before it, because
   *  advance() only re-runs the AI stages that come AFTER the step being answered. The
   *  finished prompt is cleared, since it belonged to the answers as they were. */
  const goToStep = (i: number) => {
    if (!activeSkill || i < 0 || i >= steps.length) return;
    patchRun({
      stepIdx: i,
      stepDraft: answers[steps[i].id] ?? "",
      finalPrompt: null,
      askMode: false,
    });
  };

  /** Advance past the current step with `value` as its answer. */
  const advance = async (value: string) => {
    if (!activeSkill || !step) return;
    const target = sid;
    const acc = { ...answers, [step.id]: value };
    patchRun({ answers: acc, stepDraft: "" }, target);
    // Walk forward, running AI steps as we hit them.
    let i = stepIdx + 1;
    let local = acc;
    while (i < steps.length) {
      const s = steps[i];
      if (s.kind !== "ai") break;
      // Park on the AI step BEFORE running it, so its card (and the elapsed-time
      // indicator inside it) is what's on screen while the model works — otherwise
      // the finished previous step stays up and nothing shows any progress.
      patchRun({ stepIdx: i }, target);
      const out = await runAiStep(s, local, target);
      if (out == null) return; // stay parked on the failed AI step so it can be retried
      if (s.final) {
        addMsg({ role: "assistant", content: out }, target);
        patchRun({ finalPrompt: extractPrompt(out), stepIdx: steps.length }, target);
        return;
      }
      local = { ...local, [s.id]: extractPrompt(out) };
      patchRun({ answers: local }, target);
      if (s.editable) {
        patchRun({ stepDraft: local[s.id], stepIdx: i }, target);
        return; // pause for review
      }
      i++;
    }
    patchRun({ stepIdx: i }, target);
  };

  /** Re-run the AI step we're parked on (after an error or an edit-and-redo). */
  const retryStep = async () => {
    if (!step || step.kind !== "ai") return;
    const target = sid;
    const out = await runAiStep(step, answers, target);
    if (out == null) return;
    if (step.final) {
      addMsg({ role: "assistant", content: out }, target);
      patchRun({ finalPrompt: extractPrompt(out), stepIdx: steps.length }, target);
    } else {
      const v = extractPrompt(out);
      patchRun({ answers: { ...answers, [step.id]: v }, stepDraft: v }, target);
    }
  };

  /** Apply the finished prompt to the generation box: the prompt itself, the images
   *  it was built from (as references), and any framing the skill dictates — then
   *  ask about the generation mode. */
  const applyFinal = async (p: string) => {
    setPrompt(p);
    // Promote the marked images (full-quality copy, not the 768 the model saw).
    const refs = attachments.filter((a) => a.asRef && a.full);
    // Snapshot the ids BEFORE adding, so the diff afterwards is the run's own work.
    const idsBefore = new Set(useStore.getState().references.map((r) => r.id));
    // Awaited: adding resizes the image first, and the id diff below has to see the result.
    // Neutral role — the skill's own prompt is what says how each image is used.
    await Promise.all(refs.map((a) => addReference(a.full, "general")));
    const addedIds = useStore
      .getState()
      .references.filter((r) => !idsBefore.has(r.id))
      .map((r) => r.id);
    // Framing the skill dictates (e.g. a character sheet is a wide landscape).
    const dict = activeSkill?.applySettings;
    if (dict) updateSettings(dict);
    // The moment a workflow's prompt enters the generation box is the moment this
    // project became a product of that workflow — so the run is recorded with it, and
    // survives in the .mbrush file. The reference ids tie it to the images it added.
    if (activeSkill) {
      setSkillRun({
        skill: activeSkill,
        answers,
        finalPrompt: p,
        referenceIds: addedIds,
        savedAt: new Date().toISOString(),
      });
    }
    const bits = ["הפרומפט נכנס לתיבת היצירה"];
    if (refs.length) bits.push(`${refs.length} תמונות ייחוס נוספו`);
    if (dict?.aspectRatio) bits.push(`יחס צלעות ${dict.aspectRatio}`);
    useStore.setState({ status: bits.join(" · ") });
    if (answers.mode) patchRun({ askMode: true });
  };

  const applyMode = () => {
    const m = answers.mode as GenerationMode;
    const switched = pickMode(m);
    patchRun({ askMode: false });
    useStore.setState({
      status: switched
        ? `מצב היצירה הוחל (${modeLabel(m)}) — המנוע הוחלף כדי לתמוך בו`
        : `מצב היצירה הוחל: ${modeLabel(m)}`,
    });
  };

  // ---- Workflow planner ---------------------------------------------------
  const openPlanner = (source?: PromptSkill) => {
    setMenu(null);
    if (input === "/" || input === "@") setInput("");
    // A built-in can't be overwritten, so editing one produces a copy with its own
    // id — otherwise saving would put a second skill with the same id in the menu.
    const builtin = !!source && BUILTIN_SKILLS.some((b) => b.id === source.id);
    const draft: PromptSkill | null = source
      ? {
          ...JSON.parse(JSON.stringify(source)),
          ...(builtin ? { id: `user-${Date.now().toString(36)}`, name: `${source.name} (עותק)` } : {}),
        }
      : null;
    patch({
      skill: null,
      planner: {
        phase: source ? "edit" : "ask",
        desc: "",
        draft,
        errors: [],
        warnings: [],
        sourceId: builtin ? undefined : source?.id,
        refine: "",
      },
    });
  };
  const closePlanner = () => patch({ planner: null });

  /** One planner round-trip: ask the tab's model for JSON, validate it, and — if it
   *  came back malformed — give the same model exactly one chance to repair it. */
  const plannerRound = async (target: string, userText: string, isRepair: boolean) => {
    const out = await callModel(target, { system: PLANNER_SYSTEM, history: [{ role: "user", text: userText }] });
    if (out == null) return;
    const r = parseSkill(extractJson(out));
    const p = useChat.getState().session(target).planner;
    if (r.errors.length && !isRepair && !p?.repaired) {
      patchSession(target, (s) => ({ planner: s.planner ? { ...s.planner, repaired: true } : s.planner }));
      await plannerRound(
        target,
        `The workflow JSON you produced has these problems:\n- ${r.errors.join("\n- ")}\n\n` +
          `Here it is again:\n\`\`\`json\n${extractJson(out)}\n\`\`\`\n` +
          "Return the corrected JSON only, in one fenced json block.",
        true,
      );
      return;
    }
    if (!r.skill) {
      // Not JSON at all, even after the repair round. Opening an empty editor here
      // would silently swallow both the answer and the reason — keep the user on the
      // description card, say why, and put the model's own words in the flow.
      addMsg({ role: "assistant", content: out }, target);
      patchSession(target, (s) => ({
        planner: s.planner ? { ...s.planner, phase: "ask", errors: r.errors, warnings: [] } : s.planner,
      }));
      return;
    }
    patchSession(target, (s) => ({
      planner: s.planner
        ? {
            ...s.planner,
            phase: "edit",
            // Fall back to the user's own words if the model left the name blank, so
            // the description is never simply lost.
            draft: { ...r.skill!, name: r.skill!.name || s.planner.desc.trim().slice(0, 40) },
            errors: r.errors,
            warnings: r.warnings,
          }
        : s.planner,
    }));
  };

  const generateDraft = (desc: string) =>
    void plannerRound(sid, `Design a workflow for this request (answer with JSON only):\n${desc}`, false);

  const refineDraft = (instruction: string) => {
    const draft = session.planner?.draft;
    if (!draft) return;
    void plannerRound(
      sid,
      `Here is an existing workflow:\n\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\`\n\n` +
        `Change it as follows: ${instruction}\nReturn the full updated JSON only.`,
      true, // a revision is already a considered answer — no auto-repair loop on top
    );
  };

  // ---- Export ------------------------------------------------------------
  const exportJson = async (data: unknown, name: string, what: string) => {
    try {
      const path = await saveJson(data, name);
      // A cancelled save dialog is not a failure — say nothing.
      if (path) useStore.setState({ status: `${what} יוצא ל-${path}` });
    } catch (e: any) {
      setError(e?.message ?? "הייצוא נכשל");
    }
  };
  const exportSkill = (skill: PromptSkill) =>
    void exportJson(buildSkillExport(skill), `skill-${skill.name}`, "הסקיל");
  /** The whole tab: the conversation, and the workflow run with every step's answer. */
  const exportSession = () =>
    void exportJson(buildSessionExport(useChat.getState().session(sid)), session.title, "המהלך");

  // Start a fresh conversation in this tab — the assistant sends the full history
  // each turn, so clearing it stops old requests from leaking into new answers.
  const newChat = () => resetSession(sid);


  /** The step trail. A step is reachable once it has been visited — forward jumps are
   *  not offered, because a later stage interpolates answers the earlier ones produce. */
  const StepTrail = ({ current }: { current: number }) => (
    <div className="skill-crumbs">
      {steps.map((s, i) => {
        const done = answers[s.id] !== undefined || i < current;
        const here = i === current;
        const canGo = i <= current && !busy;
        return (
          <button
            key={s.id}
            className={`crumb ${here ? "on" : done ? "done" : ""}`}
            disabled={!canGo}
            title={canGo && !here ? `חזרה ל: ${s.title}` : s.title}
            onClick={() => goToStep(i)}
          >
            {s.title.split(/[—:]/)[0].trim().split(" ").slice(0, 3).join(" ")}
          </button>
        );
      })}
    </div>
  );

  const skillList = [...BUILTIN_SKILLS, ...savedSkills];
  const composerHint = "תאר מה לג'נרט · / לסקילים · @ להקשר";

  return (
    <aside className={`chat-dock ${chatMax ? "is-max" : ""}`} style={chatMax ? undefined : { width: chatWidth }}>
      {/* Dragging the edge is meaningless once the panel owns the whole area. */}
      {!chatMax && <Splitter axis="x" onResize={(d) => setChatWidth(useLayout.getState().chatWidth - d)} />}
      <div className="chat-dock-inner">
        <div className="chat-head">
          <span>עוזר הפרומפטים</span>
          <span className="chat-mode-chip" title="מצב היצירה הנוכחי באפליקציה">{modeLabel(mode)}</span>
          <button className="fc-x" onClick={exportSession} disabled={!msgs.length && !activeSkill} title="ייצא את כל המהלך כ-JSON (שיחה + שלבי הסקיל והתשובות)" aria-label="ייצא את המהלך"><Icon name="export" size={14} /></button>
          <button className="fc-x" onClick={toggleChatMax} title={chatMax ? "החזר לרוחב רגיל" : "הרחב על כל רוחב הקנבס"} aria-label={chatMax ? "החזר לרוחב רגיל" : "הרחב על כל רוחב הקנבס"}><Icon name={chatMax ? "contain" : "expand"} size={14} /></button>
          <button className="fc-x" onClick={newChat} disabled={busy || (msgs.length === 0 && !activeSkill && !session.planner)} title="נקה את הלשונית" aria-label="נקה את הלשונית"><Icon name="rotate-ccw" size={14} /></button>
          <button className="fc-x" onClick={toggleChat} title="סגור">✕</button>
        </div>

        <ChatTabs />

        {!keyOk && !keyDismissed && (
          <div className="chat-keyrow">
            <div className="chat-keynote">
              {provider === "openai"
                ? "לא זוהה מפתח OpenAI — הוא מגיע ממנוע umage2 בהגדרות. אם היצירה עובדת אצלך, אפשר להתעלם ולשלוח."
                : `לא זוהה מפתח ל-${pDef.label} — הדבק אותו כאן (נשמר מוצפן מקומית):`}
              <button className="chat-keyhide" onClick={() => setKeyDismissed(true)} title="הסתר">✕</button>
            </div>
            <div className="chat-keyinput">
              <input type="password" dir="ltr" placeholder="API key…" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
              <button onClick={saveKey} disabled={!keyInput.trim()}>שמור</button>
            </div>
          </div>
        )}

        <div className="chat-list" ref={listRef}>
          {savedRun && !activeSkill && !session.planner && (
            <div className="skill-card resume">
              <div className="skill-card-head">
                <span className="skill-card-title">לפרויקט הזה יש רצף סקיל שמור</span>
              </div>
              <div className="skill-card-hint">
                נשמר {new Date(savedRun.savedAt).toLocaleString("he-IL")}
                {savedRun.referenceIds.length ? ` · ${savedRun.referenceIds.length} תמונות ייחוס` : ""}
              </div>
              <div className="modal-actions">
                <button className="primary" onClick={resumeSavedRun}>המשך את הסקיל</button>
              </div>
            </div>
          )}

          {msgs.length === 0 && !activeSkill && !session.planner && (
            <div className="chat-empty">
              <p>ספר לי מה אתה מנסה להשיג ואנסח לך פרומפט מדויק.</p>
              <p className="chat-empty-hint">הקלד <b>/</b> לסקיל מובנה · <b>@</b> לצירוף הקשר ויזואלי</p>
              {QUICK_STARTS.map((q) => (
                <button key={q} className="chat-chip" onClick={() => send(q)}>{q}</button>
              ))}
            </div>
          )}

          {msgs.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role}`}>
              {!!m.ctxLabels?.length && (
                <div className="chat-ctx-note" title="מה שהמודל ראה בתור הזה">{m.ctxLabels.join(" · ")}</div>
              )}
              {m.role === "assistant" ? (
                <div className="chat-bubble">
                  {splitBlocks(m.content).map((b, j) => {
                    // A proposed prompt gets its own card with its own actions;
                    // everything else is conversation and gets none.
                    const list = asPromptListBlock(b);
                    if (list) return <PromptListCard key={j} block={list} />;
                    const p = asPromptBlock(b);
                    // Only images the USER attached can become references: the automatic
                    // canvas look is built without a `full` copy precisely so it can never
                    // be promoted — it is already on the canvas.
                    if (p) return <PromptCard key={j} block={p} images={promotable} forMode={m.promptMode} />;
                    return b.kind === "code" ? (
                      <pre key={j} className="md-code" dir="ltr">{b.content}</pre>
                    ) : (
                      <Markdown key={j} text={b.content} />
                    );
                  })}
                  {promptBlocks(m.content).length > 0 && (
                    <button className="chat-use shorten" disabled={busy} onClick={() => send(SHORTEN_ASK, true, promptForMode)}>
                      קצר את הפרומפט
                    </button>
                  )}
                </div>
              ) : (
                <div className="chat-bubble">{m.content}</div>
              )}
            </div>
          ))}

          {/* Skill step card — the guided workflow, inline in the flow */}
          {activeSkill && step && (
            <div className="skill-card">
              <div className="skill-card-head">
                <span className="skill-step-num">שלב {stepIdx + 1}/{steps.length}</span>
                <span className="skill-card-title">{step.title}</span>
                <button
                  className="fc-x"
                  title="חזרה לשלב הקודם — התשובות נשמרות"
                  disabled={busy || stepIdx === 0}
                  onClick={() => goToStep(stepIdx - 1)}
                >
                  ←
                </button>
                <button className="fc-x" title="בטל את הסקיל" onClick={cancelSkill}>✕</button>
              </div>
              <StepTrail current={stepIdx} />
              {step.hint && <div className="skill-card-hint">{step.hint}</div>}

              {step.kind === "images" && (() => {
                // Only what THIS step collected: a workflow can hold two sets of
                // images, and the person's photos are not the wardrobe reference.
                const mine = imagesOfStep(attachments, step.id);
                return (
                  <>
                    <div className="skill-card-hint">
                      {mine.length
                        ? `${mine.length} תמונות בשלב הזה: ${mine.map((a) => a.label).join(" · ")}`
                        : step.optional
                        ? "לא צירפת כלום — אפשר לדלג"
                        : "אין תמונות — צרף תמונה או כתוב @"}
                    </div>
                    <div className="modal-actions">
                      <button className="primary" disabled={busy || !mine.length} onClick={() => advance(String(mine.length))}>המשך</button>
                      <button onClick={() => setMenu("context")}>צרף</button>
                      {step.optional && (
                        <button disabled={busy} onClick={() => advance("0")}>דלג</button>
                      )}
                    </div>
                  </>
                );
              })()}

              {step.kind === "text" && (
                <>
                  <textarea className="prompt-input" style={{ minHeight: 70 }} value={stepDraft} placeholder={step.hint} onChange={(e) => patchRun({ stepDraft: e.target.value })} />
                  <div className="modal-actions">
                    <button className="primary" disabled={busy || !stepDraft.trim()} onClick={() => advance(stepDraft)}>המשך</button>
                  </div>
                </>
              )}

              {step.kind === "choice" && (
                <div className="skill-choices">
                  {(step.options ?? []).map((o) => (
                    <button key={o} className="chat-chip" disabled={busy} onClick={() => advance(o)}>{o}</button>
                  ))}
                </div>
              )}

              {step.kind === "mode" && (
                <div className="skill-choices">
                  {SKILL_MODES.map((m) => (
                    <button key={m} className="chat-chip" disabled={busy} onClick={() => advance(m)}>{modeLabel(m)}</button>
                  ))}
                </div>
              )}

              {step.kind === "ai" && (
                <>
                  {busy ? (
                    <Thinking since={busySince} label="המודל מנתח ומעבד" />
                  ) : (
                    <>
                      <textarea className="prompt-input" style={{ minHeight: 120 }} value={stepDraft} onChange={(e) => patchRun({ stepDraft: e.target.value })} />
                      <div className="modal-actions">
                        <button className="primary" disabled={!stepDraft.trim()} onClick={() => advance(stepDraft)}>אשר והמשך</button>
                        <button onClick={retryStep}>הרץ שוב</button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* Finished prompt */}
          {activeSkill && finalPrompt && (
            <div className="skill-card done">
              <div className="skill-card-head">
                <span className="skill-card-title">הפרומפט מוכן</span>
                <button className="fc-x" title="סיים" onClick={cancelSkill}>✕</button>
              </div>
              <StepTrail current={steps.length - 1} />
              <pre className="md-code is-prompt" dir="ltr">{finalPrompt}</pre>
              {(() => {
                const refs = attachments.filter((a) => a.asRef && a.full).length;
                const ar = activeSkill?.applySettings?.aspectRatio;
                if (!refs && !ar) return null;
                return (
                  <div className="skill-card-hint">
                    יוחל גם: {[refs ? `${refs} תמונות ייחוס` : null, ar ? `יחס צלעות ${ar}` : null].filter(Boolean).join(" · ")}
                  </div>
                );
              })()}
              <div className="modal-actions">
                <button className="primary" onClick={() => applyFinal(finalPrompt)}>השתמש בפרומפט</button>
                <button onClick={() => { navigator.clipboard.writeText(finalPrompt).catch(() => {}); useStore.setState({ status: "הפרומפט הועתק ללוח." }); }}>העתק</button>
                <button onClick={() => togglePromptInLibrary(finalPrompt)}>לספרייה</button>
                <button onClick={exportSession} title="הסקיל, כל השלבים והתשובות שהתקבלו">ייצא מהלך</button>
                {(() => {
                  // Back to the last thing YOU answered — the AI stages before it keep
                  // their results, so a second variant costs only the stages after it.
                  const back = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.kind !== "ai" && s.kind !== "mode").pop();
                  if (!back) return null;
                  return (
                    <button
                      disabled={busy}
                      title={`חזרה ל"${back.s.title}" בלי להריץ מחדש את השלבים שלפניו`}
                      onClick={() => goToStep(back.i)}
                    >
                      גרסה נוספת
                    </button>
                  );
                })()}
              </div>
              {askMode && (
                <div className="skill-mode-ask">
                  <span>להחיל גם את מצב היצירה <b>{modeLabel(answers.mode as GenerationMode)}</b>?</span>
                  <button className="primary" onClick={applyMode}>החל</button>
                  <button onClick={() => patchRun({ askMode: false })}>דלג</button>
                </div>
              )}
            </div>
          )}

          {session.planner && (
            <WorkflowPlanner
              sessionId={sid}
              busy={busy}
              onGenerate={generateDraft}
              onRefine={refineDraft}
              onRun={(skill) => startSkill(skill)}
              onClose={closePlanner}
            />
          )}

          {/* Fallback indicator: any wait that the step card isn't already showing
              one for (a normal chat turn, a planner draft, or a skill between cards). */}
          {busy && step?.kind !== "ai" && (
            <div className="chat-msg assistant">
              <div className="chat-bubble">
                <Thinking since={busySince} label={session.planner ? "בונה את הוורקפלו" : activeSkill ? "המודל מנתח ומעבד" : "מנסח"} />
              </div>
            </div>
          )}
          {error && <div className="chat-error">שגיאה: {error}</div>}
        </div>

        {/* ---- Composer: context pills · textarea · chips + actions ---- */}
        <div className={`composer ${chatDrop.dragging ? "drop-armed" : ""}`} ref={composerRef} {...chatDrop.handlers}>
          {/* The context that carried over from the last turn — invisible state made
              visible, and revocable in one click. */}
          {attachments.length === 0 && carry.length > 0 && !activeSkill && (
            <div className="ctx-carry">
              <span>ממשיך עם {carry.length === 1 ? "תמונה אחת" : `${carry.length} תמונות`} מההודעה הקודמת</span>
              <button title="שכח את התמונות" onClick={() => patch({ carry: [] })}>✕</button>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="ctx-pills">
              {attachments.map((a, i) => (
                <div key={i} className={`ctx-pill ${a.asRef ? "is-ref" : ""} ${a.stale ? "is-stale" : ""}`} title={a.stale ? `${a.label} — התמונה לא נשמרה בין הפעלות, צרף מחדש` : a.label}>
                  {a.src ? <img src={a.src} alt="" /> : <div className="ctx-pill-load" />}
                  <span className="ctx-pill-label">{a.label}</span>
                  {a.stepId && activeSkill && (
                    <span className="ctx-pill-step" title="השלב שאסף את התמונה הזאת">
                      {skillSteps(activeSkill).find((x) => x.id === a.stepId)?.title.split(" ").slice(0, 2).join(" ") ?? a.stepId}
                    </span>
                  )}
                  {!a.stale && (
                    <button
                      className={`ctx-ref ${a.asRef ? "on" : ""}`}
                      title="השתמש כתמונת ייחוס בפרומפט הסופי"
                      onClick={() => toggleRef(i)}
                    >
                      ייחוס
                    </button>
                  )}
                  <button className="ctx-x" title="הסר" onClick={() => patch((s) => ({ attachments: s.attachments.filter((_, j) => j !== i) }))}>✕</button>
                </div>
              ))}
            </div>
          )}

          {menu === "skills" && (
            <div className="composer-menu">
              <div className="composer-menu-head">סקילים</div>
              <button className="composer-menu-new" onClick={() => openPlanner()}>
                <b>בנה workflow חדש</b>
                <small>תאר מה הוא צריך לעשות — המודל של הלשונית ינסח, ואתה תערוך</small>
              </button>
              {skillList.map((s) => (
                <div className="composer-menu-row" key={s.id}>
                  <button onClick={() => startSkillById(s.id)}>
                    <b>{s.name}</b>
                    <small>{s.description}</small>
                  </button>
                  <button className="fc-x" title="ערוך עותק" aria-label="ערוך עותק" onClick={() => openPlanner(s)}><Icon name="pencil" size={14} /></button>
                  <button className="fc-x" title="ייצא כ-JSON" aria-label="ייצא כ-JSON" onClick={() => exportSkill(s)}><Icon name="export" size={14} /></button>
                  {savedSkills.some((x) => x.id === s.id) && (
                    <button className="fc-x" title="מחק" aria-label="מחק" onClick={() => removeSavedSkill(s.id)}><Icon name="trash" size={14} /></button>
                  )}
                </div>
              ))}
            </div>
          )}
          {menu === "context" && (
            <div className="composer-menu">
              <div className="composer-menu-head">@ הקשר ויזואלי</div>
              <button disabled={!project} onClick={() => addAttachment("image")}><b>התמונה הפתוחה</b></button>
              <button disabled={!project || !activeLayerId} onClick={() => addAttachment("layer")}><b>השכבה הפעילה</b></button>
              <button disabled={!project || !maskHasContent(mask)} onClick={() => addAttachment("region")}><b>האזור המסומן</b></button>
              <button disabled={!project?.annotations?.items.length} onClick={() => addAttachment("notes")}><b>הקנבס עם הסימונים{project?.annotations?.items.length ? ` (${project.annotations.items.length})` : ""}</b></button>
              <button disabled={!references.length} onClick={() => addAttachment("references")}><b>תמונות הייחוס{references.length ? ` (${references.length})` : ""}</b></button>
              <button onClick={() => addAttachment("upload")}><b>העלה תמונה…</b></button>
            </div>
          )}

          <textarea
            className="composer-input"
            value={input}
            placeholder={composerHint}
            rows={2}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              if (v === "/") setMenu("skills");
              else if (v === "@") setMenu("context");
              else if (menu && !v.startsWith("/") && !v.startsWith("@")) setMenu(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && menu) { e.preventDefault(); setMenu(null); return; }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (menu) return;
                send(input);
              }
            }}
          />

          <div className="composer-bar">
            {project && (
              <button
                className={`composer-chip eye ${session.autoContext ? "on" : ""}`}
                title={
                  session.autoContext
                    ? "העוזר מסתכל על הקנבס בעצמו כשלא צירפת תמונות. לחץ כדי לכבות."
                    : "העוזר לא מסתכל על הקנבס. לחץ כדי להדליק."
                }
                onClick={() => patch({ autoContext: !session.autoContext })}
              >
                <Icon name={session.autoContext ? "eye" : "eye-off"} size={14} />
                {session.autoContext ? (maskHasContent(mask) ? "קנבס + אזור מסומן" : "קנבס") : "לא מסתכל"}
              </button>
            )}
            <button className={`composer-chip ${activeSkill ? "on" : ""}`} title="סקילים (/)" onClick={() => setMenu(menu === "skills" ? null : "skills")}>
              {activeSkill ? activeSkill.name : "סקיל"} <span className="caret-down"><Icon name="chevron" size={12} /></span>
            </button>
            <select className="composer-chip" value={provider} onChange={(e) => pickProvider(e.target.value as ChatProvider)} title="ספק">
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <input
              className="composer-chip composer-model"
              list={`chat-models-${provider}`}
              value={model}
              onChange={(e) => pickModel(e.target.value)}
              title="מודל"
              dir="ltr"
            />
            <datalist id={`chat-models-${provider}`}>
              {pDef.models.map((m) => <option key={m} value={m} />)}
            </datalist>
            <span className="composer-spacer" />
            {/* The gate: until this is pressed the assistant discusses, it doesn't
                deliver a prompt. Once one has been proposed it stays open. */}
            <div className="ask-prompt-wrap" ref={promptModeRef}>
              <button
                className="composer-chip ask-prompt"
                title={`בקש מהעוזר לנסח פרומפט עבור מצב ${modeLabel(promptForMode)}`}
                disabled={busy}
                onClick={() => send(input.trim() || "נסח לי עכשיו את הפרומפט לפי מה שסיכמנו.", true, promptForMode)}
              >
                נסח פרומפט
                {promptForMode !== mode && <b className="ask-prompt-mode"> · {modeLabel(promptForMode)}</b>}
              </button>
              {/* Which mode the prompt is written for. Defaults to the open mode; being
                  parked in the wrong one is exactly how a rebuild request came back as a
                  sharpening instruction. */}
              <button
                className="composer-chip ask-prompt-caret"
                title="לאיזה מצב לנסח את הפרומפט"
                disabled={busy}
                onClick={() => setPromptModeOpen((v) => !v)}
              >
                <span className="caret-down"><Icon name="chevron" size={12} /></span>
              </button>
              {promptModeOpen && (
                <div className="ask-prompt-menu" onClick={() => setPromptModeOpen(false)}>
                  <div className="ask-prompt-menu-head">נסח פרומפט עבור</div>
                  {DOCK_MODES.map((m) => (
                    <button
                      key={m}
                      className={m === promptForMode ? "on" : ""}
                      onClick={() => setPromptMode(m)}
                    >
                      {modeLabel(m)}
                      {m === mode && <small>המצב הפתוח</small>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="composer-icon" title="צרף הקשר (@)" onClick={() => setMenu(menu === "context" ? null : "context")}>צרף</button>
            <button className="composer-send" onClick={() => send(input)} disabled={busy || !input.trim()}>שלח</button>
          </div>
          <input ref={uploadRef} type="file" accept="image/*" multiple hidden onChange={(e) => { onUpload(e.target.files); e.target.value = ""; }} />
        </div>

        <div className="chat-foot">משתמש במפתח {pDef.label} שלך · עלות זניחה</div>
      </div>
    </aside>
  );
}
