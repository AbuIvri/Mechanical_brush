// Batch-processing store — its OWN slice + running flag, deliberately separate from
// the main store so a batch never locks the canvas (global `busy`) or touches the
// open project. Sequential runner with per-item error isolation + cooperative cancel.
import { create } from "zustand";
import { v4 as uuid } from "uuid";
import { makeThumbnail } from "../compositing";
import { runBatchItem, type BatchAction } from "../batchRun";
import type { ProviderInfo } from "../../shared/types";

export type BatchStatus = "pending" | "running" | "done" | "failed";

export interface BatchItem {
  id: string;
  name: string;
  src: string; // original data URL
  thumb?: string;
  status: BatchStatus;
  outName?: string;
  error?: string;
}

interface BatchState {
  /** The dialog, and which of its two sides is showing. Here rather than in App so a
   *  dropped .txt, the open dialog and the assistant can all open it, prefilled. */
  open: boolean;
  tab: "files" | "prompts";
  /** The prompt list being edited, and — when it came from a file — that file's folder,
   *  where its "@file" references are looked up. */
  promptText: string;
  promptDir: string | null;
  promptSource: string | null;
  show: (tab?: "files" | "prompts") => void;
  hide: () => void;
  setTab: (tab: "files" | "prompts") => void;
  setPromptText: (text: string) => void;
  /** Open on the prompts side with a list in it. */
  openPrompts: (text: string, dir?: string | null, source?: string | null) => void;

  items: BatchItem[];
  running: boolean;
  cancelRequested: boolean;
  outDir: string | null;
  totalCost: number;

  addFiles: (files: { name: string; dataUrl: string }[]) => Promise<void>;
  removeItem: (id: string) => void;
  clear: () => void;
  chooseOutDir: () => Promise<void>;
  cancel: () => void;
  /** Reset failed items to pending (then call run again). */
  resetFailed: () => void;
  /** Process every pending item sequentially. */
  run: (action: BatchAction, provider: ProviderInfo | undefined) => Promise<void>;
}

export const useBatch = create<BatchState>((set, get) => ({
  open: false,
  tab: "files",
  promptText: "",
  promptDir: null,
  promptSource: null,
  show: (tab) => set((s) => ({ open: true, tab: tab ?? s.tab })),
  hide: () => set({ open: false }),
  setTab: (tab) => set({ tab }),
  // Typed or pasted text has no folder behind it, so "@file" cannot be looked up.
  setPromptText: (promptText) => set({ promptText }),
  openPrompts: (text, dir = null, source = null) =>
    set({ open: true, tab: "prompts", promptText: text, promptDir: dir, promptSource: source }),

  items: [],
  running: false,
  cancelRequested: false,
  outDir: null,
  totalCost: 0,

  async addFiles(files) {
    const added: BatchItem[] = [];
    for (const f of files) {
      const thumb = await makeThumbnail(f.dataUrl, 96).catch(() => undefined);
      added.push({ id: uuid(), name: f.name, src: f.dataUrl, thumb, status: "pending" });
    }
    set((s) => ({ items: [...s.items, ...added] }));
  },

  removeItem: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clear: () => set({ items: [], totalCost: 0, cancelRequested: false }),

  async chooseOutDir() {
    const r = await window.mbrush.chooseDirectory();
    if (r.ok && r.data) set({ outDir: r.data });
  },

  cancel: () => set({ cancelRequested: true }),

  resetFailed: () =>
    set((s) => ({
      items: s.items.map((i) => (i.status === "failed" ? { ...i, status: "pending", error: undefined } : i)),
    })),

  async run(action, provider) {
    const { running, outDir } = get();
    if (running || !outDir) return;
    set({ running: true, cancelRequested: false });
    const usedNames = new Set<string>(
      get().items.filter((i) => i.outName).map((i) => i.outName!),
    );
    const upd = (id: string, patch: Partial<BatchItem>) =>
      set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));

    for (const item of get().items) {
      if (get().cancelRequested) break;
      if (item.status !== "pending") continue;
      upd(item.id, { status: "running" });
      try {
        const out = await runBatchItem(item.src, action, provider);
        // Output named after the input, de-duplicated per run.
        const base = item.name.replace(/\.[^.]+$/, "") || "image";
        let outName = `${base}_${action.mode}.png`;
        for (let n = 2; usedNames.has(outName); n++) outName = `${base}_${action.mode}_${n}.png`;
        usedNames.add(outName);
        const w = await window.mbrush.writeImageTo(outDir, outName, out.src);
        if (!w.ok) throw new Error(w.error ?? "שמירת הקובץ נכשלה");
        if (out.cost > 0) {
          set((s) => ({ totalCost: s.totalCost + out.cost }));
          await window.mbrush
            .spendAdd(out.cost, { providerId: action.providerId, modelId: action.modelId, mode: action.mode })
            .catch(() => {});
        }
        upd(item.id, { status: "done", outName });
      } catch (e: any) {
        upd(item.id, { status: "failed", error: e?.message ?? "שגיאה לא ידועה" });
      }
    }
    set({ running: false, cancelRequested: false });
  },
}));
