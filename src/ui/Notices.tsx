// Messages, in the footer on Run's line: one at a time, the newest.
//
// They used to stack at the foot of the picture, over the work itself — two or three at
// once after a fill ("new layer · cost", "alignment uncertain"). Now the newest one sits
// at the right end of the run row, and the ones before it are a click away in a short
// list, so a run that says several things in a row never shows more than one of them.
//
// The store keeps one status, one warning and one error, each replaced by the next. The
// log here remembers what each of them said, so the list can show a run's messages after
// the fields have moved on.

import { useCallback, useRef, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../state/store";
import { useDismiss } from "./useDismiss";

export type NoticeKind = "info" | "warn" | "error";
export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
  at: number;
}

/** How many messages the list keeps — a session's worth, not an archive. */
const LOG_MAX = 40;

interface NoticeLog {
  log: Notice[];
  /** Messages that arrived since the list was last opened. */
  unseen: number;
  push: (kind: NoticeKind, text: string) => void;
  seen: () => void;
  clear: () => void;
}

let nextId = 1;
export const useNotices = create<NoticeLog>((set) => ({
  log: [],
  unseen: 0,
  push: (kind, text) =>
    set((s) => ({ log: [{ id: nextId++, kind, text, at: Date.now() }, ...s.log].slice(0, LOG_MAX), unseen: s.unseen + 1 })),
  seen: () => set({ unseen: 0 }),
  clear: () => set({ log: [], unseen: 0 }),
}));

/** What a store state has to say right now, by kind. A status counts only once the run is
 *  over: while busy it is progress ("aligning…"), and the picture's overlay shows that. */
export function liveNotices(s: { busy: boolean; status: string; warning: string | null; error: string | null }) {
  return {
    info: !s.busy && s.status ? s.status : "",
    warn: s.warning ?? "",
    error: s.error ?? "",
  };
}

// Record every message as it appears — from here, not from the component, so nothing is
// missed while the dock is collapsed or the list is closed.
let last = { info: "", warn: "", error: "" };
useStore.subscribe((s) => {
  const now = liveNotices(s);
  const push = useNotices.getState().push;
  // Oldest kind first, so an error that came with a status ends up on top.
  if (now.info && now.info !== last.info) push("info", now.info);
  if (now.warn && now.warn !== last.warn) push("warn", now.warn);
  if (now.error && now.error !== last.error) push("error", now.error);
  last = now;
});

const LABEL: Record<NoticeKind, string> = { info: "", warn: "שים לב", error: "לא בוצע" };

/** The newest message still standing in the store, or null when there is none. */
function useCurrent(): { kind: NoticeKind; text: string } | null {
  const live = useStore(useShallow((s) => liveNotices(s)));
  const log = useNotices((s) => s.log);
  // The log is newest first: the first entry that the store still says is the one to show.
  for (const n of log) if (live[n.kind] === n.text) return { kind: n.kind, text: n.text };
  return null;
}

export function Notices() {
  const current = useCurrent();
  const log = useNotices((s) => s.log);
  const unseen = useNotices((s) => s.unseen);
  const seen = useNotices((s) => s.seen);
  const clear = useNotices((s) => s.clear);
  const dismissError = useStore((s) => s.dismissError);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(box, close, open);

  const dismissCurrent = () => {
    if (!current) return;
    if (current.kind === "info") useStore.setState({ status: "" });
    else dismissError();
  };
  // Others in the list beside the one on show. Only when there are several does the
  // control appear — a single message needs no list.
  const others = Math.max(0, log.length - (current ? 1 : 0));

  if (!current && !log.length) return <div className="notices" />;
  return (
    <div className="notices" ref={box}>
      {current && (
        <button
          className={`notice notice--${current.kind}`}
          onClick={dismissCurrent}
          title={`${current.text}\n\nלחץ לסגירה`}
          role={current.kind === "error" ? "alert" : "status"}
        >
          {LABEL[current.kind] && <b>{LABEL[current.kind]}</b>}
          <span>{current.text}</span>
        </button>
      )}
      {others > 0 && (
        <button
          className={`notice-more ${open ? "is-open" : ""}`}
          onClick={() => {
            setOpen((o) => !o);
            seen();
          }}
          title="כל ההודעות מהסשן"
          aria-expanded={open}
        >
          {current ? `עוד ${others}` : `הודעות (${log.length})`}
          {unseen > 1 && !open && <i className="notice-dot" aria-hidden />}
        </button>
      )}
      {open && (
        <div className="notice-list" role="log">
          <div className="notice-list-head">
            <span>הודעות</span>
            <button
              className="link"
              onClick={() => {
                clear();
                setOpen(false);
              }}
            >
              נקה
            </button>
          </div>
          <ol>
            {log.map((n) => (
              <li key={n.id} className={`notice-row notice--${n.kind}`}>
                <time dir="ltr">{new Date(n.at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                {LABEL[n.kind] && <b>{LABEL[n.kind]}</b>}
                <span>{n.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
