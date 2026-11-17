import { useEffect, useState } from "react";
import { LargeImageDialog, PiecePicker } from "./ui/BigImage";
import { useStore, estimateGenMs, formatDuration } from "./state/store";
import { useFileDrop } from "./ui/useFileDrop";
import { ProjectTabs } from "./ui/ProjectTabs";

/** Live elapsed timer + ETA shown in the busy overlay. */
function GenProgress() {
  const startedAt = useStore((s) => s.genStartedAt);
  const timings = useStore((s) => s.genTimings);
  const providerId = useStore((s) => s.providerId);
  const mode = useStore((s) => s.mode);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => tick((v) => v + 1), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  const elapsed = Date.now() - startedAt;
  const est = estimateGenMs(timings, providerId, mode);
  const pct = est ? Math.min(99, Math.round((elapsed / est) * 100)) : null;
  return (
    <div className="gen-progress">
      <span>{formatDuration(elapsed)}</span>
      {est && (
        <span className="gen-eta">
          {elapsed < est ? `· משוער ≈ ${formatDuration(est)}` : "· כמעט שם…"}
        </span>
      )}
      {pct != null && (
        <span className="gen-bar"><span className="gen-bar-fill" style={{ width: `${pct}%` }} /></span>
      )}
    </div>
  );
}
import { TopBar } from "./ui/TopBar";
import { Toolbar } from "./ui/Toolbar";
import { LayersDock, PromptDock } from "./ui/Docks";
import { ChatDock } from "./ui/ChatDock";
import { SettingsDialog } from "./ui/SettingsDialog";
import { BatchDialog } from "./ui/BatchDialog";
import { useBatch } from "./state/batch";
import { SpendDialog } from "./ui/SpendDialog";
import { FeedbackDialog } from "./ui/FeedbackDialog";
import { HelpDialog } from "./ui/HelpDialog";
import { HistoryDialog } from "./ui/HistoryDialog";
import { Onboarding } from "./ui/Onboarding";
import { LicenseGate } from "./ui/LicenseGate";
import { CanvasStage } from "./canvas/CanvasStage";
import { Gallery } from "./ui/Gallery";

