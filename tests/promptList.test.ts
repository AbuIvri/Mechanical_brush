import { describe, it, expect } from "vitest";
import { parsePromptList, promptTitle } from "../src/promptList";

describe("prompt lists", () => {
  it("blank lines separate prompts, and a prompt may run over several lines", () => {
    const { items } = parsePromptList("A red sneaker\non wet asphalt\n\nA blue one\n\n\nA green one");
    expect(items.map((i) => i.prompt)).toEqual(["A red sneaker on wet asphalt", "A blue one", "A green one"]);
    expect(items.map((i) => i.line)).toEqual([1, 4, 7]);
  });

  it("with no blank lines at all, every line is a prompt — a pasted list just works", () => {
    const { items } = parsePromptList("one\ntwo\nthree\n");
    expect(items.map((i) => i.prompt)).toEqual(["one", "two", "three"]);
  });

  it("blank lines only at the ends do not turn a line list into one prompt", () => {
    const { items } = parsePromptList("\n\none\ntwo\n\n");
    expect(items.map((i) => i.prompt)).toEqual(["one", "two"]);
  });

  it("reads [aspect] and @file at the start, and leaves them alone later on", () => {
    const { items } = parsePromptList("[16:9] @logo.png @shoe.JPG A billboard [old style] with @mentions");
    expect(items[0]).toEqual({ prompt: "A billboard [old style] with @mentions", aspect: "16:9", refs: ["logo.png", "shoe.JPG"], line: 1 });
  });

  it("skips // notes", () => {
    const { items } = parsePromptList("// campaign A\none\n// two is out\nthree");
    expect(items.map((i) => i.prompt)).toEqual(["one", "three"]);
  });

  it("reads Hebrew as it reads English", () => {
    const { items } = parsePromptList("[3:4] נעל אדומה על אספלט רטוב\n\nנעל כחולה");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ prompt: "נעל אדומה על אספלט רטוב", aspect: "3:4" });
  });

  it("a line with tags and no prompt is a warning, not an empty run", () => {
    const { items, warnings } = parsePromptList("[16:9]\n\na real prompt");
    expect(items.map((i) => i.prompt)).toEqual(["a real prompt"]);
    expect(warnings[0]).toMatch(/שורה 1/);
  });

  it("says when a bracket at the start is not a tag it knows", () => {
    const { items, warnings } = parsePromptList("[wide] a beach");
    expect(items[0].prompt).toBe("[wide] a beach");
    expect(warnings[0]).toMatch(/\[wide\] לא מוכר/);
  });

  it("reads Windows line endings", () => {
    expect(parsePromptList("one\r\n\r\ntwo\r\n").items.map((i) => i.prompt)).toEqual(["one", "two"]);
  });

  it("in a document with real prompts, short lines are headings — and name the prompt below", () => {
    const long = (w: string) => `${w} ${"word ".repeat(30)}`.trim();
    const doc = ["שיעור 02 — פרומפטים", "א׳ — משמעות חזותית", "01  |  אותו חפץ, שתי קריאות", long("Create A"), "02 | פירוק", long("Create B"), "ב׳ — יסודות", long("Create C")].join("\n\n");
    const { items, headings } = parsePromptList(doc);
    expect(items.map((i) => i.prompt.split(" ")[1])).toEqual(["A", "B", "C"]);
    expect(items.map((i) => i.title)).toEqual(["01 · אותו חפץ, שתי קריאות", "02 · פירוק", "ב׳ — יסודות"]);
    expect(headings).toHaveLength(5);
  });

  it("a description line under the title is a note: skipped, and names nothing", () => {
    const long = (w: string) => `${w} ${"word ".repeat(80)}`.trim();
    const note = "24 פרומפטים מהגרסה הראשונה • לצילומים מדומים ולהדגמות השוואתיות. רצוי לא להשתמש בהדמיות ככלי להוכחת תופעות אופטיות.";
    const { items, headings } = parsePromptList(["שיעור 02", note, long("Create A"), "01 | name", long("Create B")].join("\n\n"));
    expect(items).toHaveLength(2);
    expect(headings).toContain(note);
    // The title above the note does not leak past it onto the first prompt.
    expect(items[0].title).toBeUndefined();
    expect(items[1].title).toBe("01 · name");
  });

  it("in a list of mid-length prompts, a mid-length prompt still runs", () => {
    const p = (n: number) => "word ".repeat(n).trim();
    const { items } = parsePromptList([p(30), p(18), p(40)].join("\n\n"));
    expect(items).toHaveLength(3);
  });

  it("a list of short prompts stays a list of prompts", () => {
    const { items, headings } = parsePromptList("a cat\na dog\na red fox in snow");
    expect(items).toHaveLength(3);
    expect(headings).toHaveLength(0);
  });

  it("a short line with a tag always runs, even among long prompts", () => {
    const { items } = parsePromptList(`[1:1] a cat\n\n${"word ".repeat(30)}`);
    expect(items[0].prompt).toBe("a cat");
  });

  it("takes a known aspect from the prompt's own words — and not a ratio of light", () => {
    const a = parsePromptList("Clean comparison, restrained colors, 16:9.").items[0];
    expect(a).toMatchObject({ aspect: "16:9", aspectFromText: true });
    const light = parsePromptList("illuminance 4:1:0.25 at 0.5 m, 1 m and 2 m, 10:30 am").items[0];
    expect(light.aspect).toBeUndefined();
    // A tag wins over the text.
    expect(parsePromptList("[1:1] a poster, 16:9").items[0]).toMatchObject({ aspect: "1:1" });
  });

  it("names a tab after the first words of its prompt", () => {
    expect(promptTitle("A red sneaker")).toBe("A red sneaker");
    expect(promptTitle("A red sneaker on wet asphalt under the night city lights")).toBe("A red sneaker on wet asphalt…");
  });
});
