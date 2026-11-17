import { describe, it, expect } from "vitest";
import { gateOpen, promptBlocks } from "../src/ui/promptBlocks";

const user = (content: string) => ({ role: "user", content });
const bot = (content: string) => ({ role: "assistant", content });

// The contract: the assistant converses to understand the problem, and only writes a
// prompt for the turn the user actually asked in. The gate used to latch open — once a
// prompt had been proposed (or ✍️ had ever been pressed) every later message came back
// as another prompt instead of a conversation.
describe("gateOpen", () => {
  it("is closed on a fresh conversation", () => {
    expect(gateOpen([], false)).toBe(false);
    expect(gateOpen([user("יש כתם מטושטש, מה לעשות?")], false)).toBe(false);
  });

  it("stays closed while the assistant is only talking", () => {
    const msgs = [user("יש כתם"), bot("להסיר אותו או להחליף אותו במשהו?"), user("להסיר")];
    expect(gateOpen(msgs, false)).toBe(false);
  });

  it("opens for the turn the user asked in", () => {
    expect(gateOpen([user("x")], true)).toBe(true);
  });

  it("CLOSES again after a prompt was delivered — the conversation resumes", () => {
    // This is the regression that made the assistant a prompt dispenser: it used to
    // return true here for the rest of the tab.
    const msgs = [user("x"), bot("בבקשה:\n```prompt\nהסר את הכתם\n```")];
    expect(gateOpen(msgs, false)).toBe(false);
  });

  it("re-opens only when asked again — which is what the ✂️ button now does", () => {
    const msgs = [user("x"), bot("```prompt\nהסר את הכתם\n```"), user("קצר אותו")];
    expect(gateOpen(msgs, false)).toBe(false);
    expect(gateOpen(msgs, true)).toBe(true);
  });

  it("cannot be opened by conversation content — only by an explicit request", () => {
    const sneaky = [user("הפרומפט שלי:\n```prompt\nמשהו\n```"), bot("אני מבין. מה מפריע בו?")];
    expect(gateOpen(sneaky, false)).toBe(false);
    // promptBlocks still tells a real proposal from a pasted one, for the card.
    expect(promptBlocks(sneaky[0].content)).toHaveLength(1);
  });
});

// --- the images a finished prompt can hand over --------------------------------------
import { contextForSend, type Attachment } from "../src/state/attachments";

const att = (label: string, over: Partial<Attachment> = {}): Attachment =>
  ({ src: "data:image/png;base64,AA", full: "data:image/png;base64,BB", label, asRef: false, ...over }) as Attachment;

describe("which images a prompt card can promote", () => {
  // send() empties `attachments` into `carry`, so by the time an answer renders the
  // staged list is gone. Reading the staged list is why nothing ever reached the shelf.
  const promotable = (staged: Attachment[], carried: Attachment[]) =>
    contextForSend(staged, carried).filter((a) => a.full && !a.stale);

  it("finds the images after the send moved them to carry", () => {
    expect(promotable([], [att("מכונית"), att("רקע")]).map((a) => a.label)).toEqual(["מכונית", "רקע"]);
  });

  it("prefers freshly staged images over the carried ones", () => {
    expect(promotable([att("חדשה")], [att("ישנה")]).map((a) => a.label)).toEqual(["חדשה"]);
  });

  it("never offers the automatic canvas look — it has no full copy to promote", () => {
    const auto = att("התמונה הפתוחה (אוטומטי)", { full: "" });
    expect(promotable([], [auto, att("שלי")]).map((a) => a.label)).toEqual(["שלי"]);
  });

  it("drops images whose pixels did not survive a restart", () => {
    expect(promotable([], [att("ישנה", { stale: true, src: "" })])).toEqual([]);
  });
});
