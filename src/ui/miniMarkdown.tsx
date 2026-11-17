import { Fragment, type ReactNode } from "react";

// Minimal markdown for assistant messages — headings, bold, inline code, fenced
// blocks and bullet/numbered lists. Deliberately dependency-free: this is a
// local-first app and a full markdown library isn't worth the weight here.

/** Inline: **bold**, `code`. Everything else stays literal text. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null) out.push(<b key={`${keyBase}-b${i}`}>{m[2]}</b>);
    else out.push(<code key={`${keyBase}-c${i}`}>{m[3]}</code>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export interface MdBlock {
  kind: "text" | "code";
  /** For code blocks: the fence's language tag ("prompt" for a skill's answer). */
  lang?: string;
  content: string;
}

/** Split a message into text and fenced-code blocks (so callers can render a
 *  ```prompt block as its own card with actions). */
export function splitBlocks(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  // The tag allows "-" (```prompt-en): with \w+ the fence simply didn't match and
  // the whole block vanished from the output.
  const re = /```([\w-]+)?[ \t]*\r?\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) blocks.push({ kind: "text", content: src.slice(last, m.index) });
    blocks.push({ kind: "code", lang: m[1], content: m[2].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < src.length) blocks.push({ kind: "text", content: src.slice(last) });
  return blocks;
}

/** Render one text block: headings, lists, paragraphs. */
export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = (key: string) => {
    if (!list) return;
    const L = list;
    out.push(
      L.ordered ? (
        <ol key={key}>{L.items.map((it, i) => <li key={i}>{inline(it, `${key}-${i}`)}</li>)}</ol>
      ) : (
        <ul key={key}>{L.items.map((it, i) => <li key={i}>{inline(it, `${key}-${i}`)}</li>)}</ul>
      ),
    );
    list = null;
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flushList(`l${i}`);
      const level = Math.min(4, h[1].length);
      const Tag = (["h4", "h4", "h5", "h6"][level - 1] ?? "h5") as "h4" | "h5" | "h6";
      out.push(<Tag key={`h${i}`}>{inline(h[2], `h${i}`)}</Tag>);
    } else if (ul || ol) {
      const item = (ul ? ul[1] : ol![1]);
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flushList(`l${i}`);
        list = { ordered, items: [] };
      }
      list.items.push(item);
    } else if (!line.trim()) {
      flushList(`l${i}`);
    } else {
      flushList(`l${i}`);
      out.push(<p key={`p${i}`}>{inline(line, `p${i}`)}</p>);
    }
  });
  flushList("l-end");

  return <div className="md">{out.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</div>;
}
