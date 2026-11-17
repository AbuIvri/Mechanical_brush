import { describe, it, expect } from "vitest";
import { promptBlocks, wordCount } from "../src/ui/promptBlocks";

describe("promptBlocks", () => {
  it("returns nothing for a conversational answer", () => {
    // The whole point: a question must never be offered as a prompt to paste.
    expect(promptBlocks("לא בטוח שהבנתי — להסיר את הכתם או להחליף אותו במשהו?")).toEqual([]);
  });

  it("returns nothing for a long answer with no fenced prompt", () => {
    const chatty = "כדאי קודם לסמן את האזור.\n\n- אפשרות א\n- אפשרות ב\n\nמה מתאים לך?";
    expect(promptBlocks(chatty)).toEqual([]);
  });

  it("picks up the Hebrew and English versions in order", () => {
    const msg =
      "הבנתי — מסירים את הכתם ומשלימים את הרקע.\n\n" +
      "```prompt\nהסר את הכתם והשלם את משטח החיתוך. אל תוסיף עוד דג.\n```\n" +
      "```prompt-en\nRemove the smudge and complete the cutting board. Do not add another fish.\n```";
    const blocks = promptBlocks(msg);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].lang).toBe("he");
    expect(blocks[0].text).toBe("הסר את הכתם והשלם את משטח החיתוך. אל תוסיף עוד דג.");
    expect(blocks[1].lang).toBe("en");
    expect(blocks[1].text).toContain("Do not add another fish");
  });

  it("ignores other fenced blocks, and empty prompt fences", () => {
    expect(promptBlocks('```json\n{"a":1}\n```')).toEqual([]);
    expect(promptBlocks("```\nplain block\n```")).toEqual([]);
    expect(promptBlocks("```prompt\n\n```")).toEqual([]);
  });

  it("does not care about the fence's letter case", () => {
    expect(promptBlocks("```PROMPT\nשלום\n```")[0].lang).toBe("he");
    expect(promptBlocks("```Prompt-EN\nhello\n```")[0].lang).toBe("en");
  });
});

describe("wordCount", () => {
  it("counts words across newlines and extra spaces", () => {
    expect(wordCount("  הסר את   הכתם\nוהשלם את הרקע ")).toBe(6);
    expect(wordCount("")).toBe(0);
  });
});