export default function App() {
  const init = useStore((s) => s.init);
  const status = useStore((s) => s.status);
  const busy = useStore((s) => s.busy);
  const onboarding = useStore((s) => s.onboarding);
  const licensed = useStore((s) => s.licensed);
  const hasProject = useStore((s) => !!s.project);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [spendOpen, setSpendOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const batchOpen = useBatch((s) => s.open);
  const showBatch = useBatch((s) => s.show);
  const hideBatch = useBatch((s) => s.hide);
  const recovery = useStore((s) => s.recovery);
  const restoreAutosave = useStore((s) => s.restoreAutosave);
  const dismissRecovery = useStore((s) => s.dismissRecovery);

  // Dropping onto the canvas: a layer on top of the open project, or a new project when
  // there is none. Never a replacement — dropping must not be able to lose work.
  const canvasDrop = useFileDrop({
    accept: "image+project",
    onFiles: (files) => {
      const st = useStore.getState();
      // A text file is a list of prompts: into the batch window, ready to look over and run.
      const list = files.find((f) => /\.(txt|docx)$/i.test(f.name));
      if (list) {
        if (list.path) {
          // Through the main process, which grants its folder for the list's "@file" images.
          void window.mbrush.promptFileOpen(list.path).then((r) => {
            if (r.ok && r.data) useBatch.getState().openPrompts(r.data.text, r.data.dir, r.data.path);
            else useStore.setState({ error: r.error ?? "קריאת רשימת הפרומפטים נכשלה" });
          });
        } else if (/\.docx$/i.test(list.name)) {
          // A Word document is read in the main process, which needs its path.
          useStore.setState({ error: `לא הצלחתי לקרוא את ${list.name} מהגרירה — פתח אותו דרך „פתח”.` });
        } else {
          const b64 = list.dataUrl.split(",")[1] ?? "";
          const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
          useBatch.getState().openPrompts(text, null, list.name);
        }
        return;
      }
      const project = files.find((f) => /\.mbrush$/i.test(f.name));
      if (project) {
        // Without a path there is nothing to open — and silence is what this used to do.
        if (project.path) return void st.openProjectByPath(project.path);
        return void useStore.setState({ error: `לא הצלחתי לקרוא את הנתיב של ${project.name}. פתח אותו דרך „פתח”.` });
      }
      const images = files.filter((f) => f !== project);
      if (!images.length) return;
      // The path lets a big dropped photo keep its full-resolution original by reference
      // instead of being copied into the app's folder.
      if (st.project) images.forEach((f) => void st.addImageLayer(f.dataUrl, f.name, { path: f.path }));
      else {
        void st.newProjectFromImage(images[0].name, images[0].dataUrl, { path: images[0].path });
        // A picture opened by dropping it is work too: it goes on the gallery's list.
        const p = images[0].path;
        if (p) void window.mbrush.recentsAdd({ path: p, name: images[0].name, kind: "image" });
      }
    },
  });

  useEffect(() => {
    init();
    // Runtime "open with" (double-click while app is already running).
    const off = window.mbrush.onOpenProjectFile((p) => useStore.getState().openProjectByPath(p));
    return () => {
      off();
    };
  }, [init]);

  // A file dropped anywhere that is NOT a drop zone would otherwise make the window
  // navigate to it — the app simply disappears, replaced by the picture. The drop zones
  // stop propagation, so anything reaching the window here is a miss and must do nothing.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      e.preventDefault();
      if (e.type === "drop" && e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");

      // Escape clears the current generative-fill selection.
      if (!typing && e.key === "Escape") {
        const st = useStore.getState();
        if (st.mask.rects.length > 0 || st.mask.strokes.length > 0 || st.mask.bitmaps.length > 0) {
          e.preventDefault();
          st.clearMask();
          return;
        }
      }

      // ⌘/Ctrl+Enter runs the current generation; 1-4 switch modes.
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        const st = useStore.getState();
        const canRun = !st.busy && (st.mode === "generate" ? st.prompt.trim().length > 0 : !!st.project);
        if (canRun) {
          e.preventDefault();
          st.generate();
          return;
        }
      }
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && ["1", "2", "3", "4"].includes(e.key)) {
        const modes = ["upscale", "recreate", "fill", "generate"] as const;
        useStore.getState().setMode(modes[Number(e.key) - 1]);
        return;
      }

      // Backspace/Delete erases the selected region from the active layer.
      if (!typing && (e.key === "Backspace" || e.key === "Delete")) {
        const st = useStore.getState();
        if (
          st.activeLayerId &&
          (st.mask.rects.length > 0 || st.mask.strokes.length > 0 || st.mask.bitmaps.length > 0)
        ) {
          e.preventDefault();
          st.deleteSelectedFromActiveLayer();
          return;
        }
      }

      // Bracket keys resize whichever brush is in hand (Photoshop-style): ] bigger,
      // [ smaller. Uses physical key codes (layout-independent, works on Hebrew
      // keyboards) and stays active even when a slider has focus (only real text fields
      // block it). Every tool that draws with a width answers to them — an eraser-only
      // shortcut is the kind that gets described in the manual and then doesn't work.
      const textTyping =
        el &&
        (el.tagName === "TEXTAREA" ||
          (el.tagName === "INPUT" && !["range", "checkbox", "radio", "button"].includes((el as HTMLInputElement).type)));
      if (!textTyping && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        const st = useStore.getState();
        const up = e.code === "BracketRight";
        if (st.tool === "erase-layer" || st.tool === "brush" || st.tool === "remove") {
          e.preventDefault();
          // Proportional: 12% a press feels the same at 20px and at 400px.
          const step = Math.max(2, Math.round(st.brushSize * 0.12));
          st.setBrushSize(st.brushSize + (up ? step : -step));
          return;
        }
        if (st.tool === "note") {
          e.preventDefault();
          // The markup pen runs 1–40, so a proportional step would round to nothing.
          st.setNoteSize(st.noteSize + (up ? 1 : -1));
          return;
        }
      }

      // Arrow-key nudge of the active layer (move tool) for pixel-perfect align.
      if (!typing && e.key.startsWith("Arrow")) {
        const st = useStore.getState();
        if (st.tool === "move" && st.activeLayerId) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const d =
            e.key === "ArrowLeft" ? [-step, 0] :
            e.key === "ArrowRight" ? [step, 0] :
            e.key === "ArrowUp" ? [0, -step] : [0, step];
          st.nudgeActiveLayer(d[0], d[1]);
          return;
        }
      }

      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) useStore.getState().redo();
        else useStore.getState().undo();
      } else if (k === "y") {
        e.preventDefault();
        useStore.getState().redo();
      } else if (k === "s") {
        e.preventDefault();
        useStore.getState().saveProject(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <TopBar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSpend={() => setSpendOpen(true)}
        onOpenFeedback={() => setFeedbackOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenBatch={() => showBatch()}
      />

      <ProjectTabs />
      <div className="workspace">
        <Toolbar />
        <ChatDock />
        <main className={`canvas-area ${canvasDrop.dragging ? "drop-armed" : ""}`} {...canvasDrop.handlers}>
          {hasProject ? <CanvasStage /> : <Gallery />}
          {canvasDrop.dragging && (
            <div className="drop-hint">
              {hasProject ? "שחרר כדי להוסיף כשכבה חדשה" : "שחרר כדי לפתוח"}
            </div>
          )}
          {busy && (
            <div className="busy-overlay">
              {/* No spinner: in דיו ופלדה the only thing that moves while it runs is
                  Run's own stroke. The words say it is running. */}
              <div className="busy-status">{status || "מעבד…"}</div>
              <GenProgress />
            </div>
          )}
        </main>
        <LayersDock />
      </div>
      <PromptDock />


      {/* Crash recovery: work from a session that ended without saving. A question, so a
          dialog — it used to be a coloured strip across the top of the window. It does not
          close on a click beside it: losing that work by a stray click would be the worst
          outcome on this screen. */}
      {recovery && (
        <div className="modal-backdrop">
          <div className="modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
            <div className="modal-title" id="recovery-title">
              {recovery.slots.length > 1 ? "לשחזר עבודות שלא נשמרו?" : "לשחזר עבודה שלא נשמרה?"}
            </div>
            <p className="recovery-text">
              {recovery.slots.length > 1 ? (
                <>
                  נמצאו <b>{recovery.slots.length} עבודות</b> מהפעם הקודמת שלא נשמרו. האחרונה: <b>{recovery.name}</b>.
                </>
              ) : (
                <>
                  נמצאה שמירה אוטומטית של <b>{recovery.name}</b> מהפעם הקודמת.
                </>
              )}
            </p>
            <p className="recovery-when">{new Date(recovery.savedAt).toLocaleString("he-IL")}</p>
            <div className="modal-actions">
              <button className="primary" onClick={restoreAutosave} autoFocus>שחזר</button>
              {/* Declining deletes the autosave for good (dismissRecovery), so the button
                  says that rather than a soft "not now". */}
              <button className="danger" onClick={dismissRecovery}>
                {recovery.slots.length > 1 ? "מחק את השמירות" : "מחק את השמירה"}
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {/* A picture over 4K: shrink it, or cut a piece of the original. */}
      <LargeImageDialog />
      <PiecePicker />
      {spendOpen && <SpendDialog onClose={() => setSpendOpen(false)} />}
      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {historyOpen && <HistoryDialog onClose={() => setHistoryOpen(false)} />}
      {batchOpen && <BatchDialog onClose={hideBatch} />}

      {onboarding && licensed && <Onboarding />}
      {!licensed && <LicenseGate />}
    </div>
  );
}
