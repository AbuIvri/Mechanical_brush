import type { GenerationMode } from "../../shared/types";
// Assistant conversations, one per tab. Everything the chat panel needs lives here
// rather than in ChatDock's local state, so several conversations can run at once —
// each with its own model — and a tab that finishes while you are looking at another
// tab writes its answer back to itself.

import { create } from "zustand";
import { type Attachment, contextForSend } from "./attachments";
// Re-exported so the many importers of "../state/chat" keep working.
export { contextForSend };
export type { Attachment };
import type { PromptSkill } from "../ui/skills";
import { type ChatProvider, defaultModel, isChatProvider, SUPERSEDED_DEFAULTS } from "../ui/chatModels";

const KEY = "mbrush.chat.sessions.v1";
const LS_PROVIDER = "mbrush.chat.provider";
const LS_MODELS = "mbrush.chat.models";
const MAX_SESSIONS = 20;

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  /** What is actually sent to the model when it differs from the displayed text. */
  sendText?: string;
  /** UI notice (e.g. "skill started") — not a model answer, so no prompt actions. */
  notice?: boolean;
  /** Labels of the images this turn was sent with, so the conversation shows what
   *  the model was actually looking at. */
  ctxLabels?: string[];
  /** The generation mode this answer's prompt was written FOR. Kept on the message so
   *  applying the prompt can switch to it — a prompt written for one mode pasted into
   *  another is how you get a sharpening instruction for a job that needed a rebuild. */
  promptMode?: GenerationMode;
}


/** Progress through a running skill workflow. The whole skill is kept, not just its
 *  id: a run started from an unsaved planner draft has no id to look up, and a saved
 *  skill deleted mid-run must not pull the floor out from under the run. */
export interface SkillRun {
  skill: PromptSkill;
  stepIdx: number;
  answers: Record<string, string>;
  stepDraft: string;
  finalPrompt: string | null;
  askMode: boolean;
}

/** The workflow planner, while it is open in a tab. */
export interface PlannerState {
  /** "ask" = describing the workflow, "edit" = working on a draft. */
  phase: "ask" | "edit";
  desc: string;
  draft: PromptSkill | null;
  errors: string[];
  warnings: string[];
  /** Set when editing an existing saved skill, so saving updates it in place. */
  sourceId?: string;
  /** Free-text "improve this" instruction for the model. */
  refine: string;
  /** A malformed draft gets exactly one automatic repair round-trip. */
  repaired?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  /** False once the title is pinned (a skill's name, or a rename). */
  titleAuto: boolean;
  provider: ChatProvider;
  model: string;
  msgs: ChatMsg[];
  /** Images staged in the composer, waiting to be sent. */
  attachments: Attachment[];
  /** Images the last turn actually sent. They carry forward so a follow-up question
   *  still has its subject, and are replaced the moment new ones are attached. */
  carry: Attachment[];
  input: string;
  /** Let the assistant look at the canvas (and the marked region) on its own when the
   *  user attached nothing. */
  autoContext: boolean;
  /** The user asked for a prompt. Until then the assistant talks, it doesn't deliver. */
  promptRequested: boolean;
  busy: boolean;
  busySince: number;
  error: string | null;
  skill: SkillRun | null;
  planner: PlannerState | null;
  updatedAt: number;
}

function uid() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The provider/model a brand-new tab opens with (the last ones picked). */
function seedModel(): { provider: ChatProvider; model: string } {
  const raw = localStorage.getItem(LS_PROVIDER);
  const provider: ChatProvider = isChatProvider(raw) ? raw : "openai";
  let model = defaultModel(provider);
  try {
    const byProvider = JSON.parse(localStorage.getItem(LS_MODELS) || "{}");
    const remembered = byProvider?.[provider];
    if (typeof remembered === "string" && remembered) {
      model = SUPERSEDED_DEFAULTS[remembered] ?? remembered;
    }
  } catch {
    /* keep the default */
  }
  return { provider, model };
}

export function blankSession(n = 1): ChatSession {
  const { provider, model } = seedModel();
  return {
    id: uid(),
    title: `שיחה ${n}`,
    titleAuto: true,
    provider,
    model,
    msgs: [],
    attachments: [],
    carry: [],
    input: "",
    autoContext: true,
    promptRequested: false,
    busy: false,
    busySince: 0,
    error: null,
    skill: null,
    planner: null,
    updatedAt: Date.now(),
  };
}

