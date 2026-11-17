import { describe, it, expect } from "vitest";
import { describeError } from "../shared/errors";
import { dataUrlBytes, requestBytes } from "../shared/payload";

/** The SDK's real shape: a bare "Connection error." with the reason buried in `cause`. */
function connErr(reason = "read ECONNRESET") {
  const e = new Error("Connection error.");
  (e as { cause?: unknown }).cause = Object.assign(
    new Error(`request to https://api.openai.com/v1/images/edits failed, reason: ${reason}`),
    { cause: { code: reason.split(" ").pop() } },
  );
  return e;
}

describe("a connection failure says what actually happened", () => {
  it("does not blame the resolution when the request was small", () => {
    const msg = describeError(connErr(), 3_000_000);
    expect(msg).toContain("נשלחו 3.0MB");
    // Not "you were not charged": a reset while waiting for the image may well have been
    // billed, and the app cannot know which side of the work it happened on.
    expect(msg).toContain("ייתכן שהספק כן חייב");
    expect(msg).not.toMatch(/(^|[^ן] )לא חויבת/);
    expect(msg).toMatch(/לחץ הרץ שוב/);
    // The old advice, which was wrong for a 3MB request.
    expect(msg).not.toMatch(/רזולוציה נמוכה/);
  });

  it("does blame the payload when the payload is the suspect", () => {
    const msg = describeError(connErr(), 24_000_000);
    expect(msg).toContain("נשלחו 24.0MB");
    expect(msg).toMatch(/הורד את רזולוציית האזור|הסר תמונות ייחוס/);
  });

  it("keeps the real reason from inside the cause chain", () => {
    const msg = describeError(connErr(), 1_000);
    expect(msg).toContain("Connection error.");
    expect(msg).toContain("ECONNRESET");
    expect(msg).toContain("images/edits");
  });

  it("recognises the transport failures that do not say 'connection error'", () => {
    for (const reason of ["socket hang up", "ETIMEDOUT", "fetch failed"]) {
      const e = new Error(`request failed, reason: ${reason}`);
      expect(describeError(e, 2_000_000)).toMatch(/החיבור לספק נקטע.*לפני שהתקבלה תשובה/);
    }
  });

  it("leaves an ordinary API error alone", () => {
    expect(describeError(new Error("400 Invalid size"), 5_000_000)).toBe("400 Invalid size");
  });

  it("weighs every image the request carries", () => {
    const url = (bytes: number) => `data:image/png;base64,${"A".repeat(Math.ceil(bytes / 0.75))}`;
    expect(dataUrlBytes(undefined)).toBe(0);
    expect(dataUrlBytes(url(1000))).toBeCloseTo(1000, -1);
    const total = requestBytes({
      image: url(1_200_000),
      mask: url(100_000),
      references: [{ src: url(1_200_000) }, { src: url(300_000) }],
    });
    // The failing run's shape: crop + mask + marked copy + context ≈ 2.8MB, not 24.
    expect(total / 1e6).toBeCloseTo(2.8, 1);
  });
});

describe("an account the provider will not bill", () => {
  // What this actually was: out of credits. The upload was rejected early and the server
  // closed mid-body, so the app never got to read "429 insufficient_quota" and reported a
  // connection error instead. Generate mode, whose body is small, showed the real message.
  it("names the real cause when the quota answer does arrive", () => {
    for (const raw of [
      "429 You exceeded your current quota, please check your plan and billing details.",
      "Error code: 429 - insufficient_quota",
      "402 Payment Required",
    ]) {
      const msg = describeError(new Error(raw), 2_000_000);
      expect(msg).toContain("נגמרו הקרדיטים");
      expect(msg).toContain("billing");
      // And it must not be mistaken for the app's own budget cap.
      expect(msg).toContain("התקרה שבתוך האפליקציה היא נפרדת");
      expect(msg).not.toMatch(/החיבור לספק נקטע/);
    }
  });

  it("puts credits first when the connection died instead of answering", () => {
    for (const bytes of [2_000_000, 24_000_000]) {
      const msg = describeError(connErr(), bytes);
      expect(msg).toContain("ראשית בדוק שיש קרדיטים");
      expect(msg).toContain("אם יש קרדיטים");
    }
  });
});

describe("the long wait for an image", () => {
  it("keeps TCP keep-alive on, so an idle wait is not mistaken for a dead connection", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("electron/providers/umage2/Umage2Provider.ts", "utf8"),
    );
    expect(src).toMatch(/new Agent\(\{ keepAlive: true, keepAliveMsecs: 20_000 \}\)/);
    // The client has to actually be given it — an agent nobody passes changes nothing.
    expect(src).toMatch(/new OpenAI\(\{ apiKey, httpAgent: Umage2Provider\.agent \}\)/);
    // And no socket-inactivity timeout: a generation legitimately sends nothing for minutes.
    expect(src).not.toMatch(/new Agent\(\{[^}]*timeout:/);
  });
});

describe("a request that ran out of time", () => {
  it("is said in words, with the billing caveat", () => {
    const e = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const msg = describeError(e);
    expect(msg).toMatch(/לא ענה בזמן/);
    expect(msg).toMatch(/לא נוצרה שכבה/);
    expect(msg).toMatch(/חייב/);
  });

  it("is recognised when it arrives wrapped as the cause of another error", () => {
    const e = new Error("fetch failed", { cause: new DOMException("The operation was aborted due to timeout", "TimeoutError") });
    expect(describeError(e)).toMatch(/לא ענה בזמן/);
  });
});
