import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { unzipEntry, documentXmlToParagraphs, docxToText } from "../electron/ipc/docx";

/** A minimal zip, the way Word writes one: deflated entries and a central directory. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(content, "utf8"));
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const XML =
  '<w:document><w:body>' +
  '<w:p><w:r><w:t>שיעור 02</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t xml:space="preserve">01 </w:t></w:r><w:r><w:tab/><w:t>| name</w:t></w:r></w:p>' +
  '<w:p></w:p>' +
  '<w:p><w:r><w:t>Light &amp; shadow, &quot;16:9&quot;</w:t></w:r><w:r><w:br/><w:t>next line</w:t></w:r></w:p>' +
  '</w:body></w:document>';

describe("reading a Word document", () => {
  it("finds a file inside the zip", () => {
    const z = zip({ "[Content_Types].xml": "<x/>", "word/document.xml": XML });
    expect(unzipEntry(z, "word/document.xml")?.toString("utf8")).toBe(XML);
    expect(unzipEntry(z, "missing.xml")).toBeNull();
  });

  it("gives each paragraph's text, in order, empty ones dropped, tabs and breaks as spaces", () => {
    expect(documentXmlToParagraphs(XML)).toEqual(["שיעור 02", "01 | name", 'Light & shadow, "16:9" next line']);
  });

  it("lays the paragraphs out the way a prompt list reads them: blank line between", () => {
    expect(docxToText(zip({ "word/document.xml": XML }))).toBe('שיעור 02\n\n01 | name\n\nLight & shadow, "16:9" next line');
  });

  it("says so when the file is not a Word document", () => {
    expect(() => docxToText(Buffer.from("not a zip at all, just text"))).toThrow(/Word/);
  });
});
