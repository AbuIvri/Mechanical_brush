import { describe, it, expect, beforeEach, vi } from "vitest";

// The session store reads localStorage at import time, so stub it first.
function memStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}
vi.stubGlobal("localStorage", memStorage());

const { useChat, contextForSend } = await import("../src/state/chat");
type Attachment = Parameters<typeof contextForSend>[0][number];

const img = (label: string, extra: Partial<Attachment> = {}): Attachment => ({
  src: `data:image/png;base64,${label}`,
  full: `data:image/png;base64,${label}FULL`,
  label,
  asRef: false,
  ...extra,
});

const reset = () => {
  localStorage.clear();
  const s = useChat.getState();
  s.sessions.slice(1).forEach((x) => s.closeSession(x.id));
  useChat.getState().resetSession(useChat.getState().sessions[0].id);
};

describe("contextForSend", () => {
  it("sends what is staged, and drops the carried set — a new task resets itself", () => {
    const fresh = [img("new")];
    expect(contextForSend(fresh, [img("old")])).toEqual(fresh);
  });

  it("carries the previous turn forward when nothing new is attached", () => {
    const old = [img("old"), img("old2")];
    expect(contextForSend([], old)).toEqual(old);
  });

  it("sends nothing when there is nothing on either side", () => {
    expect(contextForSend([], [])).toEqual([]);
  });

  it("ignores images restored without their pixels", () => {
    // A tab restored from disk keeps the label but not the data URL.
    expect(contextForSend([img("gone", { src: "", stale: true })], [img("kept")])).toEqual([img("kept")]);
    expect(contextForSend([], [img("gone", { src: "", stale: true })])).toEqual([]);
  });
});

describe("chat sessions", () => {
  beforeEach(reset);

  it("opens with exactly one session", () => {
    expect(useChat.getState().sessions).toHaveLength(1);
  });

  it("keeps parallel tabs independent — a patch never touches the active tab", () => {
    const a = useChat.getState().sessions[0].id;
    const b = useChat.getState().newSession();
    expect(useChat.getState().activeId).toBe(b);

    // Tab A answers while the user is looking at tab B.
    useChat.getState().patchSession(a, (s) => ({ msgs: [...s.msgs, { role: "assistant", content: "מתוך A" }] }));
    const { sessions, activeId } = useChat.getState();
    expect(activeId).toBe(b); // the visible tab did not move
    expect(sessions.find((s) => s.id === a)!.msgs).toHaveLength(1);
    expect(sessions.find((s) => s.id === b)!.msgs).toHaveLength(0);
  });

  it("gives each tab its own model", () => {
    const a = useChat.getState().sessions[0].id;
    const b = useChat.getState().newSession();
    useChat.getState().patchSession(a, { provider: "openai", model: "gpt-5.1" });
    useChat.getState().patchSession(b, { provider: "google", model: "gemini-2.5-pro" });
    expect(useChat.getState().session(a).model).toBe("gpt-5.1");
    expect(useChat.getState().session(b).model).toBe("gemini-2.5-pro");
  });

  it("titles a tab from its first user message", () => {
    const a = useChat.getState().sessions[0].id;
    useChat.getState().patchSession(a, { msgs: [{ role: "user", content: "תנסח לי פרומפט לפרסומת\nשורה שנייה" }] });
    expect(useChat.getState().session(a).title).toBe("תנסח לי פרומפט לפרסומת");
  });

  it("leaves a pinned title alone", () => {
    const a = useChat.getState().sessions[0].id;
    useChat.getState().patchSession(a, { title: "דף דמות", titleAuto: false });
    useChat.getState().patchSession(a, { msgs: [{ role: "user", content: "משהו אחר" }] });
    expect(useChat.getState().session(a).title).toBe("דף דמות");
  });

  it("never leaves the panel without a conversation", () => {
    const only = useChat.getState().sessions[0].id;
    useChat.getState().closeSession(only);
    expect(useChat.getState().sessions).toHaveLength(1);
    expect(useChat.getState().sessions[0].id).not.toBe(only);
  });

  it("moves the selection off a closed tab", () => {
    const a = useChat.getState().sessions[0].id;
    const b = useChat.getState().newSession();
    useChat.getState().closeSession(b);
    expect(useChat.getState().activeId).toBe(a);
  });

  it("persists history and models but never image payloads or a busy flag", () => {
    const a = useChat.getState().sessions[0].id;
    useChat.getState().patchSession(a, {
      msgs: [{ role: "user", content: "שלום" }],
      busy: true,
      busySince: 123,
      attachments: [{ src: "data:image/png;base64,AAAA", full: "data:image/png;base64,BBBB", label: "מוצר.png", asRef: true }],
    });
    const raw = JSON.parse(localStorage.getItem("mbrush.chat.sessions.v1")!);
    const disk = raw.sessions[0];
    expect(disk.msgs).toHaveLength(1);
    expect(disk.busy).toBe(false);
    expect(disk.attachments[0]).toMatchObject({ label: "מוצר.png", asRef: true, src: "", full: "", stale: true });
    expect(JSON.stringify(raw)).not.toContain("base64,AAAA");
  });

  it("resets a tab in place, keeping its identity and model", () => {
    const a = useChat.getState().sessions[0].id;
    useChat.getState().patchSession(a, { provider: "xai", model: "grok-4", msgs: [{ role: "user", content: "x" }], skill: null });
    useChat.getState().resetSession(a);
    const s = useChat.getState().session(a);
    expect(s.id).toBe(a);
    expect(s.model).toBe("grok-4");
    expect(s.msgs).toEqual([]);
  });
});
