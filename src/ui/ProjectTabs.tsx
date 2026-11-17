import { useRef, useState } from "react";
import { useStore, modeLabel } from "../state/store";
import { docTitle, docRunBlocker, RUN_BLOCK_LABEL } from "../state/docs";
import { useDismiss } from "./useDismiss";
import { MAX_OPEN_AT_ONCE } from "../../shared/ipc";

/** Open projects, one tab each, plus the actions that work across all of them.
 *
 *  The active document is the store itself; the others are parked slices. A tab shows a
 *  dot while its project is rendering, a badge when a render finished in it while you
 *  were somewhere else, and a mark when its last run failed — the whole point of working
 *  in parallel is that you can stop watching, which only holds if the tab tells you what
 *  happened while you weren't.
 *
 *  The bar is two parts on purpose: the tab strip scrolls, the actions do not. A dropdown
 *  inside an `overflow-x: auto` container is clipped by it, which is how the save menu
 *  came to look like a dead button. */
export function ProjectTabs() {
  const docs = useStore((s) => s.docs);
  const activeDocId = useStore((s) => s.activeDocId);
  const switchDoc = useStore((s) => s.switchDoc);
  const closeDoc = useStore((s) => s.closeDoc);
  const newDocTab = useStore((s) => s.newDocTab);
  const openImages = useStore((s) => s.openImages);
  const runAllDocs = useStore((s) => s.runAllDocs);
  const exportAllDocs = useStore((s) => s.exportAllDocs);
  const mode = useStore((s) => s.mode);
  const prompt = useStore((s) => s.prompt);
  const references = useStore((s) => s.references);
  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.providerId);
  // The live values for the active tab, which are not in its parked slice.
  const liveProject = useStore((s) => s.project);
  const liveName = useStore((s) => s.project?.name ?? null);
  const liveBusy = useStore((s) => s.busy);
  const liveDirty = useStore((s) => s.dirty);
  const liveError = useStore((s) => s.error);
  const liveMask = useStore((s) => s.mask);

  const pendingOpen = useStore((s) => s.pendingOpen);
  // A prompt list running: how far, and the way to stop it. Only exists while it runs.
  const listRun = useStore((s) => s.listRun);
  const stopPromptList = useStore((s) => s.stopPromptList);
  const cancelPendingOpen = useStore((s) => s.cancelPendingOpen);
  const [saveOpen, setSaveOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const saveRef = useRef<HTMLDivElement>(null);
  useDismiss(saveRef, () => setSaveOpen(false), saveOpen);

  // What each tab looks like right now — the live one straight from the store, the rest
  // from their parked slices.
  const view = (d: (typeof docs)[number]) =>
    d.id === activeDocId
      ? { project: liveProject, busy: liveBusy, mode, prompt, mask: liveMask, error: liveError }
      : d.slice;

  const withProject = docs.filter((d) => !!view(d).project);
  // "each" only runs the tabs that have something to run; "current" hands them all the
  // visible tab's settings first, so what matters is just that they hold a project.
  const runnableAsIs = docs.filter((d) => !docRunBlocker(view(d) as never));
  const engineName = providers.find((p) => p.id === providerId)?.name ?? providerId;

  const runWith = (scope: "current" | "each") => {
    setRunOpen(false);
    void runAllDocs(scope);
  };

  return (
    <div className="proj-tabs-bar">
      <div className="proj-tabs">
        {docs.length > 1 &&
          docs.map((d, i) => {
            const active = d.id === activeDocId;
            const v = view(d);
            const title = active ? liveName || docTitle(d.slice, i) : docTitle(d.slice, i);
            const dirty = active ? liveDirty : d.slice.dirty;
            return (
              // A tab is two controls — go to it, close it — so it is a container holding
              // two buttons. The ✕ used to be a span inside the tab's button: unreachable by
              // keyboard, and invisible to a screen reader.
              <div
                key={d.id}
                className={`proj-tab ${active ? "on" : ""} ${!active && d.slice.unseen ? "unseen" : ""} ${!active && v.error ? "failed" : ""}`}
              >
                <button
                  className="proj-tab-go"
                  role="tab"
                  aria-selected={active}
                  onClick={() => switchDoc(d.id)}
                  title={v.busy ? `${title} — מייצר…` : v.error ? `${title} — ${v.error}` : title}
                >
                  {v.busy && <span className="proj-dot" />}
                  <span className={`proj-tab-name ${active ? "ink ink--dry ink--under" : ""}`}>{title}</span>
                  {dirty && <span className="proj-dirty" title="יש שינויים שלא נשמרו">•</span>}
                </button>
                <button className="proj-tab-x" title="סגור לשונית" aria-label={`סגור את ${title}`} onClick={() => closeDoc(d.id)}>
                  ✕
                </button>
              </div>
            );
          })}
      </div>

      <div className="proj-tabs-actions">
        <button className="proj-tab-add" title="פרויקט נוסף בלשונית חדשה" onClick={newDocTab}>
          לשונית חדשה
        </button>
        <button
          className="proj-tab-add"
          title={`פתח עד ${MAX_OPEN_AT_ONCE} תמונות בבת אחת — כשכבות בפרויקט אחד או כלשוניות נפרדות`}
          onClick={() => void openImages()}
        >
          פתח תמונות
        </button>

        {listRun && (
          <>
            <span className="proj-tabs-sep" />
            <button
              className="proj-tab-all list-stop"
              disabled={listRun.stopping}
              title="מה שכבר רץ יסתיים; שום הרצה חדשה לא תתחיל"
              onClick={stopPromptList}
            >
              {listRun.stopping ? "עוצר…" : `עצור רשימה (${listRun.done}/${listRun.total})`}
            </button>
          </>
        )}
        {docs.length > 1 && (
          <>
            <span className="proj-tabs-sep" />
            <button
              className="proj-tab-all"
              disabled={!withProject.length}
              title={withProject.length ? "הרץ בכל הלשוניות" : "אין לשוניות עם פרויקט פתוח"}
              onClick={() => setRunOpen(true)}
            >
              הרץ הכל
            </button>

            <div className="proj-save-all" ref={saveRef}>
              <button
                className="proj-tab-all"
                disabled={!withProject.length}
                title={
                  withProject.length
                    ? "שמור את הקנבס של כל הלשוניות לתיקייה אחת, כל אחת בשם שבו נפתחה"
                    : "אין לשוניות עם פרויקט לשמירה"
                }
                onClick={() => setSaveOpen((v) => !v)}
              >
                שמור הכל ({withProject.length})
              </button>
              {saveOpen && (
                <div className="proj-save-menu" onClick={() => setSaveOpen(false)}>
                  {(["png", "jpeg", "webp"] as const).map((f) => (
                    <button key={f} onClick={() => void exportAllDocs(f)}>
                      {f.toUpperCase()}
                      {f === "png" && <small>שומר שקיפות</small>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {pendingOpen && (
        <div className="modal-backdrop" onClick={cancelPendingOpen}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">נבחרו {pendingOpen.files.length} קבצים</div>
            <div className="settings-section">
              <div className="open-menu" style={{ position: "static", boxShadow: "none" }}>
                <button onClick={() => void openImages("tabs")}>
                  <b>לשוניות נפרדות</b>
                  <small>פרויקט לכל תמונה — אפשר להריץ על כולן יחד</small>
                </button>
                <button onClick={() => void openImages("layers")}>
                  <b>שכבות בפרויקט אחד</b>
                  <small>נערמות זו על זו בפרויקט הפתוח</small>
                </button>
              </div>
              {pendingOpen.overflow && (
                <p className="onboard-lead" style={{ textAlign: "start", opacity: 0.7 }}>
                  {pendingOpen.overflow}
                </p>
              )}
              <div className="modal-actions">
                <button onClick={cancelPendingOpen}>ביטול</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {runOpen && (
        <div className="modal-backdrop" onClick={() => setRunOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">הרצה בכל הלשוניות</div>
            <div className="settings-section">
              <p className="onboard-lead" style={{ textAlign: "start" }}>
                {withProject.length} לשוניות פתוחות, דרך <b>{engineName}</b>. שתיים רצות
                במקביל, וכל הרצה מחויבת בנפרד.
              </p>
              <div className="open-menu" style={{ position: "static", boxShadow: "none" }}>
                <button onClick={() => runWith("current")}>
                  <b>ההגדרות של הלשונית הפתוחה — לכולן</b>
                  <small>
                    {modeLabel(mode)} על כל {withProject.length} הלשוניות. הן מאמצות את
                    המצב, הפרומפט, ההגדרות ותמונות הייחוס שרואים עכשיו
                    {references.length > 0 && ` (${references.length} תמונות ייחוס — יחליפו את אלה שיש בכל לשונית)`}.
                  </small>
                </button>
                <button onClick={() => runWith("each")} disabled={!runnableAsIs.length}>
                  <b>כל לשונית לפי ההגדרות שלה</b>
                  <small>
                    {runnableAsIs.length} מתוך {docs.length} מוכנות להרצה
                    {runnableAsIs.length < docs.length &&
                      ` · השאר ידולגו (${[
                        ...new Set(
                          docs
                            .map((d) => docRunBlocker(view(d) as never))
                            .filter(Boolean)
                            .map((b) => RUN_BLOCK_LABEL[b!]),
                        ),
                      ].join(", ")})`}
                  </small>
                </button>
              </div>
              <div className="modal-actions">
                <button onClick={() => setRunOpen(false)}>ביטול</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