/** First line of the first user message, as a tab title. */
function autoTitle(msgs: ChatMsg[]): string | null {
  const first = msgs.find((m) => m.role === "user");
  if (!first) return null;
  const t = first.content.trim().split("\n")[0];
  return t.length > 24 ? `${t.slice(0, 24)}…` : t;
}

interface Persisted {
  sessions: ChatSession[];
  activeId: string;
}


/** Strip what must not (or cannot) survive a restart. */
function forDisk(sessions: ChatSession[]): ChatSession[] {
  return sessions.slice(0, MAX_SESSIONS).map((s) => ({
    ...s,
    // Attachment pixels are data URLs (768px + ≤2048px) — a couple of tabs would
    // blow the ~5MB localStorage quota. Keep the label so the tab can say what it
    // lost and ask for it again.
    attachments: s.attachments.map((a) => ({ ...a, src: "", full: "", stale: true })),
    // A restored tab starts a fresh context rather than a stale one.
    carry: [],
    // A tab must never come back from disk stuck mid-request.
    busy: false,
    busySince: 0,
  }));
}

function load(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    const sessions: ChatSession[] = Array.isArray(raw?.sessions) ? raw.sessions : [];
    const clean = sessions
      .filter((s) => s && typeof s.id === "string")
      .map((s) => ({ ...blankSession(), ...s, busy: false, busySince: 0 }))
      // A tab opened before a newer model shipped is sitting on the old DEFAULT, not on
      // a decision — it would keep using it forever while new tabs moved on.
      .map((s) => ({ ...s, model: SUPERSEDED_DEFAULTS[s.model] ?? s.model }));
    if (!clean.length) throw new Error("empty");
    const activeId = clean.some((s) => s.id === raw.activeId) ? raw.activeId : clean[0].id;
    return { sessions: clean, activeId };
  } catch {
    const s = blankSession();
    return { sessions: [s], activeId: s.id };
  }
}

interface ChatStore extends Persisted {
  newSession: () => string;
  closeSession: (id: string) => void;
  selectSession: (id: string) => void;
  /** The only way conversation state changes — always keyed by session id, never by
   *  "the visible tab", so a background run lands in the tab that started it. */
  patchSession: (id: string, patch: Partial<ChatSession> | ((s: ChatSession) => Partial<ChatSession>)) => void;
  resetSession: (id: string) => void;
  session: (id?: string) => ChatSession;
}

export const useChat = create<ChatStore>((set, get) => {
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ sessions: forDisk(get().sessions), activeId: get().activeId }));
    } catch {
      /* quota — the tabs still work for this run */
    }
  };

  return {
    ...load(),

    session: (id) => {
      const s = get();
      return s.sessions.find((x) => x.id === (id ?? s.activeId)) ?? s.sessions[0];
    },

    newSession: () => {
      const s = blankSession(get().sessions.length + 1);
      set((cur) => ({ sessions: [...cur.sessions, s].slice(-MAX_SESSIONS), activeId: s.id }));
      persist();
      return s.id;
    },

    closeSession: (id) => {
      set((cur) => {
        const rest = cur.sessions.filter((x) => x.id !== id);
        // Never leave the panel with no conversation in it.
        if (!rest.length) {
          const fresh = blankSession();
          return { sessions: [fresh], activeId: fresh.id };
        }
        const idx = cur.sessions.findIndex((x) => x.id === id);
        const activeId = cur.activeId === id ? (rest[Math.min(idx, rest.length - 1)]?.id ?? rest[0].id) : cur.activeId;
        return { sessions: rest, activeId };
      });
      persist();
    },

    selectSession: (id) => {
      if (!get().sessions.some((x) => x.id === id)) return;
      set({ activeId: id });
      persist();
    },

    patchSession: (id, patch) => {
      set((cur) => ({
        sessions: cur.sessions.map((s) => {
          if (s.id !== id) return s;
          const next = { ...s, ...(typeof patch === "function" ? patch(s) : patch), updatedAt: Date.now() };
          if (next.titleAuto) next.title = autoTitle(next.msgs) ?? s.title;
          return next;
        }),
      }));
      persist();
    },

    resetSession: (id) => {
      set((cur) => ({
        sessions: cur.sessions.map((s) =>
          s.id === id
            ? { ...blankSession(), id: s.id, title: s.title, provider: s.provider, model: s.model, autoContext: s.autoContext }
            : s,
        ),
      }));
      persist();
    },
  };
});
