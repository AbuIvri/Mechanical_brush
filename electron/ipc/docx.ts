// The text of a Word document, for a prompt list.
//
// A .docx is a zip with the body in word/document.xml. Reading it needs a zip reader and
// a pass over the XML — both small enough to do with Node's own zlib, so the app gains no
// dependency for it. Only what a prompt list needs: paragraph text, in order. Formatting,
// tables-as-tables, images and comments are not read.

import { inflateRawSync } from "node:zlib";

/** One file out of a zip archive, by name. Reads the central directory, so it works on
 *  archives written with data descriptors (sizes after the data), as Word's are. */
export function unzipEntry(zip: Buffer, name: string): Buffer | null {
  // End of central directory: the last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("הקובץ אינו מסמך Word תקין");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (entry === name) {
      const lNameLen = zip.readUInt16LE(local + 26);
      const lExtraLen = zip.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(start, start + size);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error("מסמך Word בדחיסה שאינה נתמכת");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()],
  );
}

/** word/document.xml → its paragraphs' text, in order, empty ones dropped. A tab or line
 *  break inside a paragraph is a space: a prompt is one line of thought. */
export function documentXmlToParagraphs(xml: string): string[] {
  const out: string[] = [];
  for (const para of xml.split(/<\/w:p>/)) {
    let text = "";
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:tab|br|cr)\b[^>]*\/>/g;
    for (let m; (m = re.exec(para)); ) text += m[1] !== undefined ? decode(m[1]) : " ";
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) out.push(clean);
  }
  return out;
}

/** A .docx as a prompt list's text: one paragraph per block, a blank line between — the
 *  shape the list format reads as "one prompt per paragraph". */
export function docxToText(file: Buffer): string {
  const xml = unzipEntry(file, "word/document.xml");
  if (!xml) throw new Error("לא נמצא תוכן במסמך ה-Word");
  return documentXmlToParagraphs(xml.toString("utf8")).join("\n\n");
}
