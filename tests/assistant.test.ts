import { describe, it, expect } from "vitest";
import { PROVIDERS, defaultModel, providerDef, SUPERSEDED_DEFAULTS } from "../src/ui/chatModels";
import legend from "../src/help/legend.json";

describe("the assistant's GPT model", () => {
  it("defaults to the newest GPT", () => {
    expect(defaultModel("openai")).toBe("gpt-5.6");
  });

  it("keeps the older ones selectable rather than dropping them", () => {
    const gpt = providerDef("openai").models;
    expect(gpt).toContain("gpt-5.5");
    expect(gpt.indexOf("gpt-5.6")).toBeLessThan(gpt.indexOf("gpt-5.5"));
  });

  it("moves a tab that was left on the previous default, and only that", () => {
    // A session started before 5.6 existed is on yesterday's default, not on a choice.
    expect(SUPERSEDED_DEFAULTS["gpt-5.5"]).toBe("gpt-5.6");
    // A model the user picked deliberately is not in the table and is left alone.
    for (const m of ["gpt-5-nano", "gpt-5-mini", "gpt-5.1", "gpt-5"]) {
      expect(SUPERSEDED_DEFAULTS[m]).toBeUndefined();
    }
  });

  it("never maps a model onto one the provider does not offer", () => {
    const all = PROVIDERS.flatMap((p) => p.models);
    for (const to of Object.values(SUPERSEDED_DEFAULTS)) expect(all).toContain(to);
  });

  it("never points a superseded model at itself — that would loop the migration", () => {
    for (const [from, to] of Object.entries(SUPERSEDED_DEFAULTS)) {
      expect(from).not.toBe(to);
      expect(SUPERSEDED_DEFAULTS[to]).toBeUndefined();
    }
  });

  it("leaves every provider with a first entry to default to", () => {
    for (const p of PROVIDERS) expect(p.models[0]).toBeTruthy();
  });
});

describe("the legend's shortcuts", () => {
  const sc = (legend as { shortcuts: { keys: string; action: { he: string; en: string } }[] }).shortcuts;

  it("lists each key once — a duplicated row is a contradiction waiting to happen", () => {
    const keys = sc.map((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("describes the bracket keys as covering every brush, which is what they now do", () => {
    const b = sc.find((s) => s.keys === "[ / ]")!;
    expect(b.action.he).toContain("סימון");
    expect(b.action.he).toContain("מחיקה");
  });

  it("keeps both halves of what Esc does in its one row", () => {
    const esc = sc.find((s) => s.keys === "Esc")!;
    expect(esc.action.he).toContain("נקה");
    expect(esc.action.en.toLowerCase()).toContain("clear");
  });
});
