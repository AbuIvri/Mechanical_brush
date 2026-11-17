import { useEffect } from "react";
import { useChat } from "../state/chat";
import { Icon } from "./Icon";

/** Cursor-style tab strip: one conversation per tab, each with its own model. A tab
 *  that is waiting on a model shows a dot, so a background run is visible from the
 *  tab you are actually looking at. */
export function ChatTabs() {
  const sessions = useChat((s) => s.sessions);
  const activeId = useChat((s) => s.activeId);
  const newSession = useChat((s) => s.newSession);
  const closeSession = useChat((s) => s.closeSession);
  const selectSession = useChat((s) => s.selectSession);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const { sessions: cur, activeId: id } = useChat.getState();
      if (e.key === "t") {
        e.preventDefault();
        newSession();
      } else if (e.key === "w" && cur.length > 1) {
        e.preventDefault();
        closeSession(id);
      } else if (/^[1-9]$/.test(e.key)) {
        const target = cur[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          selectSession(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession, closeSession, selectSession]);

  return (
    <div className="chat-tabs">
      {sessions.map((s) => (
        <button
          key={s.id}
          className={`chat-tab ${s.id === activeId ? "on" : ""}`}
          onClick={() => selectSession(s.id)}
          onAuxClick={(e) => {
            if (e.button === 1) closeSession(s.id);
          }}
          title={`${s.title} · ${s.model}`}
        >
          {s.busy && <span className="chat-tab-dot" />}
          <span className={`chat-tab-name ${s.id === activeId ? "ink ink--dry ink--under" : ""}`}>{s.title}</span>
          <span
            className="chat-tab-x"
            title="סגור לשונית"
            onClick={(e) => {
              e.stopPropagation();
              closeSession(s.id);
            }}
          >
            ✕
          </span>
        </button>
      ))}
      <button className="chat-tab-add" title="שיחה חדשה (⌘T)" aria-label="שיחה חדשה" onClick={() => newSession()}><Icon name="plus" size={14} /></button>
    </div>
  );
}
