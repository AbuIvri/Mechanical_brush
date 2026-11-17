import { describe, it, expect } from "vitest";
import { castGaps, castToAnswers, parseCast } from "../src/series/cast";

const person = {
  name: "דקלה שופן",
  folder: "דקלה שופן תמונות",
  trailer: 1,
  character: {
    role: "וונדר וומן", film: "וונדר וומן", why: "מנהיגה ממגנטת שנלחמת למען הצוות",
    wardrobe: "שריון קרב בשחור ולבן", accessories: ["ג'ינס"], style: "שחור/לבן, שיק",
    pose: "עמידה איתנה", mood: "מגניבה", render: "pixar",
  },
  avoid: ["מוצרי חלב"],
  missing: [],
  context: "מנהיגה שנלחמת למען הצוות שלה.",
};

describe("parseCast", () => {
  it("accepts a well-formed cast file", () => {
    const { cast, errors } = parseCast({ project: "חוגגים עשור", brief: "טריילרים", people: [person] });
    expect(errors).toEqual([]);
    expect(cast!.people[0].character.render).toBe("pixar");
    expect(cast!.people[0].character.accessories).toEqual(["ג'ינס"]);
  });

  it("accepts a bare array of people too", () => {
    expect(parseCast([person]).errors).toEqual([]);
  });

  it("names the person in the error, not the array index", () => {
    // In a run of 34 people, "רשומה 17 שגויה" is useless.
    const broken = { ...person, character: { ...person.character, role: "" }, context: "" };
    const { errors } = parseCast({ people: [broken] });
    expect(errors.some((e) => e.startsWith("דקלה שופן:"))).toBe(true);
    expect(errors.some((e) => e.includes("תפקיד"))).toBe(true);
    expect(errors.some((e) => e.includes("הקשר"))).toBe(true);
  });

  it("falls back to photoreal for an unknown render style, and says so", () => {
    const { cast, warnings } = parseCast({ people: [{ ...person, character: { ...person.character, render: "anime" } }] });
    expect(cast!.people[0].character.render).toBe("photoreal");
    expect(warnings.join()).toContain("anime");
  });

  it("flags a person who is not in the dataset", () => {
    const { warnings } = parseCast({ people: [person] }, ["מיכל ששון"]);
    expect(warnings.join()).toContain("דקלה שופן");
  });

  it("rejects duplicates and unparseable JSON", () => {
    expect(parseCast({ people: [person, person] }).errors.join()).toContain("פעמיים");
    expect(parseCast("{ nope").cast).toBeNull();
  });

  it("keeps the good entries even when one is broken", () => {
    const { cast, errors } = parseCast({ people: [person, { name: "" }] });
    expect(errors).toHaveLength(1);
    expect(cast!.people.map((p) => p.name)).toEqual(["דקלה שופן"]);
  });
});

describe("castGaps", () => {
  it("lists only the people whose brief is incomplete", () => {
    const { cast } = parseCast({
      people: [person, { ...person, name: "בוריס שווידלר", missing: ["אין רעיון טריילר"] }],
    });
    expect(castGaps(cast!)).toEqual([{ name: "בוריס שווידלר", missing: ["אין רעיון טריילר"] }]);
  });
});

describe("castToAnswers", () => {
  it("folds the character into the workflow's context answer", () => {
    const { cast } = parseCast({ people: [person] });
    const a = castToAnswers(cast!.people[0]);
    expect(a.context).toContain("מנהיגה שנלחמת");
    expect(a.context).toContain("לבוש: שריון קרב");
    expect(a.context).toContain("אביזרים: ג'ינס");
    // The red lines from the sheet travel with the character, not beside it.
    expect(a.context).toContain("אסור להופיע: מוצרי חלב");
  });

  it("leaves out the fields the sheet had nothing for", () => {
    const bare = { ...person, character: { ...person.character, wardrobe: "", accessories: [], pose: "" }, avoid: [] };
    const { cast } = parseCast({ people: [bare] });
    const a = castToAnswers(cast!.people[0]);
    expect(a.context).not.toContain("לבוש:");
    expect(a.context).not.toContain("אסור להופיע:");
  });
});
