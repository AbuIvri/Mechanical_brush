// A list of prompts, as a person would write it in a text file — or a Word document.
//
// Prompts are separated by a blank line, so one prompt may run over several lines. A text
// with no blank lines at all is one prompt per line — a pasted list just works. At the
// start of a prompt, optionally: [16:9] for its aspect and @file.png for a reference image
// looked up next to the text file. Lines starting with // are notes.
//
// Real documents also carry headings — a title, chapter names, "01 | name" above each
// prompt. In a list that has real prompts in it, a short line is a heading, not a prompt
// (each one would otherwise be a paid run): it is skipped, and when it sits right above a
// prompt it names that prompt's tab. A prompt that names a known aspect ratio in its own
// words ("…, 16:9.") gets that aspect.
//
// Pure: no DOM, no store.

export interface PromptListItem {
  prompt: string;
  /** The heading right above it in the document, when there was one — its tab's name. */
  title?: string;
  /** The aspect came from the prompt's own words rather than a [tag]. */
  aspectFromText?: boolean;
  /** "16:9" etc., when the prompt set its own. */
  aspect?: string;
  /** File names of references for this prompt alone. */
  refs: string[];
  /** 1-based line in the text where it starts — for messages that point somewhere. */
  line: number;
}

const ASPECT_TAG = /^\[(\d{1,2}:\d{1,2})\]$/;
const REF_TAG = /^@(\S+\.(?:png|jpe?g|webp|gif|bmp))$/i;

/** Pull the leading [aspect] and @file tags off a prompt. Only at the start: "@" or "[ ]"
 *  later in the sentence are the prompt's own words. */
function splitTags(text: string): { aspect?: string; refs: string[]; rest: string; unknown: string[] } {
  const words = text.split(/(\s+)/);
  let aspect: string | undefined;
  const refs: string[] = [];
  const unknown: string[] = [];
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (!w || /^\s+$/.test(w)) continue;
    const a = ASPECT_TAG.exec(w);
    if (a) {
      aspect = a[1];
      continue;
    }
    const r = REF_TAG.exec(w);
    if (r) {
      refs.push(r[1]);
      continue;
    }
    // A bracketed word that looks like a tag but is not one is worth mentioning.
    if (/^\[[^\]]*\]$/.test(w)) unknown.push(w);
    break;
  }
  return { aspect, refs, unknown, rest: words.slice(i).join("").trim() };
}

/** Long enough to be a prompt, short enough to be a heading — in words. */
const PROMPT_WORDS = 25;
const HEADING_WORDS = 12;
/** Aspects a prompt may name in its own words. A fixed set, so "4:1:0.25" (a ratio of
 *  light, in a lighting lesson) or "10:30" is never read as a frame. */
const TEXT_ASPECT = /(?<![\d:.])(1:1|16:9|9:16|4:3|3:4|3:2|2:3|21:9|4:5|5:4)(?![\d:])/g;

/** "01  |  name" → "01 · name". */
function cleanTitle(t: string): string {
  return t.replace(/\s*\|\s*/g, " · ").replace(/\s+/g, " ").trim();
}

export function parsePromptList(text: string): { items: PromptListItem[]; warnings: string[]; headings: string[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept = lines.map((l, i) => ({ text: l, n: i + 1 })).filter((l) => !/^\s*\/\//.test(l.text));
  const hasBlank = kept.some((l, i) => !l.text.trim() && i > 0 && i < kept.length - 1 && kept.slice(0, i).some((x) => x.text.trim()) && kept.slice(i).some((x) => x.text.trim()));

  // Group into raw prompts with the line they start on.
  const raw: { text: string; line: number }[] = [];
  if (hasBlank) {
    let cur: { parts: string[]; line: number } | null = null;
    for (const l of kept) {
      if (!l.text.trim()) {
        if (cur) raw.push({ text: cur.parts.join(" "), line: cur.line });
        cur = null;
      } else if (cur) cur.parts.push(l.text.trim());
      else cur = { parts: [l.text.trim()], line: l.n };
    }
    if (cur) raw.push({ text: cur.parts.join(" "), line: cur.line });
  } else {
    for (const l of kept) if (l.text.trim()) raw.push({ text: l.text.trim(), line: l.n });
  }

  const items: PromptListItem[] = [];
  const warnings: string[] = [];
  const headings: string[] = [];
  const parsed = raw.map((r) => ({ r, t: splitTags(r.text.replace(/\s+/g, " ")) }));
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  // Only a list that has real prompts in it has headings. A list of short prompts ("a cat",
  // "a dog") is exactly that, and every line of it runs.
  const longs = parsed.map(({ t }) => words(t.rest)).filter((n) => n >= PROMPT_WORDS).sort((a, b) => a - b);
  const hasLong = longs.length > 0;
  // What "much shorter than the prompts here" means for THIS document: 40% of its typical
  // prompt. A lesson whose prompts run ~80 words has a one-sentence description under its
  // title — 17 words, too long for a heading and nothing like a prompt.
  const cutoff = hasLong ? Math.max(HEADING_WORDS + 1, Math.round(0.4 * longs[Math.floor(longs.length / 2)])) : 0;
  let pendingTitle: string | undefined;
  for (const { r, t } of parsed) {
    if (t.unknown.length) warnings.push(`שורה ${r.line}: ${t.unknown.join(" ")} לא מוכר — אפשר [16:9] לפורמט ו-@קובץ לייחוס.`);
    if (!t.rest) {
      warnings.push(`שורה ${r.line}: יש תגיות בלי פרומפט — דילגתי עליה.`);
      continue;
    }
    // A tagged line is always meant to run, however short.
    const n = words(t.rest);
    if (hasLong && !t.aspect && !t.refs.length && n < cutoff) {
      headings.push(t.rest);
      // A short line names the prompt below it; a longer one is a note, and names nothing.
      pendingTitle = n <= HEADING_WORDS ? cleanTitle(t.rest) : undefined;
      continue;
    }
    let aspect = t.aspect;
    let aspectFromText = false;
    if (!aspect) {
      const named = [...t.rest.matchAll(TEXT_ASPECT)];
      if (named.length) {
        aspect = named[named.length - 1][1];
        aspectFromText = true;
      }
    }
    items.push({
      prompt: t.rest,
      ...(pendingTitle ? { title: pendingTitle } : {}),
      ...(aspect ? { aspect } : {}),
      ...(aspectFromText ? { aspectFromText } : {}),
      refs: t.refs,
      line: r.line,
    });
    pendingTitle = undefined;
  }
  return { items, warnings, headings };
}

/** A tab's name for a prompt: its first words, short enough for a tab. */
export function promptTitle(prompt: string, max = 32): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 12 ? cut.slice(0, sp) : cut).trim()}…`;
}
