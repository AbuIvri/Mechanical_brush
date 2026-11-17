import { create } from "zustand";

import { DEFAULT_TOOL_ORDER, reconcileOrder } from "../ui/toolbarItems";

const KEY = "mbrush.layout.v1";

interface LayoutData {
  layersWidth: number;
  layersCollapsed: boolean;
  layersAutoHide: boolean;
  promptHeight: number;
  promptCollapsed: boolean;
  /** AI prompt-assistant drawer (optional pull-out; closed by default). */
  chatOpen: boolean;
  chatWidth: number;
  /** Blow the assistant up over the whole canvas area (the canvas hides behind it). */
  chatMax: boolean;
  /** The toolbar, as the user arranged it: the order of every item, and what is hidden. */
  toolOrder: string[];
  toolHidden: string[];
  /** The interface's ground: grey (the original), black, or white. */
  theme: Theme;
  /** The prompt's type size in px. The hand face reads large; 26px filled the dock. */
  promptFont: number;
  /** What surrounds the picture: black, the theme's dark well, or a neutral mid grey
   *  (judging colour against black flatters it; photo editors offer grey for that). */
  well: Well;
  /** The navigator (a large view of the active layer) at the top of the layers dock. */
  navigatorOpen: boolean;
}

export type Well = "black" | "dark" | "grey";
export const WELLS: Well[] = ["black", "dark", "grey"];
export type Theme = "grey" | "black" | "white";
export const THEMES: Theme[] = ["grey", "black", "white"];
export const PROMPT_FONT = { min: 13, max: 28, default: 17 };

const DEFAULTS: LayoutData = {
  layersWidth: 320,
  layersCollapsed: false,
  layersAutoHide: false,
  // Tall enough that the prompt itself is in view above the pinned Run row. The top bar
  // gave back 76px when it stopped wrapping, so the canvas is no smaller for it.
  promptHeight: 300,
  promptCollapsed: false,
  chatOpen: false,
  chatWidth: 420,
  chatMax: false,
  toolOrder: DEFAULT_TOOL_ORDER,
  toolHidden: [],
  theme: "grey",
  promptFont: PROMPT_FONT.default,
  well: "dark",
  navigatorOpen: true,
};

const clampFont = (n: number) =>
  Math.max(PROMPT_FONT.min, Math.min(PROMPT_FONT.max, Math.round(Number(n) || PROMPT_FONT.default)));

function load(): LayoutData {
  try {
    const raw = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
    // A saved arrangement is reconciled against the items this build has, so an old
    // order cannot hide a new tool or resurrect a removed one.
    return {
      ...raw,
      toolOrder: reconcileOrder(raw.toolOrder),
      theme: THEMES.includes(raw.theme) ? raw.theme : "grey",
      promptFont: clampFont(raw.promptFont),
      well: WELLS.includes(raw.well) ? raw.well : "dark",
      navigatorOpen: raw.navigatorOpen !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

interface LayoutStore extends LayoutData {
  setLayersWidth: (n: number) => void;
  toggleLayersCollapsed: () => void;
  toggleLayersAutoHide: () => void;
  setPromptHeight: (n: number) => void;
  togglePromptCollapsed: () => void;
  toggleChat: () => void;
  setChatWidth: (n: number) => void;
  toggleChatMax: () => void;
  setToolOrder: (order: string[]) => void;
  toggleToolHidden: (id: string) => void;
  resetToolbar: () => void;
  resetLayout: () => void;
  setTheme: (t: Theme) => void;
  setPromptFont: (n: number) => void;
  setWell: (w: Well) => void;
  toggleNavigator: () => void;
}

export const useLayout = create<LayoutStore>((set, get) => {
  const persist = () => {
    const s = get();
    const data: LayoutData = {
      layersWidth: s.layersWidth,
      layersCollapsed: s.layersCollapsed,
      layersAutoHide: s.layersAutoHide,
      promptHeight: s.promptHeight,
      promptCollapsed: s.promptCollapsed,
      chatOpen: s.chatOpen,
      chatWidth: s.chatWidth,
      chatMax: s.chatMax,
      toolOrder: s.toolOrder,
      toolHidden: s.toolHidden,
      theme: s.theme,
      promptFont: s.promptFont,
      well: s.well,
      navigatorOpen: s.navigatorOpen,
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      /* ignore */
    }
  };

  return {
    ...load(),
    setLayersWidth: (n) => {
      set({ layersWidth: Math.max(220, Math.min(620, Math.round(n))) });
      persist();
    },
    toggleLayersCollapsed: () => {
      set({ layersCollapsed: !get().layersCollapsed });
      persist();
    },
    toggleLayersAutoHide: () => {
      set({ layersAutoHide: !get().layersAutoHide, layersCollapsed: false });
      persist();
    },
    setPromptHeight: (n) => {
      set({ promptHeight: Math.max(130, Math.min(460, Math.round(n))) });
      persist();
    },
    togglePromptCollapsed: () => {
      set({ promptCollapsed: !get().promptCollapsed });
      persist();
    },
    toggleChat: () => {
      set({ chatOpen: !get().chatOpen });
      persist();
    },
    setChatWidth: (n) => {
      set({ chatWidth: Math.max(320, Math.min(720, Math.round(n))) });
      persist();
    },
    toggleChatMax: () => {
      set({ chatMax: !get().chatMax });
      persist();
    },
    setToolOrder: (order) => {
      set({ toolOrder: reconcileOrder(order) });
      persist();
    },
    toggleToolHidden: (id) => {
      const cur = get().toolHidden;
      set({ toolHidden: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
      persist();
    },
    resetToolbar: () => {
      set({ toolOrder: DEFAULT_TOOL_ORDER, toolHidden: [] });
      persist();
    },
    resetLayout: () => {
      // The panes go back where they were; the look the user picked is not "layout".
      const { theme, promptFont, well } = get();
      set({ ...DEFAULTS, theme, promptFont, well });
      persist();
    },
    setTheme: (theme) => {
      set({ theme: THEMES.includes(theme) ? theme : "grey" });
      persist();
    },
    setPromptFont: (n) => {
      set({ promptFont: clampFont(n) });
      persist();
    },
    setWell: (well) => {
      set({ well: WELLS.includes(well) ? well : "dark" });
      persist();
    },
    toggleNavigator: () => {
      set({ navigatorOpen: !get().navigatorOpen });
      persist();
    },
  };
});

/** The look lives on <html>: the theme picks a token set (styles.css), and the prompt
 *  size is a variable the prompt reads. Set once at load and on every change. */
function applyLook(s: { theme: Theme; promptFont: number; well: Well }) {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.dataset.theme = s.theme;
  el.dataset.well = s.well;
  el.style.setProperty("--prompt-size", `${s.promptFont}px`);
}
applyLook(useLayout.getState());
useLayout.subscribe(applyLook);
