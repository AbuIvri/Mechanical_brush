import { MAX_OPEN_AT_ONCE } from "../../shared/ipc";
import { fillBoxFor, fillLongEdgeFor, paddedFillBox, workingSize } from "../fillRegion";
import { canRemoveBackground } from "../../shared/capabilities";
import { modeLabel } from "../../shared/modes";
export { canRemoveBackground, modeLabel };
import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type {
  Annotation,
  BlendMode,
  SavedSkillRun,
  GenerationMode,
  GenerationResult,
  GenerationSettings,
  Layer,
  OriginalRef,
  Project,
  ProviderInfo,
  ReferenceImage,
  ReferenceRole,
  SpendEntry,
  RecentEntry,
} from "../../shared/types";
import {
  flattenLayers,
  flattenLayersHiRes,
  flattenRegionHiRes,
  imageSize,
  makeGalleryThumb,
  isGalleryThumb,
  downscaleToMax,
  makeThumbnail,
  maskHasContent,
  maskBounds,
  cropRegionResized,
  cropToAspect,
  applyFillColor,
  composeFillPatch,
  buildExpand,
  coverImage,
  buildExpandSide,
  composeExpandPiece,
  featherEdge,
  type ExpandSide,
  type InnerEdge,
  DEFAULT_FILL_COLOR,
  eraseMaskedFromLayer,
  type FillColorOptions,
  eraseFromLayer,
  rotateImage90,
  rasterizeMask,
  type Box,
  type MaskRect,
  type MaskState,
  type MaskStroke,
  TRANSPARENT_BG,
  bgFill,
  maskAreas,
  paintMarks,
  rectMaskUrl,
  cropImage,
  pasteInto,
} from "../compositing";
import { blendBand, ENGINE_COMFORT_EDGE, LARGE_IMAGE_EDGE } from "../piece";
import { originalUrl } from "../../shared/originalUrl";
import { promptTitle, type PromptListItem } from "../promptList";
import { useBatch } from "./batch";
import { expandPinTags, pinsOf, pinTagsIn } from "../pins";
import { dataUrlBytes } from "../../shared/payload";
import { DEFAULT_REF_ROLE, referenceGuide, referencesThatFit } from "../../shared/referenceGuide";
import { ERASE_FILL_PROMPT, eraseModelFor } from "../../shared/erasePrompts";
import { composePrompt, extractCore } from "../promptCompose";
import { getMosaicLayers } from "../mosaic";
import type { SavedSkill } from "../ui/skills";
import { DOC_KEYS, extractSlice, newDocId, unsavedDocNames, autosaveDocs, pendingAutosaves, type DocSlice, type Snapshot, uniqueExportName, docRunBlocker, RUN_BLOCK_LABEL } from "./docs";
import { alignToReference } from "../align";
import {
  buildSelectProxy,
  floodSelect,
  selectionToCanvas,
  segmentProxy,
  segmentsToCanvas,
  elementSelectAt,
  elementToCanvas,
  type WandProxy,
  type SegmentResult,
} from "../select";

/** One document's state, whether it is the visible one or a parked tab.
 *
 *  The active document IS the store, so this returns it untouched. A parked one is the
 *  app's globals with that tab's own fields laid over them — the exact view commitToDoc
 *  writes back into, so a run reads and writes the same document throughout. */
function docView(st: AppState, docId: string | undefined): AppState {
  if (!docId || docId === st.activeDocId) return st;
  const parked = st.docs.find((d) => d.id === docId);
  return parked ? ({ ...st, ...parked.slice } as AppState) : st;
}

/** Named in the "this model cannot do that" message, so it has to be one that can. */
const TRANSPARENT_CAPABLE_MODEL = "GPT Image 2.5";


/** Longest edge we will ever upload for a recreate/upscale, before the byte cap below. */
const HI_SEND_EDGE = 4096;
/** Upload ceiling for a source image. Not the API's documented 50MB limit — that size
 *  fails as a dropped connection long before the server ever rejects it. */
const MAX_SEND_BYTES = 8_000_000;



const HISTORY_CAP = 50;

/** A named, reusable generation setup — everything needed to reproduce a run. */
export interface SavedAction {
  id: string;
  name: string;
  mode: GenerationMode;
  prompt: string;
  settings: GenerationSettings;
  providerId: string;
  modelId: string;
  createdAt: number;
  lastUsed: number;
}

/** `remove` is the erase brush: it paints what generative fill should take away. Not to
 *  be confused with `erase` (rubs out the mask) or `erase-layer` (rubs out pixels). */
export type Tool = "move" | "pan" | "brush" | "erase" | "rect" | "erase-layer" | "wand" | "element" | "note" | "remove";

/** Which markup shape the "note" tool draws. One tool with a shape, rather than four
 *  tools, keeps the canvas tool dispatch and the cursor logic in one branch. */
export type NoteShape = "brush" | "text" | "arrow" | "rect" | "pin";

/** Run a generation; with variations>1, run N candidates in parallel. Every
 *  candidate is materialized as its own layer (no picker) — the user keeps or
 *  deletes whichever they like. `variants` holds all successful candidates. */
async function runWithVariants(
  req: Parameters<typeof window.mbrush.generate>[0],
  nVar: number,
  setState: (p: Partial<AppState>) => void,
): Promise<{ ok: boolean; data?: GenerationResult; variants?: GenerationResult[]; error?: string; cancelled?: boolean }> {
  const res = await window.mbrush.generate(req);
  if (nVar <= 1 || !res.ok || !res.data) return res;
  setState({ status: `מייצר ${nVar} וריאציות…` });
  const extras = await Promise.all(Array.from({ length: nVar - 1 }, () => window.mbrush.generate(req)));
  const all = [res, ...extras].filter((r) => r.ok && r.data).map((r) => r.data!);
  if (all.length <= 1) return res;
  return { ok: true, data: all[0], variants: all };
}

// --- Smart-selection working state (transient; rebuilt on demand) ---
let wandLast: { proxy: WandProxy; px: number; py: number; bitmapIndex: number } | null = null;
let proxyCache: { key: string; proxy: WandProxy } | null = null;
/** Proxy of the ACTIVE layer alone, covering just its box (cached per layer state).
 *  Proxying the box lets the AI models see the layer's content full-frame. */
async function getLayerProxy(project: Project, layer: Layer): Promise<WandProxy> {
  const key = `${layer.id}|${layer.src.length}|${layer.x}|${layer.y}|${layer.width}|${layer.height}|${project.canvas.width}x${project.canvas.height}`;
  if (proxyCache?.key === key) return proxyCache.proxy;
  const clean: Layer = { ...layer, visible: true, opacity: 1, blendMode: "normal" };
  // Layer box clamped to the document bounds.
  const bx = Math.max(0, Math.round(layer.x));
  const by = Math.max(0, Math.round(layer.y));
  const bw = Math.min(project.canvas.width - bx, Math.round(layer.width - (bx - layer.x)));
  const bh = Math.min(project.canvas.height - by, Math.round(layer.height - (by - layer.y)));
  const box = { x: bx, y: by, w: Math.max(1, bw), h: Math.max(1, bh) };
  const proxy = await buildSelectProxy([clean], project.canvas.width, project.canvas.height, "rgba(0,0,0,0)", box);
  proxyCache = { key, proxy };
  return proxy;
}
/** Doc coords → proxy coords (box-relative). */
function toProxyXY(proxy: WandProxy, x: number, y: number): { px: number; py: number } {
  return { px: (x - proxy.box.x) * proxy.scale, py: (y - proxy.box.y) * proxy.scale };
}

/** Above this source long-edge, Reve can't truly upscale (it downsamples to ~1MP);
 *  the UI offers to switch the run to umage2 before spending. */
export const REVE_UPSCALE_MAX_EDGE = 2048;

/** Wall-clock start of the in-flight generation (module-level so it survives the
 *  many return points inside generate()). */
let genWallStart = 0;

/** Human-friendly duration: "12 שניות" / "1:05 דק׳". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} שניות`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} דק׳`;
}

/** Average duration (ms) of past generations for an engine+mode, or null if unknown. */
export function estimateGenMs(
  timings: Record<string, { count: number; totalMs: number }>,
  providerId: string,
  mode: GenerationMode,
): number | null {
  const t = timings[`${providerId}:${mode}`];
  if (!t || t.count < 1) return null;
  return t.totalMs / t.count;
}

const emptyMask: MaskState = { strokes: [], rects: [], bitmaps: [], inverted: false };

/** Where an imported picture came from. */
export interface ImportSource {
  /** Already registered by the main process (it shrank the file on the way in). */
  original?: OriginalRef;
  /** The file on disk, for a picture that arrived some other way (a drop). */
  path?: string;
}

/** The big photo, made servable so a piece can be cut from it at full resolution. One the
 *  main process registered on the way in wins; otherwise a known file is registered, and
 *  a picture with no file behind it (dropped from a browser) is copied into the app's own
 *  folder. Only asked for when the user chooses to cut a piece. */
async function originalFor(dataUrl: string, from?: ImportSource): Promise<OriginalRef | undefined> {
  if (from?.original) return from.original;
  const r = from?.path ? await window.mbrush.originalRegister(from.path) : await window.mbrush.originalKeep(dataUrl);
  return r.ok ? r.data : undefined;
}

// The two questions a big picture raises are dialogs, answered asynchronously; the import
// that raised them waits on these. Outside the store because a function is not state.
/** Run tabs two at a time. Ten concurrent 4K edits invite rate-limit failures, and they
 *  would commit most of the spend before anything could be cancelled. `stop` is asked
 *  before each new run starts; one already running finishes. Returns the failures, named.
 *  A run reports its own failure into its tab rather than throwing, so the tab's own error
 *  is the only reliable signal that it did not land. */
async function runTabsInLanes(
  get: () => AppState,
  targets: { id: string; name: string }[],
  runOne: (t: { id: string; name: string }) => Promise<void>,
  stop: () => boolean = () => false,
  after: () => void = () => {},
): Promise<string[]> {
  const LANES = 2;
  let next = 0;
  const failed: string[] = [];
  const lane = async () => {
    while (next < targets.length && !stop()) {
      const t = targets[next++];
      try {
        await runOne(t);
        const err = docView(get(), t.id).error;
        if (err) failed.push(`${t.name}: ${err}`);
      } catch (e: any) {
        failed.push(`${t.name}: ${e?.message ?? "שגיאה"}`);
      }
      after();
    }
  };
  await Promise.all(Array.from({ length: Math.min(LANES, targets.length) }, lane));
  return failed;
}

let largeImageResolver: ((c: "shrink" | "piece" | "cancel") => void) | null = null;
let piecePickResolver: ((r: { x: number; y: number; w: number; h: number } | null) => void) | null = null;

/** Longest edge of a stored reference image. */
const REF_MAX_EDGE = 2048;

/** Another tab's canvas as one image — for using it as a reference. Works on the visible
 *  tab too (docView), though offering a tab its own canvas is the UI's job to avoid. */
async function docCanvasSnapshot(st: AppState, docId: string): Promise<{ src: string; name: string } | null> {
  const doc = st.docs.find((d) => d.id === docId);
  if (!doc) return null;
  const project = docView(st, docId).project;
  if (!project) return null;
  const { width, height, backgroundColor } = project.canvas;
  const src = await flattenLayers(project.layers, width, height, backgroundColor || "#ffffff");
  return { src, name: project.name || "ללא שם" };
}

/** The areas of the last erase paint that were counted. Pressing "erase" counts them to
 *  decide whether to ask per-area-or-whole, and the run needs them again a moment later —
 *  walking a 4K mask twice for the same answer is waste. Keyed by identity: every stroke
 *  produces a new MaskState object, so a stale entry can never match. */
let eraseCache: { mask: MaskState; w: number; h: number; areas: Awaited<ReturnType<typeof maskAreas>> } | null = null;
async function eraseAreasFor(mask: MaskState, w: number, h: number) {
  if (eraseCache && eraseCache.mask === mask && eraseCache.w === w && eraseCache.h === h) return eraseCache.areas;
  const areas = await maskAreas(mask, w, h);
  eraseCache = { mask, w, h, areas };
  return areas;
}

/** The shared "apply a recipe to the controls" write-back (actions, layer ↩, history).
 *  One raw patch — deliberately NOT setProvider/setMode, which force modelId to
 *  models[0] and can override the mode. Also persists the engine choice. */
function recipePatch(
  s: Pick<AppState, "providers" | "settings" | "modelId">,
  r: { mode?: GenerationMode; prompt?: string; settings?: GenerationSettings; providerId?: string; modelId?: string },
): Partial<AppState> {
  const patch: Partial<AppState> = {};
  if (r.mode) patch.mode = r.mode;
  if (typeof r.prompt === "string") patch.prompt = r.prompt;
  if (r.providerId && s.providers.some((p) => p.id === r.providerId)) {
    patch.providerId = r.providerId;
    const p = s.providers.find((x) => x.id === r.providerId);
    patch.modelId = r.modelId ?? p?.models[0]?.id ?? s.modelId;
    localStorage.setItem("mbrush.providerId", patch.providerId);
    if (patch.modelId) localStorage.setItem("mbrush.modelId", patch.modelId);
  } else if (r.modelId) {
    patch.modelId = r.modelId;
    localStorage.setItem("mbrush.modelId", r.modelId);
  }
  if (r.settings) patch.settings = { ...s.settings, ...r.settings };
  return patch;
}

interface AppState {
  project: Project | null;
  filePath: string | null;
  dirty: boolean;

  activeLayerId: string | null;
  tool: Tool;
  zoom: number;
  panX: number;
  panY: number;
  brushSize: number;
  brushHardness: number; // 0..100
  /** Explanatory markup: which shape the note tool draws, and in what colour. */
  noteShape: NoteShape;
  noteColor: string;
  noteSize: number;
  /** Timestamp of the last size/hardness change — drives the live canvas preview. */
  brushPreviewAt: number;
  showMask: boolean;
  compare: boolean; // before/after
  /** Multi-select for layout tools (independent of the single activeLayerId). */
  selectedLayerIds: string[];
  /** Layer highlighted by hovering its mosaic tile on the canvas. */
  hoveredLayerId: string | null;
  /** Mosaic compare view (temporary, non-destructive). */
  mosaic: boolean;
  mask: MaskState;
  removeMask: MaskState;
  thumbnails: Record<string, string>;

  providers: ProviderInfo[];
  providerId: string;
  modelId: string;
  secureStorage: boolean;
  configuredKeys: string[];

  mode: GenerationMode;
  prompt: string;
  references: ReferenceImage[];
  settings: GenerationSettings;
  promptHistory: string[];

  busy: boolean;
  status: string;
  error: string | null;
  warning: string | null;
  onboarding: boolean;
  licensed: boolean;
  licenseName?: string;
  recents: RecentEntry[];

  past: Snapshot[];
  future: Snapshot[];

  /** Open documents, in tab order. The ACTIVE one's state lives in the store itself —
   *  its entry here is a placeholder that is filled in the moment you switch away. */
  docs: { id: string; slice: DocSlice }[];
  activeDocId: string;
  /** A finished render arrived in a tab you were not looking at. */
  unseen: boolean;

  totalSpend: number;
  /** Running cost per "YYYY-MM", from the main process. */
  spendMonths: Record<string, { total: number; count: number }>;
  sessionSpend: number;
  genCount: number;
  spendEntries: SpendEntry[];
  /** Session budget cap in USD (0 = off). Generation is blocked once reached. */
  budgetCap: number;
  setBudgetCap: (n: number) => void;
  /** Learned generation durations per engine+mode, for time estimates. */
  genTimings: Record<string, { count: number; totalMs: number }>;
  /** Wall-clock start of the in-flight generation (for the live elapsed timer). */
  genStartedAt: number | null;
  recordGenTime: (providerId: string, mode: GenerationMode, ms: number) => void;
  /** Personal prompt library (persisted globally). */
  promptLibrary: string[];
  togglePromptInLibrary: (p: string) => void;

  /** Generate/recreate medium + style pickers (persisted globally). */
  recentMediums: string[];
  savedStyles: { title: string; text: string; lastUsed: number }[];
  /** Set/clear the active medium ("" clears); rewrites the prompt + recents. */
  applyMedium: (value: string) => void;
  /** Set/clear the active style text ("" clears); rewrites the prompt + bumps recent. */
  applyStyle: (text: string) => void;
  addSavedStyle: (title: string, text: string) => void;
  removeSavedStyle: (title: string) => void;

  /** User-saved prompt skills for the assistant (built-ins live in ui/skills.ts). */
  savedSkills: SavedSkill[];
  addSavedSkill: (skill: Omit<SavedSkill, "lastUsed">) => void;
  removeSavedSkill: (id: string) => void;
  bumpSkillUsed: (id: string) => void;

  /** Actions library — named generation setups, re-appliable to any image. */
  savedActions: SavedAction[];
  /** Snapshot the CURRENT controls (mode/prompt/settings/engine/model) under a name. */
  saveAction: (name: string) => void;
  /** Snapshot a specific layer's recipe under a name (from the ↩ dialog). */
  saveActionFromLayer: (layerId: string, name: string) => void;
  removeSavedAction: (id: string) => void;
  applyAction: (id: string) => void;

  // actions
  /** Push an undo step. `forDocId` targets a tab that may not be on screen — a render
   *  started by the run-all button must not push its step onto whatever you are viewing. */
  pushHistory: (forDocId?: string) => void;
  undo: () => void;
  redo: () => void;
  init: () => Promise<void>;
  refreshKeys: () => Promise<void>;
  /** `from` says where the picture came from, so a shrunk import keeps a way back to its
   *  full-resolution original: one the main process already registered, or a file path. */
  newProjectFromImage: (name: string, dataUrl: string, from?: ImportSource) => Promise<void>;
  openImage: () => Promise<void>;
  /** Open an image or a project. With a project already open, `how` says what an IMAGE
   *  should become: a layer here, its own tab, or a replacement. */
  openImageOrProject: (how?: "layer" | "tab" | "replace") => Promise<void>;
  openProject: () => Promise<void>;
  openProjectByPath: (path: string) => Promise<void>;
  /** Open a gallery entry: a saved project, or a picture worked on. */
  openRecent: (entry: RecentEntry) => Promise<void>;
  newFromScratch: () => void;
  /** An empty project in a tab of its own. */
  newProjectTab: () => void;
  /** Pick several images at once. With more than one file and no answer yet, this
   *  raises `pendingOpen` and the UI asks: layers in one project, or a tab each. */
  openImages: (how?: "tabs" | "layers") => Promise<void>;
  /** Files picked and waiting on that question. */
  pendingOpen: { files: { path: string; name: string }[]; overflow: string } | null;
  cancelPendingOpen: () => void;
  /** Run every open tab: "current" applies the visible tab's settings to all of them,
   *  "each" runs every tab's own and skips the ones with nothing to run. */
  runAllDocs: (scope: "current" | "each") => Promise<void>;
  /** Flatten every open tab and write them all into one folder. */
  exportAllDocs: (format: "png" | "jpeg" | "webp") => Promise<void>;
  closeProject: () => void;
  loadRecents: () => Promise<void>;
  removeRecent: (path: string) => Promise<void>;
  saveProject: (saveAs?: boolean) => Promise<void>;
  exportFlattened: (format?: "png" | "jpeg" | "webp" | "clipboard") => Promise<void>;

  setTool: (t: Tool) => void;
  setZoom: (z: number) => void;
  setPan: (x: number, y: number) => void;
  setBrushSize: (n: number) => void;
  setBrushHardness: (n: number) => void;
  eraseFromActiveLayer: (points: number[], size: number, hardness: number) => Promise<void>;
  commitLayerErase: (id: string, src: string) => Promise<void>;
  setLayerPosition: (id: string, x: number, y: number) => void;
  setLayerBox: (id: string, x: number, y: number, width: number, height: number) => void;
  /** Auto-scale a layer to the canvas: "fit" = contain, "fill" = cover. */
  fitLayerToCanvas: (id: string, mode: "fit" | "fill") => Promise<void>;
  nudgeActiveLayer: (dx: number, dy: number) => void;
  rotateCanvas: (clockwise: boolean) => Promise<void>;
  toggleShowMask: () => void;
  toggleCompare: () => void;
  /** Layout tools: multi-select, hover link, mosaic view, re-stack. */
  toggleLayerSelected: (id: string) => void;
  clearLayerSelection: () => void;
  setHoveredLayer: (id: string | null) => void;
  toggleMosaic: () => void;
  restackLayers: () => void;

  addStroke: (s: MaskStroke) => void;
  addRect: (r: MaskRect) => void;
  moveRect: (index: number, x: number, y: number) => void;
  clearMask: () => void;

  /** The erase brush: paint what to remove, then run it. */
  addRemoveStroke: (s: MaskStroke) => void;
  clearRemoveMask: () => void;
  /** How many separate areas are painted — one patch each when erasing per area. */
  planErase: () => Promise<number>;
  /** "areas": a fill patch per area, run in turn. "whole": one masked recreate. */
  runErase: (scope: "areas" | "whole") => Promise<void>;

  /** Markup for the assistant. Never part of the image sent to the image engine. */
  addAnnotation: (a: Annotation) => void;
  updateAnnotation: (index: number, patch: Partial<Annotation>) => void;
  removeAnnotation: (index: number) => void;
  clearAnnotations: () => void;
  /** Record the workflow that produced this project, so it can be resumed later. */
  setSkillRun: (run: SavedSkillRun) => void;
  /** Flip the canvas between an opaque background and a transparent one. The canvas is
   *  what decides whether a layer's alpha survives the export. */
  toggleCanvasTransparent: () => void;

  /** Open documents. The active one lives in the store; the rest are parked slices. */
  newDocTab: () => void;
  switchDoc: (id: string) => void;
  closeDoc: (id: string) => void;
  /** Commit a finished (or failed) generation to the document that started it, which
   *  may no longer be the one on screen. The patch may mix document fields with app-wide
   *  ones (spend, timings); the funnel splits them by DOC_KEYS. */
  commitToDoc: (docId: string | undefined, patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;
  toggleAnnotations: () => void;
  setNoteShape: (s: NoteShape) => void;
  setNoteColor: (c: string) => void;
  setNoteSize: (n: number) => void;
  invertMask: () => void;
  /** Lock the rect marking tool to a 1:1 square. */
  rectSquare: boolean;
  toggleRectSquare: () => void;

  // Smart selection (magic wand + AI segments)
  wandTolerance: number;
  setWandTolerance: (n: number) => void;
  wandSelectAt: (x: number, y: number) => Promise<void>;
  elementSelectAt: (x: number, y: number) => Promise<void>;
  segments: SegmentResult | null;
  segProxy: WandProxy | null;
  segBusy: boolean;
  runSegments: () => Promise<void>;
  selectSegmentClass: (classId: number) => void;
  /** Delete the selected region's pixels from the active layer (Backspace). */
  deleteSelectedFromActiveLayer: () => Promise<void>;

  setActiveLayer: (id: string) => void;
  toggleVisible: (id: string) => void;
  toggleLock: (id: string) => void;
  setOpacity: (id: string, v: number) => void;
  setBlend: (id: string, b: BlendMode) => void;
  renameLayer: (id: string, name: string) => void;
  duplicateLayer: (id: string) => Promise<void>;
  deleteLayer: (id: string) => void;
  moveLayer: (id: string, dir: -1 | 1) => void;
  mergeDown: (id: string) => Promise<void>;
  /** Flatten all visible layers: "new" = add as a new top layer; "replace" = collapse to one. */
  flattenAll: (mode: "new" | "replace") => Promise<void>;
  exportLayer: (id: string) => Promise<void>;
  addImageLayer: (src: string, name?: string, from?: ImportSource) => Promise<void>;
  /** Cut a piece of a big photo (choosing it on the original) into a project of its own. */
  newPieceProject: (name: string, dataUrl: string, from?: ImportSource) => Promise<void>;
  /** A picture over 4096px is being opened: what to do with it. */
  largeImageAsk: { name: string; width: number; height: number } | null;
  answerLargeImage: (choice: "shrink" | "piece" | "cancel") => void;
  /** Choosing the piece to cut, on the original. */
  piecePicker: { name: string; original: OriginalRef } | null;
  finishPiecePick: (rect: { x: number; y: number; w: number; h: number } | null) => void;
  /** Put this piece back into a copy of the photo it was cut from, at the exact spot.
   *  `band`: width in pixels of the soft blend at its edge (0 = a hard paste). */
  exportToOriginal: (opts: { band: number; matchColor: boolean }) => Promise<void>;
  /** The photo a piece came from moved: point at it again. */
  relinkPieceOriginal: () => Promise<void>;

  setProvider: (id: string) => void;
  setModel: (id: string) => void;
  setMode: (m: GenerationMode) => void;
  /** Mode change with engine-capability guards; returns the auto-switch kind. */
  pickMode: (m: GenerationMode) => "upscale" | "genonly" | null;
  setPrompt: (p: string) => void;
  /** Add a reference image. Stored at ≤2048px: a reference is looked at, not printed, and
   *  the original used to ride along on every request at full size. */
  addReference: (src: string, role?: ReferenceRole, from?: { docId: string; name: string }) => Promise<void>;
  removeReference: (id: string) => void;
  setReferenceRole: (id: string, role: ReferenceRole) => void;
  /** "What to take from this one" — goes to the engine with the role. */
  setReferenceNote: (id: string, note: string) => void;
  /** Use another open tab's canvas as a reference: a snapshot, taken now. */
  addReferenceFromDoc: (docId: string) => Promise<void>;
  /** Retake a tab-canvas reference from that tab as it looks now. */
  refreshReference: (id: string) => Promise<void>;
  updateSettings: (s: Partial<GenerationSettings>) => void;
  applyLayerParams: (id: string) => void;
  /** Set or clear a layer's non-destructive alignment matrix (clear = undefined). */
  setLayerAlign: (id: string, matrix?: { a: number; b: number; c: number; d: number; e: number; f: number }, score?: number) => void;
  /** Directional generative expand (one generation per chosen side → patch layers). */
  runExpand: (providerId: string, modelId: string, forDocId?: string) => Promise<void>;
  /** Format / aspect change (one full-canvas outpaint → a single whole layer). */
  runRatio: (providerId: string, modelId: string, forDocId?: string) => Promise<void>;
  /** Shrink a layer's pixels so its long edge ≤ 4096 (manual, for oversized layers). */
  downscaleLayer: (id: string) => Promise<void>;
  /** Re-apply color correction + feather to a fill layer, from its raw result.
   *  quiet = no busy overlay (live preview); recordHistory=false skips undo snapshot. */
  adjustFillLayer: (
    id: string,
    corr: FillColorOptions,
    feather?: number,
    opts?: { quiet?: boolean; recordHistory?: boolean },
  ) => Promise<void>;

  /** Re-tune a directional-expand patch's seam feather live (non-destructive). */
  adjustExpandLayer: (
    id: string,
    feather: number,
    opts?: { quiet?: boolean; recordHistory?: boolean },
  ) => Promise<void>;

  generate: (opts?: {
    overwriteLayerId?: string;
    asNewProject?: boolean;
    overrideProviderId?: string;
    docId?: string;
    /** Run the erase brush instead of what the dock says. Replaces mode, prompt and mask
     *  for this run only — the user's own prompt and marked region are left alone. */
    erase?: { mask: MaskState; whole?: boolean; label?: string };
    /** The name a text-to-image run gives the project it creates. */
    projectName?: string;
  }) => Promise<void>;
  /** A list of prompts: one tab per prompt, run two at a time. `dir` is the text file's
   *  folder, where "@file" references are read from. */
  runPromptList: (items: PromptListItem[], dir: string | null) => Promise<void>;
  /** While a list runs: how far it got, and the way to stop it. */
  listRun: { total: number; done: number; stopping: boolean } | null;
  stopPromptList: () => void;

  /** Crash recovery: autosaves found on startup — one per document that had unsaved
   *  work. `name` and `savedAt` are the newest one's. */
  recovery: { name: string; savedAt: number; slots: { id: string; name: string }[] } | null;
  restoreAutosave: () => Promise<void>;
  dismissRecovery: () => void;

  /** Generation history (project.jobs) actions. */
  applyJobParams: (jobId: string) => void;

  dismissError: () => void;
  setOnboarding: (v: boolean) => void;
  activateLicense: (code: string) => Promise<boolean>;
}

function touch(p: Project): Project {
  return { ...p, updatedAt: new Date().toISOString() };
}

/** Re-encode a data URL as JPEG/WebP (JPEG is composited on a solid background). */
function convertImage(src: string, format: "jpeg" | "webp", quality: number, bg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      if (format === "jpeg") {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, c.width, c.height);
      }
      ctx.drawImage(img, 0, 0);
      resolve(c.toDataURL(`image/${format}`, quality));
    };
    img.onerror = () => reject(new Error("המרת הפורמט נכשלה"));
    img.src = src;
  });
}

// --- Smart naming: suggest a meaningful, file-safe name instead of a generic one. ---
const GENERIC_NAMES = new Set([
  "יצירה חדשה", "פרוייקט חדש", "פרויקט חדש", "יצירה", "project", "untitled", "שכבת תמונה", "",
]);
function isGenericName(n?: string): boolean {
  return GENERIC_NAMES.has((n ?? "").trim());
}
/** Clean a prompt/string into a short, filesystem-safe title (no size, no generic). */
function slugifyName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ")
    .slice(0, 48)
    .trim();
}
/** Derive a name from (1) an AI layer's prompt, (2) project prompt history / current
 *  prompt, (3) a meaningful base-layer name, else (4) a date-stamped fallback. */
function suggestName(project: Project, promptHistory: string[], currentPrompt: string): string {
  const aiPrompt = [...project.layers].reverse().find((l) => l.metadata?.prompt?.trim())?.metadata?.prompt;
  const histPrompt = promptHistory.find((p) => p && p.trim());
  const prompt = (aiPrompt || histPrompt || currentPrompt || "").trim();
  if (prompt) {
    const s = slugifyName(prompt);
    if (s) return s;
  }
  const base = project.layers.find((l) => l.type === "base");
  if (base && !isGenericName(base.name)) return slugifyName(base.name);
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `מכחול ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
}


/** A document with nothing in it — what a new tab starts as. Defined once so the
 *  fields a fresh document resets can never drift from the fields a swap carries. */
function initialDoc(): DocSlice {
  return {
    project: null,
    filePath: null,
    dirty: false,
    activeLayerId: null,
    zoom: 1,
    panX: 0,
    panY: 0,
    selectedLayerIds: [],
    hoveredLayerId: null,
    mosaic: false,
    compare: false,
    mask: { strokes: [], rects: [], bitmaps: [], inverted: false },
    removeMask: { strokes: [], rects: [], bitmaps: [], inverted: false },
    thumbnails: {},
    mode: "generate",
    prompt: "",
    references: [],
    settings: {},
    promptHistory: [],
    past: [],
    future: [],
    busy: false,
    genStartedAt: null,
    unseen: false,
    error: null,
  };
}

// Numbers inside a Hebrew sentence: "1616×2048px" and "$0.347" are left-to-right runs, and
// in a right-to-left line their pieces reorder ("1616px×2048"). Each is wrapped in a
// directional isolate (LRI … PDI) so it reads as one unit wherever it lands.
export const dims = (w: number, h: number) => `\u2066${w}×${h}px\u2069`;
export const usd = (n: number) => `\u2066$${n.toFixed(3)}\u2069`;

export const useStore = create<AppState>((set, get) => ({
  project: null,
  filePath: null,
  dirty: false,
  activeLayerId: null,
  tool: "move",
  zoom: 1,
  panX: 0,
  panY: 0,
  brushSize: 60,
  noteShape: "brush" as NoteShape,
  noteColor: "#ff2d55",
  noteSize: 8,
  brushHardness: 80,
  brushPreviewAt: 0,
  showMask: true,
  compare: false,
  selectedLayerIds: [],
  hoveredLayerId: null,
  mosaic: false,
  mask: emptyMask,
  removeMask: emptyMask,
  largeImageAsk: null,
  piecePicker: null,
  listRun: null,
  thumbnails: {},

  providers: [],
  providerId: localStorage.getItem("mbrush.providerId") || "umage2",
  // First run only — a returning user keeps the model they picked. The real list
  // comes from the adapter (UMAGE2_MODELS); this just has to be a member of it.
  modelId: localStorage.getItem("mbrush.modelId") || "gpt-image-2.5-flare",
  secureStorage: false,
  configuredKeys: [],

  mode: "upscale",
  prompt: "",
  references: [],
  settings: { quality: "high", preserveGeometry: true, preserveColor: true },
  promptHistory: [],

  busy: false,
  status: "",
  error: null,
  warning: null,
  onboarding: false,
  licensed: false,
  licenseName: undefined,
  recents: [],

  past: [],
  future: [],
  docs: [],
  activeDocId: "",
  pendingOpen: null,
  unseen: false,
  totalSpend: 0,
  spendMonths: {},
  sessionSpend: 0,
  genCount: 0,
  spendEntries: [],
  budgetCap: Number(localStorage.getItem("mbrush.budgetCap") || 0) || 0,
  setBudgetCap: (n) => {
    const v = Math.max(0, Number(n) || 0);
    localStorage.setItem("mbrush.budgetCap", String(v));
    set({ budgetCap: v });
  },
  genTimings: (() => {
    try {
      return JSON.parse(localStorage.getItem("mbrush.genTimings") || "{}");
    } catch {
      return {};
    }
  })(),
  genStartedAt: null,
  recordGenTime: (providerId, mode, ms) => {
    if (!(ms > 0) || ms > 600000) return; // ignore absurd outliers
    set((s) => {
      const key = `${providerId}:${mode}`;
      const prev = s.genTimings[key] ?? { count: 0, totalMs: 0 };
      // Cap the window so the average tracks recent performance, not ancient runs.
      const count = Math.min(prev.count + 1, 20);
      const totalMs = prev.count >= 20 ? prev.totalMs - prev.totalMs / 20 + ms : prev.totalMs + ms;
      const next = { ...s.genTimings, [key]: { count, totalMs } };
      try {
        localStorage.setItem("mbrush.genTimings", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return { genTimings: next };
    });
  },
  promptLibrary: (() => {
    try {
      return JSON.parse(localStorage.getItem("mbrush.promptLibrary") || "[]");
    } catch {
      return [];
    }
  })(),
  togglePromptInLibrary: (p) => {
    const t = p.trim();
    if (!t) return;
    set((s) => {
      const has = s.promptLibrary.includes(t);
      const lib = has ? s.promptLibrary.filter((x) => x !== t) : [t, ...s.promptLibrary].slice(0, 50);
      localStorage.setItem("mbrush.promptLibrary", JSON.stringify(lib));
      return { promptLibrary: lib, status: has ? "הפרומפט הוסר מהספרייה" : "הפרומפט נשמר לספרייה האישית" };
    });
  },

  recentMediums: (() => {
    try {
      return JSON.parse(localStorage.getItem("mbrush.recentMediums") || "[]");
    } catch {
      return [];
    }
  })(),
  savedStyles: (() => {
    try {
      return JSON.parse(localStorage.getItem("mbrush.savedStyles") || "[]");
    } catch {
      return [];
    }
  })(),
  applyMedium: (value) => {
    set((s) => {
      const oldMedium = s.settings.medium ?? "";
      const styleText = s.settings.styleText ?? "";
      const core = extractCore(s.prompt, oldMedium, styleText);
      const prompt = composePrompt(value, core, styleText);
      let recentMediums = s.recentMediums;
      if (value) {
        recentMediums = [value, ...s.recentMediums.filter((x) => x !== value)].slice(0, 10);
        localStorage.setItem("mbrush.recentMediums", JSON.stringify(recentMediums));
      }
      return { prompt, settings: { ...s.settings, medium: value || undefined }, recentMediums };
    });
  },
  applyStyle: (text) => {
    set((s) => {
      const medium = s.settings.medium ?? "";
      const oldStyle = s.settings.styleText ?? "";
      const core = extractCore(s.prompt, medium, oldStyle);
      const prompt = composePrompt(medium, core, text);
      let savedStyles = s.savedStyles;
      if (text) {
        savedStyles = s.savedStyles.map((st) => (st.text === text ? { ...st, lastUsed: Date.now() } : st));
        localStorage.setItem("mbrush.savedStyles", JSON.stringify(savedStyles));
      }
      return { prompt, settings: { ...s.settings, styleText: text || undefined }, savedStyles };
    });
  },
  addSavedStyle: (title, text) => {
    const t = title.trim();
    const x = text.trim();
    if (!t || !x) return;
    set((s) => {
      const savedStyles = [
        { title: t, text: x, lastUsed: Date.now() },
        ...s.savedStyles.filter((st) => st.title !== t),
      ].slice(0, 200);
      localStorage.setItem("mbrush.savedStyles", JSON.stringify(savedStyles));
      return { savedStyles, status: `הסגנון "${t}" נשמר` };
    });
  },
  removeSavedStyle: (title) => {
    set((s) => {
      const savedStyles = s.savedStyles.filter((st) => st.title !== title);
      localStorage.setItem("mbrush.savedStyles", JSON.stringify(savedStyles));
      return { savedStyles };
    });
  },

  savedSkills: (() => {
    try {
      return JSON.parse(localStorage.getItem("mbrush.savedSkills") || "[]");
    } catch {
      return [];
    }
  })(),
  addSavedSkill: (skill) => {
    const name = skill.name.trim();
    if (!name || !skill.steps?.length) return;
    set((s) => {
      // Upsert by id first: editing a workflow and renaming it must update that
      // workflow, not leave the old name behind as a twin. Name is the fallback for
      // drafts that arrived without a matching id (a pasted export, say).
      const savedSkills = [
        { ...skill, name, lastUsed: Date.now() },
        ...s.savedSkills.filter((x) => x.id !== skill.id && x.name !== name),
      ].slice(0, 100);
      localStorage.setItem("mbrush.savedSkills", JSON.stringify(savedSkills));
      return { savedSkills, status: `הסקיל "${name}" נשמר` };
    });
  },
  removeSavedSkill: (id) => {
    set((s) => {
      const savedSkills = s.savedSkills.filter((x) => x.id !== id);
      localStorage.setItem("mbrush.savedSkills", JSON.stringify(savedSkills));
      return { savedSkills };
    });
  },
  bumpSkillUsed: (id) => {
    set((s) => {
      if (!s.savedSkills.some((x) => x.id === id)) return {};
      const savedSkills = s.savedSkills.map((x) => (x.id === id ? { ...x, lastUsed: Date.now() } : x));
      localStorage.setItem("mbrush.savedSkills", JSON.stringify(savedSkills));
      return { savedSkills };
    });
  },

  savedActions: (() => {
    try {
      return JSON.parse(localStorage.getItem("mbrush.savedActions") || "[]");
    } catch {
      return [];
    }
  })(),
  saveAction: (name) => {
    const t = name.trim();
    if (!t) return;
    set((s) => {
      const action: SavedAction = {
        id: uuid(),
        name: t,
        mode: s.mode,
        prompt: s.prompt,
        // Whole settings object — engine options live in settings[opt.key].
        settings: { ...s.settings },
        providerId: s.providerId,
        modelId: s.modelId,
        createdAt: Date.now(),
        lastUsed: Date.now(),
      };
      const savedActions = [action, ...s.savedActions.filter((a) => a.name !== t)].slice(0, 200);
      localStorage.setItem("mbrush.savedActions", JSON.stringify(savedActions));
      return { savedActions, status: `הפעולה "${t}" נשמרה לספרייה` };
    });
  },
  saveActionFromLayer: (layerId, name) => {
    const t = name.trim();
    const m = get().project?.layers.find((l) => l.id === layerId)?.metadata;
    if (!t || !m) return;
    set((s) => {
      const action: SavedAction = {
        id: uuid(),
        name: t,
        mode: m.mode ?? s.mode,
        prompt: m.prompt ?? "",
        settings: { ...(m.settings ?? {}) },
        providerId: m.providerId ?? s.providerId,
        modelId: m.modelId ?? s.modelId,
        createdAt: Date.now(),
        lastUsed: Date.now(),
      };
      const savedActions = [action, ...s.savedActions.filter((a) => a.name !== t)].slice(0, 200);
      localStorage.setItem("mbrush.savedActions", JSON.stringify(savedActions));
      return { savedActions, status: `הפעולה "${t}" נשמרה לספרייה` };
    });
  },
  removeSavedAction: (id) => {
    set((s) => {
      const savedActions = s.savedActions.filter((a) => a.id !== id);
      localStorage.setItem("mbrush.savedActions", JSON.stringify(savedActions));
      return { savedActions };
    });
  },
  applyAction: (id) => {
    const s = get();
    const a = s.savedActions.find((x) => x.id === id);
    if (!a) return;
    // The stored prompt already contains the composed medium/style tokens — set it
    // directly (re-running applyMedium/applyStyle would double them).
    const patch = recipePatch(s, a);
    const savedActions = s.savedActions.map((x) => (x.id === id ? { ...x, lastUsed: Date.now() } : x));
    localStorage.setItem("mbrush.savedActions", JSON.stringify(savedActions));
    const provider = s.providers.find((p) => p.id === a.providerId);
    const keyMissing = !!provider?.requiresApiKey && !s.configuredKeys.includes(a.providerId);
    set({
      ...patch,
      savedActions,
      status: `"${a.name}" הוחלה — הרץ כשתהיה מוכן`,
      ...(keyMissing
        ? { warning: `למנוע ${provider?.name ?? a.providerId} חסר מפתח API — הגדר אותו בהגדרות לפני ההרצה` }
        : {}),
    });
  },

  pushHistory(forDocId) {
    const s = forDocId ? docView(get(), forDocId) : get();
    if (!s.project) return;
    const snap: Snapshot = { project: s.project, mask: s.mask, removeMask: s.removeMask, activeLayerId: s.activeLayerId };
    get().commitToDoc(forDocId, { past: [...s.past, snap].slice(-HISTORY_CAP), future: [] });
  },

  undo() {
    const s = get();
    if (!s.project || s.past.length === 0) return;
    const prev = s.past[s.past.length - 1];
    const current: Snapshot = { project: s.project, mask: s.mask, removeMask: s.removeMask, activeLayerId: s.activeLayerId };
    set({
      project: prev.project,
      mask: prev.mask,
      removeMask: prev.removeMask ?? emptyMask,
      activeLayerId: prev.activeLayerId,
      past: s.past.slice(0, -1),
      future: [current, ...s.future].slice(0, HISTORY_CAP),
      dirty: true,
      status: "בוטל השלב האחרון",
    });
  },

  redo() {
    const s = get();
    if (s.future.length === 0) return;
    const next = s.future[0];
    const current: Snapshot | null = s.project
      ? { project: s.project, mask: s.mask, removeMask: s.removeMask, activeLayerId: s.activeLayerId }
      : null;
    set({
      project: next.project,
      mask: next.mask,
      removeMask: next.removeMask ?? emptyMask,
      activeLayerId: next.activeLayerId,
      future: s.future.slice(1),
      past: current ? [...s.past, current].slice(-HISTORY_CAP) : s.past,
      dirty: true,
      status: "שוחזר",
    });
  },

  async init() {
    if (!window.mbrush) {
      set({ error: "גשר ה-IPC לא נטען (preload). הפעל מחדש את האפליקציה." });
      return;
    }
    const res = await window.mbrush.listProviders();
    const statusRes = await window.mbrush.keyStatus();
    if (res.ok && res.data) {
      const providers = res.data;
      const current = providers.find((p) => p.id === get().providerId) ?? providers[0];
      set({
        providers,
        providerId: current?.id ?? "umage2",
        modelId: current?.models[0]?.id ?? "gpt-image-2.5-flare",
        secureStorage: statusRes.ok ? !!statusRes.data?.secure : false,
      });
    }
    // One document always exists — the store itself is it. Everything else is parked.
    if (!get().activeDocId) {
      const id = newDocId();
      set({ activeDocId: id, docs: [{ id, slice: extractSlice(get() as never) }] });
    }
    const spend = await window.mbrush.spendGet();
    if (spend.ok && spend.data) {
      set({
        totalSpend: spend.data.total,
        spendEntries: spend.data.entries,
        spendMonths: spend.data.months ?? {},
      });
    }

    // Crash recovery: offer to restore an autosave left from a previous session.
    const auto = await window.mbrush.autosaveList();
    if (auto.ok && auto.data?.length) {
      const [newest] = auto.data;
      set({
        recovery: {
          name: newest.name,
          savedAt: newest.savedAt,
          slots: auto.data.map((s) => ({ id: s.id, name: s.name })),
        },
      });
    }

    const lic = await window.mbrush.licenseStatus();
    const licensed = !!(lic.ok && lic.data?.activated);
    set({ licensed, licenseName: lic.data?.name });

    await get().loadRecents();

    await get().refreshKeys();
    const { configuredKeys, providerId, providers } = get();
    const needsKey = providers.find((p) => p.id === providerId)?.requiresApiKey;
    // Only prompt for the API key once the app is licensed (the license gate
    // is shown first otherwise).
    if (licensed && needsKey && !configuredKeys.includes(providerId)) set({ onboarding: true });

    // Open a .mbrush passed by the OS (double-click / "open with").
    const pending = await window.mbrush.getPendingFile();
    if (pending.ok && pending.data) get().openProjectByPath(pending.data);
  },

  async activateLicense(code) {
    const res = await window.mbrush.licenseActivate(code);
    if (res.ok && res.data?.activated) {
      set({ licensed: true, licenseName: res.data.name, error: null });
      const { configuredKeys, providerId, providers } = get();
      const needsKey = providers.find((p) => p.id === providerId)?.requiresApiKey;
      if (needsKey && !configuredKeys.includes(providerId)) set({ onboarding: true });
      return true;
    }
    set({ error: res.data?.reason || res.error || "קוד רישוי לא תקין" });
    return false;
  },

  async refreshKeys() {
    const res = await window.mbrush.keyList();
    if (res.ok && res.data) set({ configuredKeys: res.data });
  },

  async newProjectFromImage(name, dataUrl, from) {
    // Over 4K the picture is too big to work on whole — engines refuse or downscale it, and
    // the canvas crawls. Ask: shrink it (as always), or cut a piece at full resolution.
    const real = from?.original
      ? { width: from.original.width, height: from.original.height }
      : await imageSize(dataUrl);
    if (Math.max(real.width, real.height) > LARGE_IMAGE_EDGE) {
      const choice = await new Promise<"shrink" | "piece" | "cancel">((resolve) => {
        largeImageResolver?.("cancel"); // a question left open by an earlier import
        largeImageResolver = resolve;
        set({ largeImageAsk: { name, width: real.width, height: real.height } });
      });
      if (choice === "cancel") return;
      if (choice === "piece") return get().newPieceProject(name, dataUrl, from);
    }

    // Cap imports at 4K long-edge: bigger images blow past engine limits and slow
    // everything down for no visible gain. Shrink on the way in.
    let importNote = "";
    const fit = await downscaleToMax(dataUrl, 4096);
    if (fit.changed) {
      dataUrl = fit.src;
      importNote = ` · הוקטן ל-${fit.width}×${fit.height} (מקס׳ 4K)`;
    } else if (from?.original) {
      importNote = ` · הוקטן ל-4K (המקור ${from.original.width}×${from.original.height})`;
    }
    const { width, height } = await imageSize(dataUrl);
    const layerId = uuid();
    const base: Layer = {
      id: layerId,
      name: "תמונת בסיס",
      type: "base",
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: "normal",
      x: 0,
      y: 0,
      width,
      height,
      src: dataUrl,
      metadata: { createdAt: new Date().toISOString() },
    };
    const project: Project = {
      id: uuid(),
      name: name.replace(/\.[^.]+$/, ""),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      canvas: { width, height, backgroundColor: "#ffffff" },
      layers: [base],
      references: [],
      promptHistory: [],
      jobs: [],
      settings: { defaultProviderId: get().providerId, autosave: false },
    };
    const thumb = await makeThumbnail(dataUrl);
    set({
      project,
      filePath: null,
      dirty: false,
      activeLayerId: layerId,
      mask: { strokes: [], rects: [], bitmaps: [], inverted: false },
      removeMask: { strokes: [], rects: [], bitmaps: [], inverted: false },
      thumbnails: { [layerId]: thumb },
      zoom: fitZoom(width, height),
      panX: 0,
      panY: 0,
      past: [],
      future: [],
      status: importNote ? `נטענה תמונה${importNote}` : "",
    });
  },

  async newPieceProject(name, dataUrl, from) {
    const original = await originalFor(dataUrl, from);
    if (!original?.token) {
      set({ warning: "לא ניתן לקרוא את התמונה המקורית לחיתוך — היא נפתחת מוקטנת ל-4K." });
      // Fall back to the ordinary import, without asking again.
      return get().newProjectFromImage(name, (await downscaleToMax(dataUrl, LARGE_IMAGE_EDGE)).src);
    }
    const rect = await new Promise<{ x: number; y: number; w: number; h: number } | null>((resolve) => {
      piecePickResolver?.(null);
      piecePickResolver = resolve;
      set({ piecePicker: { name, original } });
    });
    if (!rect) return;
    set({ status: "חותך את החתיכה מהמקור…", error: null });
    try {
      // Pixel for pixel out of the original — no scaling anywhere between the photo and
      // the piece, so the piece IS the photo there, and goes back without a seam of its own.
      const src = await cropImage(originalUrl(original.token), rect);
      const layerId = uuid();
      const now = new Date().toISOString();
      const project: Project = {
        id: uuid(),
        name: `${name.replace(/\.[^.]+$/, "")} · חתיכה`,
        createdAt: now,
        updatedAt: now,
        canvas: { width: rect.w, height: rect.h, backgroundColor: "#ffffff" },
        layers: [
          {
            id: layerId,
            name: "חתיכה מהמקור",
            type: "base",
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: "normal",
            x: 0,
            y: 0,
            width: rect.w,
            height: rect.h,
            src,
            metadata: { createdAt: now },
          },
        ],
        references: [],
        promptHistory: [],
        jobs: [],
        settings: { defaultProviderId: get().providerId, autosave: false },
        pieceSource: { original, rect },
      };
      const thumb = await makeThumbnail(src).catch(() => "");
      const big = Math.max(rect.w, rect.h) > ENGINE_COMFORT_EDGE;
      set({
        project,
        filePath: null,
        dirty: false,
        activeLayerId: layerId,
        mask: { strokes: [], rects: [], bitmaps: [], inverted: false },
        removeMask: { strokes: [], rects: [], bitmaps: [], inverted: false },
        thumbnails: thumb ? { [layerId]: thumb } : {},
        zoom: fitZoom(rect.w, rect.h),
        panX: 0,
        panY: 0,
        past: [],
        future: [],
        status:
          `חתיכה ${rect.w}×${rect.h} מתוך ${original.width}×${original.height} — בסיום: ייצוא ← "החזר לתמונה המקורית"` +
          (big ? ` · גדולה מ-${ENGINE_COMFORT_EDGE}px, רוב המנועים יקטינו אותה לפני העבודה` : ""),
      });
    } catch (e: any) {
      set({ error: e?.message ?? "חיתוך החתיכה נכשל", status: "" });
    }
  },

  async openImage() {
    const res = await window.mbrush.openImage();
    if (!res.ok) return set({ error: res.error ?? "פתיחה נכשלה" });
    if (!res.data) return;
    await get().newProjectFromImage(res.data.name, res.data.dataUrl, { original: res.data.original });
  },

  async openImageOrProject(how) {
    const res = await window.mbrush.openAny();
    if (!res.ok) return set({ error: res.error ?? "פתיחה נכשלה" });
    if (!res.data) return;
    // A project file always opens as a project; openProjectByPath decides whether that
    // means this tab or a new one.
    if (res.data.kind === "project") {
      if (get().project) return void get().openProjectByPath(res.data.path);
      await applyOpenedProject(set, res.data.path, res.data.project);
      await get().loadRecents();
      return;
    }
    // A text file is a list of prompts: open it in the batch window, ready to run.
    if (res.data.kind === "text") {
      useBatch.getState().openPrompts(res.data.text, res.data.dir, res.data.path);
      return;
    }
    const { name, dataUrl } = res.data;
    const from: ImportSource = { original: res.data.original };
    // An image with nothing open has only one sensible meaning.
    if (!get().project) return void get().newProjectFromImage(name, dataUrl, from);
    if (how === "layer") return void get().addImageLayer(dataUrl, name, from);
    if (how === "tab") {
      get().newDocTab();
      return void get().newProjectFromImage(name, dataUrl, from);
    }
    // "replace": the existing guard on unsaved work still applies.
    if (get().dirty && !window.confirm("יש שינויים שלא נשמרו. להחליף את העבודה הפתוחה?")) return;
    await get().newProjectFromImage(name, dataUrl, from);
  },

  newProjectTab() {
    get().newDocTab();
    set({ status: "לשונית חדשה — פתח תמונה או צור מטקסט" });
  },

  async openImages(how) {
    // Answering the question must NOT re-open the file dialog — the files were already
    // picked, and picking them is what granted access to them in the first place.
    const pending = get().pendingOpen;
    let files: { path: string; name: string }[];
    let overflow: string;
    if (pending && how) {
      files = pending.files;
      overflow = pending.overflow;
    } else {
      const picked = await window.mbrush.pickImages();
      if (!picked.ok) return set({ error: picked.error ?? "פתיחה נכשלה" });
      const data = picked.data ?? { files: [], skipped: 0 };
      if (!data.files.length) return;
      files = data.files;
      overflow =
        data.skipped > 0
          ? `${data.skipped} קבצים נוספים לא נפתחו (מקסימום ${MAX_OPEN_AT_ONCE} בפעם אחת)`
          : "";
    }

    // Several files can mean two quite different things, and guessing wrong is annoying
    // either way — so ask. One file has no ambiguity worth a dialog.
    if (files.length > 1 && !how) {
      return set({ pendingOpen: { files, overflow } });
    }

    // NOT `busy`: that flag belongs to one document, and newDocTab() below parks the
    // live state — busy included — into the tab it is leaving. Setting it here stranded
    // the first tab on the spinner forever, since the matching busy:false only ever
    // reached the last one. Opening files is an app-level job; status is the right voice.
    set({ pendingOpen: null, status: `פותח ${files.length} קבצים…` });
    const asLayers = how === "layers";
    let opened = 0;
    const failed: string[] = [];
    for (const f of files) {
      // One file at a time: ten originals held as base64 at once is a memory spike for
      // no reason, and the main process hands them over individually for exactly this.
      set({ status: `פותח ${opened + failed.length + 1} מתוך ${files.length}: ${f.name}` });
      const r = await window.mbrush.readImageFile(f.path);
      if (!r.ok || !r.data) {
        // The reason matters: "too big (72MB)" is actionable, a bare filename is not.
        failed.push(r.error ? `${f.name} — ${r.error}` : f.name);
        continue;
      }
      if (asLayers) {
        // Layers stack into ONE project: the open one, or a first project made from the
        // first image so the rest have something to stack onto.
        if (!get().project) await get().newProjectFromImage(f.name, r.data.dataUrl, { original: r.data.original });
        else await get().addImageLayer(r.data.dataUrl, f.name, { original: r.data.original });
      } else {
        // The first image can take the tab we are standing in, but only if it is empty —
        // never silently over an open project.
        if (opened > 0 || get().project) get().newDocTab();
        await get().newProjectFromImage(f.name, r.data.dataUrl, { original: r.data.original });
      }
      opened++;
    }

    const notes = [overflow, failed.length ? `נכשלו: ${failed.join(", ")}` : ""].filter(Boolean);
    set({
      status: asLayers ? `נוספו ${opened} שכבות` : `נפתחו ${opened} לשוניות`,
      warning: notes.length ? notes.join(" · ") : null,
    });
  },

  async runPromptList(items, dir) {
    const st = get();
    if (!items.length || st.listRun) return;
    // References named in the list are read before anything is created or spent: a missing
    // file stops the whole run with its name, rather than failing one prompt in the middle.
    const names = [...new Set(items.flatMap((i) => i.refs))];
    const loaded = new Map<string, string>();
    if (names.length) {
      if (!dir) {
        return set({
          error: `הפניה לקובץ (${names.map((n) => "@" + n).join(", ")}) עובדת רק מרשימה שנפתחה מקובץ — הקובץ נחפש בתיקייה שלו.`,
        });
      }
      const missing: string[] = [];
      for (const n of names) {
        const r = await window.mbrush.readImageFile(`${dir.replace(/[\\/]$/, "")}/${n}`);
        if (r.ok && r.data) loaded.set(n, (await downscaleToMax(r.data.dataUrl, REF_MAX_EDGE)).src);
        else missing.push(n);
      }
      if (missing.length) {
        const where = items
          .filter((i) => i.refs.some((r) => missing.includes(r)))
          .map((i) => `שורה ${i.line}`)
          .join(", ");
        return set({ error: `לא נמצאו בתיקייה של הרשימה: ${missing.map((n) => "@" + n).join(", ")} (${where}). שום דבר לא הורץ.` });
      }
    }

    // Everything the prompt bar says now — engine, model, resolution, quality, the shelf —
    // applies to every prompt; the list only adds what it states.
    const settings = { ...st.settings };
    const shelf = st.references;
    const targets: { id: string; name: string; prompt: string }[] = [];
    items.forEach((item, i) => {
      // The tab in view is used for the first prompt if it is empty; every other prompt
      // gets a tab of its own.
      if (i > 0 || get().project || get().busy) get().newDocTab();
      // The document's own heading for it when it had one ("01 · …"), else its first words.
      const name = item.title ? promptTitle(item.title, 40) : promptTitle(item.prompt);
      set({
        mode: "generate",
        prompt: item.prompt,
        settings: item.aspect ? { ...settings, aspectRatio: item.aspect } : { ...settings },
        references: [
          ...shelf,
          ...item.refs.map((n) => ({ id: uuid(), src: loaded.get(n)!, role: DEFAULT_REF_ROLE, note: undefined })),
        ],
        error: null,
      });
      targets.push({ id: get().activeDocId, name, prompt: item.prompt });
    });
    // Watch the first one fill in; the others show their progress on their tabs.
    get().switchDoc(targets[0].id);

    set({ listRun: { total: targets.length, done: 0, stopping: false }, status: `רשימת פרומפטים: ${targets.length} תמונות…` });
    const failed = await runTabsInLanes(
      get,
      targets,
      (t) => get().generate({ docId: t.id, projectName: t.name }),
      () => !!get().listRun?.stopping,
      () => set((s) => (s.listRun ? { listRun: { ...s.listRun, done: s.listRun.done + 1 } } : {})),
    );
    const run = get().listRun;
    const ran = run?.done ?? targets.length;
    const stoppedAt = run?.stopping && ran < targets.length ? ran : null;
    set({
      listRun: null,
      status:
        `רשימת פרומפטים: ${ran - failed.length} מתוך ${targets.length} נוצרו` +
        (stoppedAt != null ? ` · נעצרה — ${targets.length - ran} לא הורצו (הלשוניות שלהן מוכנות להרצה)` : ""),
      error: failed.length ? `נכשלו: ${failed.join(" · ")}` : null,
    });
  },

  stopPromptList: () => set((s) => (s.listRun ? { listRun: { ...s.listRun, stopping: true } } : {})),

  async runAllDocs(scope) {
    const st = get();
    // Park the visible tab first, so its live state is in the registry and every run
    // below — including this one's — reads from the same place.
    const docs = st.docs.map((d) =>
      d.id === st.activeDocId ? { id: d.id, slice: extractSlice(st as never) } : d,
    );

    // "current" hands every tab the active tab's mode, prompt, settings AND reference
    // images, so they all do the same thing. References used to stay behind on the theory
    // that they were each image's own material — but "translate these six slides in this
    // lettering" is one instruction, and without the lettering sample five of the six
    // tabs ran a different request from the one on screen.
    const shared =
      scope === "current"
        ? { mode: st.mode, prompt: st.prompt, settings: { ...st.settings }, references: [...st.references] }
        : null;
    // A tab is never handed a snapshot of its own canvas as a reference.
    const sharedFor = (docId: string) =>
      shared ? { ...shared, references: shared.references.filter((r) => r.fromDocId !== docId) } : null;

    const targets: { id: string; name: string }[] = [];
    const skipped: string[] = [];
    for (const d of docs) {
      const name = d.slice.project?.name || "ללא שם";
      const view = shared ? { ...d.slice, ...sharedFor(d.id)! } : d.slice;
      const blocker = docRunBlocker(view);
      if (blocker) skipped.push(`${name} (${RUN_BLOCK_LABEL[blocker]})`);
      else targets.push({ id: d.id, name });
    }

    if (!targets.length) {
      return set({
        docs,
        error: skipped.length
          ? `אין מה להריץ — כל הלשוניות דילגו: ${skipped.join(", ")}`
          : "אין לשוניות עם פרויקט פתוח להרצה",
      });
    }

    // Apply the shared settings for real, so a tab shows them when you switch to it.
    set({ docs });
    if (shared) for (const t of targets) get().commitToDoc(t.id, sharedFor(t.id)!);

    set({
      error: null,
      status: `מריץ ${modeLabel(shared ? st.mode : docs[0].slice.mode)} ב-${targets.length} לשוניות…`,
    });

    // Two at a time. Ten concurrent 4K edits invite rate-limit failures, and they would
    // commit most of the spend before anything could be cancelled.
    const failed = await runTabsInLanes(get, targets, (t) => {
      const m = docView(get(), t.id).mode;
      if (m === "expand") return get().runExpand(st.providerId, st.modelId, t.id);
      if (m === "ratio") return get().runRatio(st.providerId, st.modelId, t.id);
      return get().generate({ docId: t.id });
    });

    // One line for the whole run. Nine separate errors overwriting each other told the
    // user nothing about what actually happened.
    const done = targets.length - failed.length;
    set({
      status: `הסתיימה הרצה: ${done} הצליחו${failed.length ? `, ${failed.length} נכשלו` : ""}${skipped.length ? `, ${skipped.length} דילגו` : ""}`,
      error: failed.length ? `נכשלו: ${failed.join(" · ")}` : null,
      warning: skipped.length ? `דילגו: ${skipped.join(", ")}` : null,
    });
  },

  async exportAllDocs(format) {
    const st = get();
    const docs = st.docs.map((d) =>
      d.id === st.activeDocId ? { id: d.id, slice: extractSlice(st as never) } : d,
    );
    const withProject = docs.filter((d) => d.slice.project);
    if (!withProject.length) return set({ error: "אין לשוניות עם פרויקט לשמירה" });

    const dir = await window.mbrush.chooseDirectory();
    if (!dir.ok) return set({ error: dir.error ?? "בחירת תיקייה נכשלה" });
    if (!dir.data) return;

    set({ busy: true, status: `שומר ${withProject.length} לשוניות…` });
    const ext = format === "jpeg" ? "jpg" : format;
    const used = new Set<string>();
    let written = 0;
    let burnedAlpha = false;
    const failed: string[] = [];
    try {
      for (const d of withProject) {
        const proj = d.slice.project!;
        try {
          const flat = await flattenLayersHiRes(
            proj.layers,
            proj.canvas.width,
            proj.canvas.height,
            proj.canvas.backgroundColor,
          );
          let out = flat.src;
          if (format !== "png") {
            if (proj.canvas.backgroundColor === TRANSPARENT_BG) burnedAlpha = true;
            out = await convertImage(flat.src, format, 0.92, "#ffffff");
          }
          // Two tabs opened from files of the same name must not overwrite each other.
          const name = uniqueExportName(proj.name, used);
          const res = await window.mbrush.writeImageTo(dir.data, `${name}.${ext}`, out);
          if (res.ok) written++;
          else failed.push(proj.name);
        } catch {
          failed.push(proj.name);
        }
      }
    } finally {
      set({
        busy: false,
        status: `נשמרו ${written} קבצים לתיקייה שנבחרה`,
        warning: [
          burnedAlpha ? "רקע שקוף נצרב בלבן — JPEG/WEBP לא שומרים שקיפות. לשקיפות ייצא PNG." : "",
          failed.length ? `לא נשמרו: ${failed.join(", ")}` : "",
        ].filter(Boolean).join(" · ") || null,
      });
    }
  },

  newFromScratch() {
    const s = get();
    if (s.project && s.dirty) {
      if (!window.confirm("יש שינויים שלא נשמרו. להתחיל יצירה חדשה בכל זאת?")) return;
    }
    set({
      project: null,
      filePath: null,
      dirty: false,
      activeLayerId: null,
      mask: { strokes: [], rects: [], bitmaps: [], inverted: false },
      removeMask: { strokes: [], rects: [], bitmaps: [], inverted: false },
      thumbnails: {},
      past: [],
      future: [],
      mode: "generate",
      prompt: "",
      status: "מצב יצירה — כתוב פרומפט ולחץ הרץ יצירה",
    });
  },

  async openProject() {
    const res = await window.mbrush.openProject();
    if (!res.ok) return set({ error: res.error ?? "פתיחה נכשלה" });
    if (!res.data) return;
    await applyOpenedProject(set, res.data.path, res.data.project);
    await get().loadRecents();
  },

  async openRecent(entry) {
    if (entry.kind !== "image") return get().openProjectByPath(entry.path);
    const res = await window.mbrush.recentsOpenImage(entry.path);
    if (!res.ok || !res.data) return set({ error: res.error ?? "פתיחת התמונה נכשלה" });
    if (get().project) get().newDocTab();
    await get().newProjectFromImage(res.data.name, res.data.dataUrl, { original: res.data.original });
    await get().loadRecents();
  },

  async openProjectByPath(path) {
    const res = await window.mbrush.openProjectPath(path);
    if (!res.ok || !res.data) return set({ error: res.error ?? "פתיחת הפרויקט נכשלה" });
    // Already looking at something? It goes to a tab of its own rather than replacing
    // the work in front of you — which is how parallel projects actually get opened.
    if (get().project) {
      const already = get().docs.find((d) => d.slice.filePath === res.data!.path);
      if (already) {
        get().switchDoc(already.id);
        return;
      }
      get().newDocTab();
    }
    await applyOpenedProject(set, res.data.path, res.data.project);
    await get().loadRecents();
  },

  closeProject() {
    const s = get();
    if (s.project && s.dirty) {
      if (!window.confirm("יש שינויים שלא נשמרו. לסגור את העבודה בכל זאת?")) return;
    }
    // The user chose to close: drop THIS document's recovery slot, and only this one.
    dropAutosave(s.activeDocId, !!(s.project && s.dirty));
    set({
      project: null,
      filePath: null,
      dirty: false,
      activeLayerId: null,
      mask: { strokes: [], rects: [], bitmaps: [], inverted: false },
      removeMask: { strokes: [], rects: [], bitmaps: [], inverted: false },
      thumbnails: {},
      past: [],
      future: [],
      status: "",
    });
    get().loadRecents();
  },

  async loadRecents() {
    const res = await window.mbrush.recentsGet();
    if (res.ok && res.data) set({ recents: res.data });
    void upgradeGalleryThumbs(set);
  },

  async removeRecent(path) {
    const res = await window.mbrush.recentsRemove(path);
    if (res.ok && res.data) set({ recents: res.data });
  },

  async saveProject(saveAs) {
    const { project, filePath } = get();
    if (!project) return;
    // Suggest a meaningful name (from the prompt) when the project still has a
    // generic name — so the save dialog proposes it instead of "פרוייקט חדש".
    const suggested = isGenericName(project.name)
      ? suggestName(project, get().promptHistory, get().prompt)
      : project.name;
    // Embed a small flattened preview into the .mbrush file.
    let toSave: Project = { ...project, name: suggested };
    try {
      const flat = await flattenLayers(
        project.layers,
        project.canvas.width,
        project.canvas.height,
        project.canvas.backgroundColor,
      );
      const thumbnail = await makeGalleryThumb(flat);
      toSave = { ...toSave, thumbnail };
    } catch {
      /* keep without thumbnail */
    }
    const res = await window.mbrush.saveProject(touch(toSave), saveAs ? undefined : filePath ?? undefined);
    if (!res.ok) return set({ error: res.error ?? "שמירה נכשלה" });
    if (res.data) {
      // Adopt the file's name as the project name.
      const named = { ...toSave, name: res.data.name ?? toSave.name };
      set({
        project: named,
        filePath: res.data.path,
        dirty: false,
        status: `נשמר: ${res.data.name ?? toSave.name}`,
      });
      dropAutosave(get().activeDocId); // saved for real — this document's slot is no longer needed
      get().loadRecents();
    }
  },

  async exportFlattened(format = "png") {
    const { project } = get();
    if (!project) return;
    set({ busy: true, status: format === "clipboard" ? "מעתיק ללוח..." : "מייצא תמונה..." });
    try {
      const flat = await flattenLayersHiRes(
        project.layers,
        project.canvas.width,
        project.canvas.height,
        project.canvas.backgroundColor,
      );
      if (format === "clipboard") {
        const res = await window.mbrush.copyImage(flat.src);
        if (!res.ok) set({ error: res.error ?? "ההעתקה נכשלה" });
        else set({ status: `התמונה הועתקה ללוח · ${dims(flat.width, flat.height)}` });
        return;
      }
      // Convert to the requested format (JPEG gets a solid background).
      let out = flat.src;
      let ext = "png";
      if (format === "jpeg" || format === "webp") {
        // JPEG has no alpha channel. Rather than quietly burning a colour behind a
        // transparent project, say what happened.
        if (project.canvas.backgroundColor === TRANSPARENT_BG) {
          set({ warning: "JPEG לא תומך בשקיפות — הרקע נצרב בלבן. לשמירת השקיפות ייצא PNG." });
        }
        out = await convertImage(flat.src, format, 0.92, bgFill(project.canvas.backgroundColor) === "rgba(0,0,0,0)" ? "#ffffff" : project.canvas.backgroundColor!);
        ext = format === "jpeg" ? "jpg" : "webp";
      }
      const rawName = isGenericName(project.name)
        ? suggestName(project, get().promptHistory, get().prompt)
        : project.name;
      // Strip any existing extension so we don't get "name.jpg.png".
      const exportName = rawName.replace(/\.(png|jpe?g|webp|tiff?|bmp|gif|mbrush)$/i, "");
      const res = await window.mbrush.exportImage(out, `${exportName}.${ext}`);
      if (!res.ok) set({ error: res.error ?? "ייצוא נכשל" });
      else if (res.data) set({ status: `התמונה יוצאה (${ext.toUpperCase()}) · ${dims(flat.width, flat.height)}` });
    } catch (e: any) {
      set({ error: e?.message ?? "ייצוא נכשל" });
    } finally {
      set({ busy: false });
    }
  },

  setTool: (t) => set({ tool: t }),
  setZoom: (z) => set({ zoom: Math.max(0.05, Math.min(8, z)) }),
  setPan: (x, y) => set({ panX: x, panY: y }),
  // Bump brushPreviewAt so the canvas shows a live size/feather preview.
  setBrushSize: (n) => set({ brushSize: Math.max(2, Math.min(600, n)), brushPreviewAt: Date.now() }),
  setBrushHardness: (n) => set({ brushHardness: Math.max(0, Math.min(100, n)), brushPreviewAt: Date.now() }),

  async eraseFromActiveLayer(points, size, hardness) {
    const { project, activeLayerId } = get();
    if (!project || !activeLayerId || points.length < 2) return;
    const layer = project.layers.find((l) => l.id === activeLayerId);
    if (!layer) return;
    if (layer.locked) return set({ error: "השכבה נעולה — בטל נעילה כדי למחוק" });
    get().pushHistory();
    try {
      const newSrc = await eraseFromLayer(
        layer.src,
        { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
        points,
        size,
        hardness,
      );
      const thumb = await makeThumbnail(newSrc).catch(() => get().thumbnails[layer.id]);
      set((s) => ({
        project: touch({
          ...project,
          layers: project.layers.map((l) => (l.id === layer.id ? { ...l, src: newSrc } : l)),
        }),
        thumbnails: { ...s.thumbnails, [layer.id]: thumb },
        dirty: true,
      }));
    } catch (e: any) {
      set({ error: e?.message ?? "מחיקה נכשלה" });
    }
  },

  async commitLayerErase(id, src) {
    const { project } = get();
    if (!project) return;
    get().pushHistory();
    const thumb = await makeThumbnail(src).catch(() => get().thumbnails[id]);
    set((s) => ({
      project: touch({
        ...project,
        layers: project.layers.map((l) => (l.id === id ? { ...l, src } : l)),
      }),
      thumbnails: { ...s.thumbnails, [id]: thumb },
      dirty: true,
    }));
  },

  setLayerPosition: (id, x, y) => {
    get().pushHistory();
    set((s) => mutateLayer(s, id, (l) => ({ ...l, x: Math.round(x), y: Math.round(y) })));
  },

  // Manual stretch/resize of a layer (transform handles) for perfect fitting.
  setLayerBox: (id, x, y, width, height) => {
    get().pushHistory();
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    set((s) => mutateLayer(s, id, (l) => ({ ...l, x: Math.round(x), y: Math.round(y), width: w, height: h })));
    set({ status: `השכבה נמתחה ל-${dims(Math.max(2, Math.round(width)), Math.max(2, Math.round(height)))}` });
  },

  // Auto-scale a layer to the canvas: "fit" = contain (whole layer visible),
  // "fill" = cover (no gaps). Keeps the layer's pixel aspect; centers it.
  async fitLayerToCanvas(id, mode) {
    const { project } = get();
    const layer = project?.layers.find((l) => l.id === id);
    if (!project || !layer) return;
    const cw = project.canvas.width;
    const ch = project.canvas.height;
    const dims = await imageSize(layer.src).catch(() => ({ width: layer.width, height: layer.height }));
    const aspect = dims.width / dims.height;
    const canvasAspect = cw / ch;
    // contain → scale to the smaller axis; cover → scale to the larger axis.
    const fitToWidth = mode === "fill" ? aspect < canvasAspect : aspect > canvasAspect;
    const w = fitToWidth ? cw : Math.round(ch * aspect);
    const h = fitToWidth ? Math.round(cw / aspect) : ch;
    get().pushHistory();
    set((s) =>
      mutateLayer(s, id, (l) => ({
        ...l,
        x: Math.round((cw - w) / 2),
        y: Math.round((ch - h) / 2),
        width: w,
        height: h,
        // Manual fit overrides any stored alignment offset.
        metadata: l.metadata ? { ...l.metadata, alignMatrix: undefined } : l.metadata,
      })),
    );
    set({ status: mode === "fill" ? "השכבה הותאמה למילוי הקנבס" : "השכבה הותאמה לקנבס" });
  },

  nudgeActiveLayer: (dx, dy) => {
    const { activeLayerId, project } = get();
    if (!activeLayerId || !project) return;
    const l = project.layers.find((x) => x.id === activeLayerId);
    if (!l || l.locked) return;
    get().pushHistory();
    set((s) => mutateLayer(s, activeLayerId, (ly) => ({ ...ly, x: ly.x + dx, y: ly.y + dy })));
  },

  toggleShowMask: () => set((s) => ({ showMask: !s.showMask })),
  toggleCompare: () => set((s) => ({ compare: !s.compare })),

  toggleLayerSelected: (id) =>
    set((s) => {
      const selectedLayerIds = s.selectedLayerIds.includes(id)
        ? s.selectedLayerIds.filter((x) => x !== id)
        : [...s.selectedLayerIds, id];
      // Leaving fewer than 2 mosaic-eligible layers exits the mosaic view.
      const mosaic =
        s.mosaic && s.project ? getMosaicLayers(s.project.layers, selectedLayerIds).length >= 2 : false;
      return { selectedLayerIds, mosaic };
    }),
  clearLayerSelection: () => set({ selectedLayerIds: [], mosaic: false }),
  setHoveredLayer: (id) => set({ hoveredLayerId: id }),
  toggleMosaic: () =>
    set((s) => {
      if (s.mosaic) return { mosaic: false, hoveredLayerId: null };
      if (!s.project || getMosaicLayers(s.project.layers, s.selectedLayerIds).length < 2) return {};
      return { mosaic: true };
    }),
  restackLayers: () => {
    const { project } = get();
    if (!project || project.layers.length === 0) return;
    get().pushHistory();
    const { width: cw, height: ch } = project.canvas;
    const layers = project.layers.map((l) => ({
      ...l,
      x: Math.round((cw - l.width) / 2),
      y: Math.round((ch - l.height) / 2),
      // Clear any non-destructive align offset so the centered box is WYSIWYG.
      metadata: l.metadata ? { ...l.metadata, alignMatrix: undefined } : l.metadata,
    }));
    set({ project: touch({ ...project, layers }), dirty: true, status: "השכבות סודרו במרכז הקנבס" });
  },

  addStroke: (stroke) => {
    get().pushHistory();
    set((s) => ({ mask: { ...s.mask, strokes: [...s.mask.strokes, stroke] }, dirty: true }));
  },
  addRect: (r) => {
    get().pushHistory();
    set((s) => ({ mask: { ...s.mask, rects: [...s.mask.rects, r] }, dirty: true }));
  },
  // Reposition a marked rectangle (drag-to-place) without resizing it.
  moveRect: (index, x, y) => {
    set((s) => {
      const rects = s.mask.rects.map((r, i) => (i === index ? { ...r, x: Math.round(x), y: Math.round(y) } : r));
      return { mask: { ...s.mask, rects }, dirty: true };
    });
  },
  clearMask: () => {
    get().pushHistory();
    set({ mask: { strokes: [], rects: [], bitmaps: [], inverted: false } });
  },

  // ---- Erase brush ------------------------------------------------------------
  addRemoveStroke: (stroke) => {
    get().pushHistory();
    set((s) => ({ removeMask: { ...s.removeMask, strokes: [...s.removeMask.strokes, stroke] }, dirty: true }));
  },
  clearRemoveMask: () => {
    get().pushHistory();
    set({ removeMask: emptyMask });
  },
  async planErase() {
    const { project, removeMask } = get();
    if (!project || !maskHasContent(removeMask)) return 0;
    return (await eraseAreasFor(removeMask, project.canvas.width, project.canvas.height)).masks.length;
  },
  async runErase(scope) {
    const docId = get().activeDocId;
    const s = get();
    if (!s.project || s.busy || !maskHasContent(s.removeMask)) return;
    const painted = s.removeMask;

    if (scope === "whole") {
      await get().generate({ docId, erase: { mask: painted, whole: true, label: "מוחק את האזורים המסומנים…" } });
      if (!docView(get(), docId).error) get().commitToDoc(docId, { removeMask: emptyMask });
      return;
    }

    const { width, height } = s.project.canvas;
    const { masks } = await eraseAreasFor(painted, width, height);
    const failed: MaskState[] = [];
    let lastError = "";
    for (let i = 0; i < masks.length; i++) {
      const label = masks.length > 1 ? `מוחק אזור ${i + 1} מתוך ${masks.length}…` : "מוחק…";
      await get().generate({ docId, erase: { mask: masks[i], label } });
      // generate() clears the document's error when it starts, so this one is ours.
      const err = docView(get(), docId).error;
      if (err) {
        failed.push(masks[i]);
        lastError = err;
      }
    }
    // Areas that failed stay painted, so a retry runs only them — re-running the areas
    // that worked would pay again for patches already on the canvas.
    get().commitToDoc(docId, {
      removeMask: failed.length
        ? { strokes: [], rects: [], bitmaps: failed.flatMap((m) => m.bitmaps), inverted: false }
        : emptyMask,
      ...(failed.length && masks.length > 1
        ? { error: `${failed.length} מתוך ${masks.length} אזורים לא נמחקו ונשארו מסומנים לניסיון נוסף. ${lastError}` }
        : {}),
    });
  },

  // ---- Explanatory markup -------------------------------------------------
  // Lives beside the layers, never inside them: everything in project.layers ends up
  // in flattenLayers(), which is what feeds the image engine.
  setNoteShape: (noteShape) => set({ noteShape, tool: "note" }),
  setNoteColor: (noteColor) => set({ noteColor }),
  setNoteSize: (n) => set({ noteSize: Math.max(1, Math.min(40, Math.round(n))) }),
  addAnnotation: (a) => {
    const { project } = get();
    if (!project) return;
    get().pushHistory();
    const cur = project.annotations ?? { items: [], visible: true };
    // A pin's number is spent the moment it is handed out, even if the pin is later removed.
    const pinSeq = a.kind === "pin" ? Math.max(cur.pinSeq ?? 0, a.n) : cur.pinSeq;
    set({
      project: {
        ...project,
        annotations: { items: [...cur.items, a], visible: true, ...(pinSeq ? { pinSeq } : {}) },
      },
      dirty: true,
    });
  },
  updateAnnotation: (index, patch) => {
    const { project } = get();
    if (!project?.annotations) return;
    const items = project.annotations.items.map((a, i) => (i === index ? ({ ...a, ...patch } as Annotation) : a));
    set({ project: { ...project, annotations: { ...project.annotations, items } }, dirty: true });
  },
  removeAnnotation: (index) => {
    const { project } = get();
    if (!project?.annotations) return;
    get().pushHistory();
    const items = project.annotations.items.filter((_, i) => i !== index);
    set({ project: { ...project, annotations: { ...project.annotations, items } }, dirty: true });
  },
  // ---- Documents in tabs ---------------------------------------------------
  // A document IS the DocSlice portion of this store. Switching writes the live one
  // back into `docs` and loads the target over the top; nothing else in the store had
  // to learn about tabs.
  newDocTab: () => {
    const st = get();
    const id = st.activeDocId || newDocId();
    const parked = st.docs.some((d) => d.id === id)
      ? st.docs.map((d) => (d.id === id ? { id, slice: extractSlice(st as never) } : d))
      : [...st.docs, { id, slice: extractSlice(st as never) }];
    const fresh = newDocId();
    set({
      docs: [...parked, { id: fresh, slice: initialDoc() }],
      activeDocId: fresh,
      ...initialDoc(),
    });
    // An empty tab shows the gallery: show it as it is now, exports included.
    void get().loadRecents();
  },

  switchDoc: (id) => {
    const st = get();
    if (id === st.activeDocId) return;
    const target = st.docs.find((d) => d.id === id);
    if (!target) return;
    const docs = st.docs.map((d) =>
      d.id === st.activeDocId ? { id: d.id, slice: extractSlice(st as never) } : d,
    );
    set({
      docs: docs.map((d) => (d.id === id ? { id, slice: { ...d.slice, unseen: false } } : d)),
      activeDocId: id,
      ...(target.slice as object),
      unseen: false,
    });
  },

  // ---- Pictures too big to work on whole ---------------------------------------------
  // Opening one asks: shrink it to 4K (as always), or cut a piece out of the original at
  // full resolution. A piece is an ordinary project — every tool works on it — that
  // remembers where it came from, so its export can put it back into a copy of the photo.
  answerLargeImage(choice) {
    const resolve = largeImageResolver;
    largeImageResolver = null;
    set({ largeImageAsk: null });
    resolve?.(choice);
  },
  finishPiecePick(rect) {
    const resolve = piecePickResolver;
    piecePickResolver = null;
    set({ piecePicker: null });
    resolve?.(rect);
  },

  async exportToOriginal(opts) {
    const { project } = get();
    const src = project?.pieceSource;
    if (!project || !src) return;
    if (src.original.missing || !src.original.token) {
      return set({ error: `קובץ המקור לא נמצא (${src.original.path}). קשר אותו מחדש כדי להחזיר את החתיכה.` });
    }
    set({ busy: true, status: "מרכיב את החתיכה בתוך התמונה המקורית…", error: null });
    try {
      const { width: W, height: H } = project.canvas;
      const { rect, original } = src;
      const token = original.token!;
      // The piece exactly at its own size — the original's pixel grid. A layer upscaled
      // inside the piece is brought back to it; the photo's resolution is the photo's.
      const piece = await flattenLayersHiRes(project.layers, W, H, project.canvas.backgroundColor, Math.max(W, H));
      let patch = piece.src;
      const band = Math.max(0, Math.round(opts.band));
      if (band > 0 || opts.matchColor) {
        const geo = blendBand(W, H, band);
        const keep = rectMaskUrl(W, H, geo.keep);
        if (opts.matchColor) {
          // Tone drift measured on the outer band only, against the photo's own pixels
          // there — so a seam disappears without undoing a change made on purpose inside.
          const before = await cropImage(originalUrl(token), rect);
          patch = await applyFillColor(patch, before, keep, DEFAULT_FILL_COLOR).catch(() => patch);
        }
        if (band > 0) patch = await composeFillPatch(patch, keep, W, H, geo.sigma);
      }
      const full = await pasteInto(originalUrl(token), patch, rect, original.width, original.height);
      // Same format as the photo it goes back into; the save dialog opens in its folder
      // under a new name, so overwriting the original is a choice made there, not here.
      const ext = /\.jpe?g$/i.test(original.path) ? "jpg" : /\.webp$/i.test(original.path) ? "webp" : "png";
      const out = ext === "png" ? full : await convertImage(full, ext === "jpg" ? "jpeg" : "webp", 0.95, "#ffffff");
      const dir = original.path.replace(/[^/\\]+$/, "");
      const base = original.path.slice(dir.length).replace(/\.[^.]+$/, "");
      const res = await window.mbrush.exportImage(out, `${dir}${base}-ערוך.${ext}`);
      if (!res.ok) set({ error: res.error ?? "הייצוא נכשל" });
      else if (res.data) set({ status: `נשמר · ${original.width}×${original.height} עם החתיכה במקומה` });
    } catch (e: any) {
      set({ error: e?.message ?? "ההחזרה לקובץ המקורי נכשלה" });
    } finally {
      set({ busy: false });
    }
  },

  async relinkPieceOriginal() {
    const { project } = get();
    const src = project?.pieceSource;
    if (!project || !src) return;
    const res = await window.mbrush.originalRelink();
    if (!res.ok) return set({ error: res.error ?? "קישור המקור נכשל" });
    if (!res.data) return;
    const o = res.data;
    // The same photo, or one that only shares a name: the size has to match, or the piece
    // would land in the wrong place.
    if (o.width !== src.original.width || o.height !== src.original.height) {
      return set({
        error: `הקובץ שנבחר הוא ${o.width}×${o.height}, והמקור של החתיכה היה ${src.original.width}×${src.original.height} — זה לא אותו קובץ.`,
      });
    }
    set({
      project: touch({ ...project, pieceSource: { ...src, original: { ...o, missing: false } } }),
      dirty: true,
      warning: null,
      status: `המקור קושר מחדש · ${o.width}×${o.height}`,
    });
  },

  closeDoc: (id) => {
    const st = get();
    const rest = st.docs.filter((d) => d.id !== id);
    if (!rest.length) return; // never leave the app with no document at all
    // Closing a tab is not undoable, so work that exists nowhere else asks first — the
    // same question closeProject always asked. A clean tab closes as it always did.
    const doc = docView(st, id);
    if (doc.project && (doc.dirty || doc.busy)) {
      const name = doc.project.name || "הלשונית";
      const question = doc.busy
        ? `ב"${name}" רצה עכשיו הרצה. אם הלשונית תיסגר, התוצאה לא תיכנס לפרויקט. לסגור בכל זאת?`
        : `יש שינויים שלא נשמרו ב"${name}". לסגור את הלשונית בכל זאת?`;
      if (!window.confirm(question)) return;
    }
    dropAutosave(id, !!(doc.project && doc.dirty));
    if (id !== st.activeDocId) return set({ docs: rest });
    const idx = st.docs.findIndex((d) => d.id === id);
    const next = rest[Math.min(idx, rest.length - 1)];
    set({ docs: rest, activeDocId: next.id, ...(next.slice as object) });
  },

  commitToDoc: (docId, patch) => {
    const st = get();
    const active = !docId || docId === st.activeDocId;
    const parked = active ? null : st.docs.find((d) => d.id === docId);
    if (!active && !parked) return; // the tab was closed mid-render; drop the result

    // A callback reads the state it is committing INTO — for a parked document that is
    // the app's globals with that document's own fields laid over them, so a patch like
    // `{ ...s.thumbnails }` extends the right document's thumbnails, not the visible one's.
    const view = parked ? ({ ...st, ...parked.slice } as AppState) : st;
    const p = (typeof patch === "function" ? patch(view) : patch) as Record<string, unknown>;

    // The active document IS the store, so this stays byte-identical to a plain set().
    if (active) return set(p as Partial<AppState>);

    // Parked: document fields go into its slice, everything else — spend, timings — is
    // the app's and still applies now.
    const docPart: Record<string, unknown> = {};
    const globalPart: Record<string, unknown> = {};
    const isDocKey = new Set<string>(DOC_KEYS as readonly string[]);
    for (const [k, v] of Object.entries(p)) (isDocKey.has(k) ? docPart : globalPart)[k] = v;
    set((cur) => ({
      ...(globalPart as Partial<AppState>),
      docs: cur.docs.map((d) =>
        d.id === docId ? { id: d.id, slice: { ...d.slice, ...docPart, unseen: true } as DocSlice } : d,
      ),
    }));
  },

  toggleCanvasTransparent: () => {
    const { project } = get();
    if (!project) return;
    const now = project.canvas.backgroundColor;
    const next = now === TRANSPARENT_BG ? "#ffffff" : TRANSPARENT_BG;
    get().pushHistory();
    set({
      project: { ...project, canvas: { ...project.canvas, backgroundColor: next } },
      dirty: true,
      status: next === TRANSPARENT_BG ? "רקע הקנבס שקוף — ייצוא PNG ישמור את השקיפות" : "רקע הקנבס לבן",
    });
  },

  setSkillRun: (run) => {
    const { project } = get();
    if (!project) return;
    set({ project: { ...project, skillRun: run }, dirty: true });
  },

  clearAnnotations: () => {
    const { project } = get();
    if (!project?.annotations?.items.length) return;
    get().pushHistory();
    set({
      // The pin counter survives: a "📍2" still in the prompt must not match the next pin.
      project: { ...project, annotations: { items: [], visible: true, pinSeq: project.annotations.pinSeq } },
      dirty: true,
      status: "הסימונים נמחקו",
    });
  },
  toggleAnnotations: () => {
    const { project } = get();
    if (!project?.annotations) return;
    set({
      project: { ...project, annotations: { ...project.annotations, visible: !project.annotations.visible } },
      dirty: true,
    });
  },
  invertMask: () => {
    get().pushHistory();
    set((s) => ({ mask: { ...s.mask, inverted: !s.mask.inverted } }));
  },

  rectSquare: false,
  toggleRectSquare: () => set((s) => ({ rectSquare: !s.rectSquare })),

  // ---- Smart selection: magic wand + AI segments + element pick ----
  // All selection tools operate on the ACTIVE LAYER only (rendered alone, in
  // doc space) — not on the flattened image.
  wandTolerance: 28,
  segments: null,
  segProxy: null,
  segBusy: false,

  setWandTolerance: (n) => {
    set({ wandTolerance: Math.max(1, Math.min(100, n)) });
    // Live re-selection: re-run the last wand click with the new tolerance so
    // the user SEES the region grow/shrink while dragging the slider.
    const { project } = get();
    const last = wandLast;
    if (!last || !project) return;
    const sel = floodSelect(last.proxy, last.px, last.py, get().wandTolerance);
    const canvas = selectionToCanvas(sel, last.proxy);
    set((s) => {
      const bitmaps = [...s.mask.bitmaps];
      if (last.bitmapIndex < bitmaps.length) bitmaps[last.bitmapIndex] = canvas;
      else bitmaps.push(canvas);
      return { mask: { ...s.mask, bitmaps } };
    });
  },

  async wandSelectAt(x, y) {
    const { project, wandTolerance, activeLayerId } = get();
    const layer = project?.layers.find((l) => l.id === activeLayerId);
    if (!project || !layer) return set({ error: "בחר שכבה פעילה לבחירה" });
    try {
      const proxy = await getLayerProxy(project, layer);
      const { px, py } = toProxyXY(proxy, x, y);
      const sel = floodSelect(proxy, px, py, wandTolerance);
      if (!sel.some((v) => v)) return set({ status: "לחץ על פיקסלים של השכבה הפעילה" });
      const canvas = selectionToCanvas(sel, proxy);
      get().pushHistory();
      set((s) => {
        wandLast = { proxy, px, py, bitmapIndex: s.mask.bitmaps.length };
        return {
          mask: { ...s.mask, bitmaps: [...s.mask.bitmaps, canvas] },
          dirty: true,
          status: "אזור נבחר — גרור את הסובלנות לכוונון חי, או הוסף לחיצות",
        };
      });
    } catch (e: any) {
      set({ error: e?.message ?? "הבחירה נכשלה" });
    }
  },

  async elementSelectAt(x, y) {
    const { project, activeLayerId } = get();
    const layer = project?.layers.find((l) => l.id === activeLayerId);
    if (!project || !layer) return set({ error: "בחר שכבה פעילה לבחירה" });
    set({ segBusy: true, status: "מזהה את האלמנט…" });
    try {
      const proxy = await getLayerProxy(project, layer);
      const { px, py } = toProxyXY(proxy, x, y);
      const { sel, w, h } = await elementSelectAt(proxy, px, py);
      if (!sel.some((v) => v)) {
        return set({ segBusy: false, status: "לא זוהה אלמנט בנקודה הזו — נסה ללחוץ במרכז האובייקט" });
      }
      const canvas = elementToCanvas(sel, w, h, proxy);
      get().pushHistory();
      wandLast = null;
      set((s) => ({
        mask: { ...s.mask, bitmaps: [...s.mask.bitmaps, canvas] },
        dirty: true,
        segBusy: false,
        status: "האלמנט נבחר",
      }));
    } catch (e: any) {
      set({ segBusy: false, error: "זיהוי האלמנט נכשל: " + (e?.message ?? e), status: "" });
    }
  },

  async runSegments() {
    const { project, segBusy, activeLayerId } = get();
    const layer = project?.layers.find((l) => l.id === activeLayerId);
    if (!project || !layer || segBusy) return;
    set({ segBusy: true, status: "מזהה סגמנטים בשכבה הפעילה…" });
    try {
      const proxy = await getLayerProxy(project, layer);
      const result = await segmentProxy(proxy);
      set({ segments: result, segProxy: proxy, segBusy: false, status: "סגמנטים זוהו — לחץ על קטגוריה לבחירה" });
    } catch (e: any) {
      set({ segBusy: false, error: "זיהוי הסגמנטים נכשל: " + (e?.message ?? e), status: "" });
    }
  },

  async deleteSelectedFromActiveLayer() {
    const { project, activeLayerId, mask } = get();
    const layer = project?.layers.find((l) => l.id === activeLayerId);
    if (!project || !layer) return;
    if (layer.locked) return set({ error: "השכבה נעולה — בטל נעילה כדי למחוק" });
    if (!maskHasContent(mask)) return;
    try {
      const maskUrl = rasterizeMask(mask, project.canvas.width, project.canvas.height);
      const src = await eraseMaskedFromLayer(
        layer.src,
        { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
        maskUrl,
      );
      const thumb = await makeThumbnail(src).catch(() => get().thumbnails[layer.id]);
      get().pushHistory();
      set((s) => ({
        project: touch({
          ...project,
          layers: project.layers.map((l) => (l.id === layer.id ? { ...l, src } : l)),
        }),
        thumbnails: thumb ? { ...s.thumbnails, [layer.id]: thumb } : s.thumbnails,
        dirty: true,
        status: "האזור המסומן נמחק מהשכבה (⌘Z לביטול)",
      }));
    } catch (e: any) {
      set({ error: e?.message ?? "מחיקת האזור נכשלה" });
    }
  },

  selectSegmentClass(classId) {
    const { segments, segProxy, project } = get();
    if (!segments || !segProxy || !project) return;
    // Stale guard: segments belong to the doc they were computed on.
    if (segProxy.docW !== project.canvas.width || segProxy.docH !== project.canvas.height) {
      return set({ segments: null, segProxy: null, error: "התמונה השתנתה — הרץ זיהוי סגמנטים מחדש" });
    }
    const canvas = segmentsToCanvas(segments, [classId], segProxy);
    get().pushHistory();
    wandLast = null;
    set((s) => ({
      mask: { ...s.mask, bitmaps: [...s.mask.bitmaps, canvas] },
      dirty: true,
      status: "הסגמנט נוסף לבחירה",
    }));
  },

  async rotateCanvas(clockwise) {
    const { project } = get();
    if (!project) return;
    set({ busy: true, status: "מסובב פריים..." });
    try {
      get().pushHistory();
      const W = project.canvas.width;
      const H = project.canvas.height;
      const layers = await Promise.all(
        project.layers.map(async (l) => {
          const src = await rotateImage90(l.src, clockwise);
          const x = clockwise ? H - (l.y + l.height) : l.y;
          const y = clockwise ? l.x : W - (l.x + l.width);
          return { ...l, src, x, y, width: l.height, height: l.width };
        }),
      );
      const thumbs: Record<string, string> = {};
      for (const l of layers) {
        try {
          thumbs[l.id] = await makeThumbnail(l.src);
        } catch {
          /* ignore */
        }
      }
      set((s) => ({
        project: touch({ ...project, canvas: { ...project.canvas, width: H, height: W }, layers }),
        thumbnails: thumbs,
        mask: { strokes: [], rects: [], bitmaps: [], inverted: false },
        removeMask: { strokes: [], rects: [], bitmaps: [], inverted: false },
        dirty: true,
        busy: false,
        status: "הפריים סובב",
        zoom: fitZoom(H, W),
        panX: 0,
        panY: 0,
      }));
    } catch (e: any) {
      set({ error: e?.message ?? "סיבוב נכשל", busy: false, status: "" });
    }
  },

  setActiveLayer: (id) => set({ activeLayerId: id }),

  toggleVisible: (id) =>
    set((s) => mutateLayer(s, id, (l) => ({ ...l, visible: !l.visible }))),
  toggleLock: (id) => set((s) => mutateLayer(s, id, (l) => ({ ...l, locked: !l.locked }))),
  setOpacity: (id, v) => set((s) => mutateLayer(s, id, (l) => ({ ...l, opacity: v }))),
  setBlend: (id, b) => set((s) => mutateLayer(s, id, (l) => ({ ...l, blendMode: b }))),
  renameLayer: (id, name) => set((s) => mutateLayer(s, id, (l) => ({ ...l, name }))),

  async duplicateLayer(id) {
    const { project } = get();
    if (!project) return;
    const idx = project.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    get().pushHistory();
    const orig = project.layers[idx];
    const copy: Layer = { ...orig, id: uuid(), name: `${orig.name} עותק` };
    const layers = [...project.layers];
    layers.splice(idx + 1, 0, copy);
    const thumb = await makeThumbnail(copy.src).catch(() => get().thumbnails[id]);
    set((s) => ({
      project: touch({ ...project, layers }),
      activeLayerId: copy.id,
      dirty: true,
      thumbnails: { ...s.thumbnails, [copy.id]: thumb },
    }));
  },

  async addImageLayer(src, name) {
    const { project } = get();
    if (!project) return;
    const fit = await downscaleToMax(src, 4096); // cap added layers at 4K too
    if (fit.changed) src = fit.src;
    const { width, height } = await imageSize(src);
    // Limit: an added layer must match the canvas (source) aspect ratio, so the
    // composition stays consistent and aligned. Reject off-ratio images.
    const canvasAspect = project.canvas.width / project.canvas.height;
    const newAspect = width / height;
    if (Math.abs(newAspect - canvasAspect) / canvasAspect > 0.02) {
      return set({
        error: `השכבה לא נוספה — יחס הצלעות חייב להתאים למקור. הקנבס ${dims(project.canvas.width, project.canvas.height)}, התמונה ${dims(width, height)}. חתוך/התאם אותה ליחס הזה ונסה שוב.`,
      });
    }
    get().pushHistory();
    const id = uuid();
    const layer: Layer = {
      id,
      name: (name ? name.replace(/\.[^.]+$/, "") : "") || "שכבת תמונה",
      type: "base",
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: "normal",
      x: 0,
      y: 0,
      width,
      height,
      src,
      metadata: { createdAt: new Date().toISOString() },
    };
    const thumb = await makeThumbnail(src).catch(() => undefined);
    set((s) => ({
      project: touch({
        ...project,
        canvas: {
          ...project.canvas,
          width: Math.max(project.canvas.width, width),
          height: Math.max(project.canvas.height, height),
        },
        layers: [...project.layers, layer],
      }),
      activeLayerId: id,
      dirty: true,
      thumbnails: thumb ? { ...s.thumbnails, [id]: thumb } : s.thumbnails,
      status: `נוספה שכבה · ${dims(width, height)}`,
    }));
  },

  deleteLayer: (id) => {
    const s = get();
    if (!s.project) return;
    if (s.project.layers.length <= 1) return set({ error: "לא ניתן למחוק את השכבה האחרונה" });
    get().pushHistory();
    const removed = s.project.layers.find((l) => l.id === id);
    let layers = s.project.layers.filter((l) => l.id !== id);
    let canvas = s.project.canvas;
    // Deleting an expand/ratio layer restores the frame it grew.
    const fb = removed?.metadata?.frameBefore;
    const fs = removed?.metadata?.frameShift;
    const fk = removed?.metadata?.frameScale ?? 1;
    const grewFrame = removed?.metadata?.mode === "expand" || removed?.metadata?.mode === "ratio";
    if (fb && (canvas.width !== fb.width || canvas.height !== fb.height)) {
      // Precise: restore the exact pre-grow frame + reverse the scale/shift applied to
      // the siblings when this layer was created.
      canvas = { ...canvas, width: fb.width, height: fb.height };
      if (fk !== 1 || (fs && (fs.x || fs.y))) {
        const ox = fs?.x ?? 0;
        const oy = fs?.y ?? 0;
        layers = layers.map((l) => ({
          ...l,
          x: Math.round((l.x - ox) / fk),
          y: Math.round((l.y - oy) / fk),
          width: Math.round(l.width / fk),
          height: Math.round(l.height / fk),
        }));
      }
    } else if (grewFrame && layers.length) {
      // Fallback (layers from before frameBefore existed): fit the canvas to the
      // remaining content so the leftover empty margin disappears.
      const minX = Math.min(...layers.map((l) => l.x));
      const minY = Math.min(...layers.map((l) => l.y));
      const maxX = Math.max(...layers.map((l) => l.x + l.width));
      const maxY = Math.max(...layers.map((l) => l.y + l.height));
      const nW = Math.round(maxX - minX);
      const nH = Math.round(maxY - minY);
      if (nW > 0 && nH > 0 && (nW < canvas.width || nH < canvas.height || minX !== 0 || minY !== 0)) {
        layers = layers.map((l) => ({ ...l, x: l.x - minX, y: l.y - minY }));
        canvas = { ...canvas, width: nW, height: nH };
      }
    }
    const selectedLayerIds = s.selectedLayerIds.filter((x) => x !== id);
    set({
      project: touch({ ...s.project, canvas, layers }),
      activeLayerId: layers[layers.length - 1]?.id ?? null,
      selectedLayerIds,
      hoveredLayerId: s.hoveredLayerId === id ? null : s.hoveredLayerId,
      mosaic: s.mosaic ? getMosaicLayers(layers, selectedLayerIds).length >= 2 : false,
      dirty: true,
    });
  },

  moveLayer: (id, dir) => {
    const s = get();
    if (!s.project) return;
    const layers = [...s.project.layers];
    const i = layers.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= layers.length) return;
    get().pushHistory();
    [layers[i], layers[j]] = [layers[j], layers[i]];
    set({ project: touch({ ...s.project, layers }), dirty: true });
  },

  // Flatten all visible layers into one. "new" = add the flattened result as a
  // new top layer (keep originals); "replace" = collapse everything to one layer.
  async flattenAll(mode) {
    const { project } = get();
    if (!project) return;
    const visible = project.layers.filter((l) => l.visible);
    if (visible.length === 0) return set({ error: "אין שכבות גלויות לשטח" });
    set({ busy: true, status: "משטח שכבות…" });
    try {
      const flat = await flattenLayers(project.layers, project.canvas.width, project.canvas.height, "rgba(0,0,0,0)");
      const merged: Layer = {
        id: uuid(),
        name: "שכבה משוטחת",
        type: "base",
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: "normal",
        x: 0,
        y: 0,
        width: project.canvas.width,
        height: project.canvas.height,
        src: flat,
        metadata: { createdAt: new Date().toISOString() },
      };
      const thumb = await makeThumbnail(flat).catch(() => undefined);
      get().pushHistory();
      const layers = mode === "replace" ? [merged] : [...project.layers, merged];
      set((s) => ({
        project: touch({ ...project, layers }),
        activeLayerId: merged.id,
        dirty: true,
        busy: false,
        thumbnails: thumb ? { ...s.thumbnails, [merged.id]: thumb } : s.thumbnails,
        status: mode === "replace" ? "כל השכבות שוטחו לשכבה אחת" : "נוצרה שכבה משוטחת מעל הכל",
      }));
    } catch (e: any) {
      set({ busy: false, error: e?.message ?? "השטחה נכשלה", status: "" });
    }
  },

  async mergeDown(id) {
    const { project } = get();
    if (!project) return;
    const i = project.layers.findIndex((l) => l.id === id);
    if (i <= 0) return set({ error: "אין שכבה מתחת למיזוג" });
    get().pushHistory();
    const top = project.layers[i];
    const bottom = project.layers[i - 1];
    const flat = await flattenLayers([bottom, top], project.canvas.width, project.canvas.height, "rgba(0,0,0,0)");
    const merged: Layer = {
      ...bottom,
      id: uuid(),
      name: bottom.name,
      x: 0,
      y: 0,
      width: project.canvas.width,
      height: project.canvas.height,
      src: flat,
    };
    const layers = [...project.layers];
    layers.splice(i - 1, 2, merged);
    const thumb = await makeThumbnail(flat).catch(() => undefined);
    set((s) => ({
      project: touch({ ...project, layers }),
      activeLayerId: merged.id,
      dirty: true,
      thumbnails: thumb ? { ...s.thumbnails, [merged.id]: thumb } : s.thumbnails,
    }));
  },

  async exportLayer(id) {
    const { project } = get();
    const layer = project?.layers.find((l) => l.id === id);
    if (!layer) return;
    // For a fill layer, export the raw generated crop (original output) rather than
    // the composited overlay with its transparent margins and feathered edges.
    const src = layer.metadata?.fillSrc ?? layer.src;
    const cleanName = layer.name.replace(/\.(png|jpe?g|webp|tiff?|bmp|gif)$/i, "");
    const res = await window.mbrush.exportImage(src, `${cleanName}.png`);
    if (!res.ok) set({ error: res.error ?? "ייצוא נכשל" });
  },

  setProvider: (id) => {
    const p = get().providers.find((x) => x.id === id);
    // Upscale-only engines (e.g. Crystal) can't do other modes — snap to upscale.
    const upscaleOnly =
      !!p?.capabilities.supportsUpscale && !p.capabilities.supportsRecreate && !p.capabilities.supportsInpainting;
    // Generate-only engines (e.g. Grok) can't touch existing images — snap to יצירה.
    const generateOnly =
      !!p &&
      !p.capabilities.supportsUpscale &&
      !p.capabilities.supportsRecreate &&
      !p.capabilities.supportsInpainting;
    const modelId = p?.models[0]?.id ?? get().modelId;
    // Persist so the choice (and any auto-switch) sticks across modes/sessions.
    localStorage.setItem("mbrush.providerId", id);
    localStorage.setItem("mbrush.modelId", modelId);
    set({
      providerId: id,
      modelId,
      ...(upscaleOnly && get().mode !== "upscale" ? { mode: "upscale" as GenerationMode } : {}),
      ...(generateOnly && get().mode !== "generate" ? { mode: "generate" as GenerationMode } : {}),
    });
  },
  setModel: (id) => {
    localStorage.setItem("mbrush.modelId", id);
    set({ modelId: id });
  },
  setMode: (m) => set({ mode: m }),
  /** Pick a mode the way the mode buttons do: an engine that can't run it is
   *  swapped for one that can (setProvider FIRST — it can overwrite the mode —
   *  then setMode). Returns the switch kind so the caller can notify. */
  pickMode: (m) => {
    const s = get();
    const p = s.providers.find((x) => x.id === s.providerId);
    const upscaleOnly =
      !!p?.capabilities.supportsUpscale &&
      !p.capabilities.supportsRecreate &&
      !p.capabilities.supportsInpainting;
    const generateOnly =
      !!p &&
      !p.capabilities.supportsUpscale &&
      !p.capabilities.supportsRecreate &&
      !p.capabilities.supportsInpainting;
    if (m !== "upscale" && upscaleOnly) {
      get().setProvider("nano-banana");
      set({ mode: m });
      return "upscale" as const;
    }
    if (m !== "generate" && generateOnly) {
      get().setProvider("nano-banana");
      set({ mode: m });
      return "genonly" as const;
    }
    set({ mode: m });
    return null;
  },
  setPrompt: (p) => set({ prompt: p }),

  addReference: async (src, role = DEFAULT_REF_ROLE, from) => {
    // The tab it is being added to, fixed before the await: the user may switch tabs
    // while a large file is being resized.
    const docId = get().activeDocId;
    const fit = await downscaleToMax(src, REF_MAX_EDGE).catch(() => ({ src }));
    const ref: ReferenceImage = {
      id: uuid(),
      src: fit.src,
      role,
      ...(from ? { fromDocId: from.docId, fromName: from.name } : {}),
    };
    get().commitToDoc(docId, (s) => ({ references: [...s.references, ref] }));
  },
  removeReference: (id) => set((s) => ({ references: s.references.filter((r) => r.id !== id) })),
  setReferenceRole: (id, role) =>
    set((s) => ({ references: s.references.map((r) => (r.id === id ? { ...r, role } : r)) })),
  setReferenceNote: (id, note) =>
    set((s) => ({ references: s.references.map((r) => (r.id === id ? { ...r, note } : r)) })),
  addReferenceFromDoc: async (docId) => {
    const snap = await docCanvasSnapshot(get(), docId);
    if (!snap) return set({ error: "אין בלשונית הזאת קנבס לצלם" });
    await get().addReference(snap.src, DEFAULT_REF_ROLE, { docId, name: snap.name });
  },
  refreshReference: async (id) => {
    const ref = get().references.find((r) => r.id === id);
    if (!ref?.fromDocId) return;
    const target = get().activeDocId;
    const snap = await docCanvasSnapshot(get(), ref.fromDocId);
    if (!snap) return set({ error: `הלשונית "${ref.fromName ?? ""}" כבר לא פתוחה — הייחוס נשאר כפי שצולם.` });
    const fit = await downscaleToMax(snap.src, REF_MAX_EDGE).catch(() => ({ src: snap.src }));
    get().commitToDoc(target, (s) => ({
      references: s.references.map((r) => (r.id === id ? { ...r, src: fit.src, fromName: snap.name } : r)),
      status: `הייחוס עודכן מהלשונית "${snap.name}"`,
    }));
  },

  updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  applyLayerParams: (id) => {
    const m = get().project?.layers.find((l) => l.id === id)?.metadata;
    if (!m) return;
    set({ ...recipePatch(get(), m), status: "פרמטרי הג'נרוט שוחזרו לפקדים" });
  },

  // ---- Crash recovery ----
  recovery: null,
  async restoreAutosave() {
    const slots = get().recovery?.slots ?? [];
    const failed: string[] = [];
    let first: string | null = null;
    let restored = 0;
    // Every slot comes back as a tab of its own: oldest first, so the newest ends up last
    // in the tab row and the first one restored is the one shown.
    for (const slot of [...slots].reverse()) {
      const res = await window.mbrush.autosaveLoad(slot.id);
      if (!res.ok || !res.data) {
        failed.push(slot.name || slot.id);
        continue;
      }
      const { project, originalPath } = res.data;
      const thumbs: Record<string, string> = {};
      for (const l of project.layers) {
        try {
          thumbs[l.id] = await makeThumbnail(l.src);
        } catch {
          /* ignore */
        }
      }
      // Never over work that is already open.
      if (get().project || get().busy) get().newDocTab();
      set({
        project,
        filePath: originalPath,
        dirty: true,
        activeLayerId: project.layers[project.layers.length - 1]?.id ?? null,
        mask: { strokes: [], rects: [], bitmaps: [], inverted: false },
        removeMask: { strokes: [], rects: [], bitmaps: [], inverted: false },
        thumbnails: thumbs,
        past: [],
        future: [],
        zoom: fitZoom(project.canvas.width, project.canvas.height),
        panX: 0,
        panY: 0,
      });
      const id = get().activeDocId;
      first ??= id;
      restored++;
      // The slot moves to this tab's id BEFORE the old one goes, so a crash in between
      // leaves the work in two slots rather than in none.
      const moved = await window.mbrush.autosaveWrite(project, originalPath, id);
      if (moved.ok) {
        autosaveWritten.set(id, project);
        if (slot.id !== id) await window.mbrush.autosaveClear(slot.id);
      }
    }
    if (first && first !== get().activeDocId) get().switchDoc(first);
    set({
      recovery: null,
      status:
        restored > 1
          ? `${restored} עבודות שוחזרו מהשמירה האוטומטית, כל אחת בלשונית — שמור (⌘S) כדי לקבע`
          : restored === 1
            ? "העבודה שוחזרה מהשמירה האוטומטית — שמור (⌘S) כדי לקבע"
            : "",
      error: failed.length ? `השחזור נכשל עבור: ${failed.join(" · ")}` : null,
    });
  },
  dismissRecovery: () => {
    // Declined: the slots that were OFFERED go — by name, not "all of them". Work started
    // in this session before answering has slots of its own by now, and they stay.
    for (const slot of get().recovery?.slots ?? []) void window.mbrush.autosaveClear(slot.id, true);
    set({ recovery: null });
  },

  // ---- Generation history ----
  applyJobParams: (jobId) => {
    const j = get().project?.jobs.find((x) => x.id === jobId);
    if (!j) return;
    set({ ...recipePatch(get(), j), status: "פרמטרי הג'נרוט שוחזרו לפקדים — הרץ כשתהיה מוכן" });
  },

  async downscaleLayer(id) {
    const { project } = get();
    const layer = project?.layers.find((l) => l.id === id);
    if (!project || !layer) return;
    const fit = await downscaleToMax(layer.src, 4096);
    if (!fit.changed) return set({ status: "השכבה כבר בגודל 4K או קטן ממנו" });
    const thumb = await makeThumbnail(fit.src).catch(() => get().thumbnails[id]);
    get().pushHistory();
    // Keep the layer's on-canvas box; only the pixel resolution shrinks.
    set((s) => ({
      ...mutateLayer(s, id, (l) => ({ ...l, src: fit.src })),
      thumbnails: thumb ? { ...s.thumbnails, [id]: thumb } : s.thumbnails,
      status: `השכבה הוקטנה ל-${fit.width}×${fit.height} (מקס׳ 4K)`,
    }));
  },

  setLayerAlign(id, matrix, score) {
    const { project } = get();
    if (!project?.layers.some((l) => l.id === id)) return;
    get().pushHistory();
    set((s) =>
      mutateLayer(s, id, (l) => ({
        ...l,
        metadata: { ...l.metadata!, alignMatrix: matrix, alignScore: matrix ? score : undefined },
      })),
    );
    set({ status: matrix ? "היישור הוחל" : "היישור בוטל" });
  },

  // Directional generative expand: the original layer stays as the AXIS; each
  // chosen side is its own generation, composed as a feathered patch layer that
  // overlaps the original. Both-sides → two patches; one side → one patch.
  async runExpand(providerId, modelId, forDocId) {
    // The document this run belongs to: by the time the engine answers it may not be
    // the visible one, so every commit below goes through commitToDoc.
    const docId = forDocId ?? get().activeDocId;
    // Reads come from the tab this run is FOR, which may not be the visible one.
    const { project, prompt, settings } = docView(get(), docId);
    if (!project) return get().commitToDoc(docId, { error: "אין פרויקט פתוח" });
    const W = project.canvas.width;
    const H = project.canvas.height;
    const dir = String(settings.expandDir ?? "right");
    const amount = Math.max(5, Math.min(100, Number(settings.expandAmount ?? 50)));
    const featherPct = Math.max(0, Math.min(40, Number(settings.fillFeatherPct ?? 6)));

    const sideLabel = (s: ExpandSide) =>
      ({ left: "שמאלה", right: "ימינה", up: "למעלה", down: "למטה" } as Record<string, string>)[s];
    const sides: ExpandSide[] =
      dir === "horizontal" ? ["left", "right"] : dir === "vertical" ? ["up", "down"] : [dir as ExpandSide];
    const marginX = Math.round(W * (amount / 100));
    const marginY = Math.round(H * (amount / 100));
    const marginFor = (s: ExpandSide) => (s === "left" || s === "right" ? marginX : marginY);

    const hasLeft = sides.includes("left"), hasUp = sides.includes("up");
    const offX = hasLeft ? marginX : 0;
    const offY = hasUp ? marginY : 0;
    const W2 = W + (sides.includes("left") ? marginX : 0) + (sides.includes("right") ? marginX : 0);
    const H2 = H + (hasUp ? marginY : 0) + (sides.includes("down") ? marginY : 0);

    genWallStart = performance.now();
    // Keep any warning set just before us (e.g. the auto-switch to a mask engine).
    get().commitToDoc(docId, { busy: true, error: null, status: "מרחיב…", genStartedAt: Date.now() });
    try {
      const comp = await flattenLayers(project.layers, W, H, project.canvas.backgroundColor);
      // A downscaled, flattened view of the WHOLE image being expanded — sent as a
      // reference so the model understands the wider scene it's continuing from.
      const contextRef = await makeThumbnail(comp, 1024).catch(() => null);

      let totalCost = 0;
      const newLayers: Layer[] = [];
      const newThumbs: Record<string, string> = {};
      const jobs: any[] = [];

      for (const side of sides) {
        const margin = marginFor(side);
        get().commitToDoc(docId, { status: `מרחיב ${sideLabel(side)}…` });
        // Cut a model-friendly "piece" (context strip + WHITE empty area) from the
        // growing edge; ANY model fills the white. The engine returns it at the SAME
        // size/aspect (no distortion), then we drop the piece back over its region.
        const built = await buildExpandSide(comp, side, margin);
        const res = await window.mbrush.generate({
          providerId,
          modelId,
          mode: "expand",
          // Only the user's own text — the fixed base expand prompt lives in the provider.
          prompt: prompt?.trim() || undefined,
          image: built.extended,
          references: contextRef
            ? [{ src: contextRef, role: "composition" as ReferenceRole, note: "full-image context" }]
            : [],
          settings: { ...settings, outputWidth: built.rw, outputHeight: built.rh },
        });
        if (!res.ok || !res.data) {
          return get().commitToDoc(docId, { busy: false, error: res.error ?? "ההרחבה נכשלה", status: "", genStartedAt: null });
        }
        const out = res.data.images[0];
        totalCost += res.data.metadata?.costEstimate ?? 0;

        // Feather only the inner edge (the one meeting the rest of the original).
        const feather = Math.max(2, Math.round(margin * (featherPct / 100)));
        const piece = await composeExpandPiece(out.src, built.innerEdge, built.placeBox, feather);

        const layerId = uuid();
        const jobId = uuid();
        newLayers.push({
          id: layerId,
          name: `הרחבה ${sideLabel(side)} · ${new Date().toLocaleTimeString("he-IL")}`,
          type: "fill",
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: "normal",
          x: piece.box.x,
          y: piece.box.y,
          width: piece.box.w,
          height: piece.box.h,
          src: piece.src,
          metadata: {
            createdAt: new Date().toISOString(),
            mode: "expand",
            providerId,
            modelId,
            generationJobId: jobId,
            prompt: prompt || undefined,
            frameBefore: { width: W, height: H },
            frameShift: { x: offX, y: offY },
            expandRaw: piece.raw,
            expandEdge: built.innerEdge,
            expandFeather: feather,
            expandMargin: margin,
          },
        });
        const t = await makeThumbnail(piece.src).catch(() => undefined);
        if (t) newThumbs[layerId] = t;
        jobs.push({
          id: jobId,
          timestamp: new Date().toISOString(),
          providerId,
          modelId,
          sourceWidth: W,
          sourceHeight: H,
          prompt: prompt || undefined,
          referenceIds: [],
          mode: "expand" as const,
          settings,
          outputLayerId: layerId,
          requestId: res.data.metadata?.requestId,
          costEstimate: res.data.metadata?.costEstimate,
          status: "succeeded" as const,
        });
      }

      let newTotal = get().totalSpend;
      let newEntries = get().spendEntries;
      if (totalCost > 0) {
        const sp = await window.mbrush.spendAdd(totalCost, { providerId, modelId, mode: "expand" });
        if (sp.ok && sp.data) {
          newTotal = sp.data.total;
          newEntries = sp.data.entries;
          get().commitToDoc(docId, { spendMonths: sp.data.months ?? {} });
        }
      }

      get().pushHistory(docId);
      get().recordGenTime(providerId, "expand", performance.now() - genWallStart);
      // The run's own project, re-read now — not the one that happens to be on screen.
      const cur = docView(get(), docId).project!;
      // Shift existing layers so the original sits as the centered axis.
      const shifted = cur.layers.map((l) => ({ ...l, x: l.x + offX, y: l.y + offY }));
      get().commitToDoc(docId, (s) => ({
        project: touch({
          ...cur,
          canvas: { ...cur.canvas, width: W2, height: H2 },
          layers: [...shifted, ...newLayers],
          jobs: [...cur.jobs, ...jobs],
        }),
        activeLayerId: newLayers[newLayers.length - 1].id,
        thumbnails: { ...s.thumbnails, ...newThumbs },
        dirty: true,
        busy: false,
        genStartedAt: null,
        totalSpend: newTotal,
        spendEntries: newEntries,
        sessionSpend: s.sessionSpend + totalCost,
        genCount: s.genCount + sides.length,
        status: `הורחב (${sides.length} ${sides.length > 1 ? "צדדים" : "צד"}) · ${dims(W2, H2)}${totalCost > 0 ? ` · עלות מוערכת ${usd(totalCost)}` : ""}`,
      }));
    } catch (e: any) {
      get().commitToDoc(docId, { busy: false, error: e?.message ?? "ההרחבה נכשלה", status: "", genStartedAt: null });
    }
  },

  // Format / aspect-ratio change: grow the frame to a target ratio (always
  // generative, never crop) and add ONE whole layer on top covering the new frame.
  async runRatio(providerId, modelId, forDocId) {
    // The document this run belongs to: by the time the engine answers it may not be
    // the visible one, so every commit below goes through commitToDoc.
    const docId = forDocId ?? get().activeDocId;
    // Reads come from the tab this run is FOR, which may not be the visible one.
    const { project, prompt, settings } = docView(get(), docId);
    if (!project) return get().commitToDoc(docId, { error: "אין פרויקט פתוח" });
    const W = project.canvas.width;
    const H = project.canvas.height;
    const target = String(settings.ratioTarget ?? "16:9");
    const [aw, ah] = target.split(":").map(Number);
    const ta = aw / ah;
    if (!isFinite(ta) || ta <= 0) return get().commitToDoc(docId, { error: "בחר יחס יעד" });
    if (Math.abs(ta - W / H) / (W / H) < 0.01) {
      return get().commitToDoc(docId, { status: `התמונה כבר ביחס ${target} — בחר יחס אחר` });
    }

    genWallStart = performance.now();
    // Keep any warning set just before us (e.g. the auto-switch to a mask engine).
    get().commitToDoc(docId, { busy: true, error: null, status: `משנה פורמט ל-${target}…`, genStartedAt: Date.now() });
    try {
      const comp = await flattenLayers(project.layers, W, H, project.canvas.backgroundColor);
      const contextRef = await makeThumbnail(comp, 768).catch(() => null);
      // The app sizes the reformatted frame itself (the engine's return is cover-cropped
      // to it), so this one control governs every engine.
      const ratioLong = Number(settings.ratioLongEdge) || 4096;
      const provider = get().providers.find((p) => p.id === providerId);
      const maskCapable = !!provider?.capabilities.supportsMasks;

      // Prompt is optional — only the user's extra text; the provider always prepends
      // the fixed ratio base prompt (RATIO_BASE_PROMPT).
      const usePrompt = prompt?.trim() || undefined;
      let finalSrc: string;
      let W2: number, H2: number;
      let res: Awaited<ReturnType<typeof window.mbrush.generate>>;

      if (maskCapable) {
        // umage2: send the original centered on an extended canvas + a margin mask so
        // the model regenerates a naturally wider/taller version. The model may resize
        // and reposition the subject for harmony, so we USE ITS OUTPUT DIRECTLY (no
        // paste-back) — just cover-cropped to the exact target ratio.
        const built = await buildExpand(comp, ta, ratioLong);
        if (!built) {
          return get().commitToDoc(docId, { busy: false, error: "התמונה כבר ביחס הזה — בחר יחס אחר", status: "", genStartedAt: null });
        }
        res = await window.mbrush.generate({
          providerId,
          modelId,
          mode: "ratio",
          prompt: usePrompt,
          image: built.extended,
          mask: built.mask,
          references: contextRef
            ? [{ src: contextRef, role: "composition" as ReferenceRole, note: "full-image context" }]
            : [],
          settings: { ...settings, outputWidth: built.W2, outputHeight: built.H2 },
        });
        if (!res.ok || !res.data) {
          return get().commitToDoc(docId, { busy: false, error: res.error ?? "שינוי הפורמט נכשל", status: "", genStartedAt: null });
        }
        finalSrc = await coverImage(res.data.images[0].src, built.W2, built.H2);
        W2 = built.W2;
        H2 = built.H2;
      } else {
        // Native reframe (Nano Banana / Gemini): masks aren't honored, so we send the
        // bare image + TARGET aspect and let Gemini extend the scene to the new frame.
        // Its output IS the new whole layer (no paste-back compositing).
        res = await window.mbrush.generate({
          providerId,
          modelId,
          mode: "ratio",
          prompt: usePrompt,
          image: comp,
          references: contextRef
            ? [{ src: contextRef, role: "composition" as ReferenceRole, note: "full-image context" }]
            : [],
          settings: { ...settings, aspectRatio: target },
        });
        if (!res.ok || !res.data) {
          return get().commitToDoc(docId, { busy: false, error: res.error ?? "שינוי הפורמט נכשל", status: "", genStartedAt: null });
        }
        const out = res.data.images[0];
        // Exact target dims: grow the deficient axis from the source, cap the long
        // edge at 4096, then cover-crop the model's output to them.
        if (ta > W / H) {
          H2 = H;
          W2 = Math.round(H * ta);
        } else {
          W2 = W;
          H2 = Math.round(W / ta);
        }
        const longEdge = Math.max(W2, H2);
        if (longEdge > ratioLong) {
          const k = ratioLong / longEdge;
          W2 = Math.round(W2 * k);
          H2 = Math.round(H2 * k);
        }
        finalSrc = await coverImage(out.src, W2, H2);
      }
      const cost = res.data.metadata?.costEstimate ?? 0;

      // Map the existing layers from the old frame into the new one: scale uniformly
      // to fit (the new frame may be shorter/narrower after the 4K cap) and center, so
      // they sit fully UNDER the new full layer instead of poking out.
      const fscale = Math.min(W2 / W, H2 / H);
      const offX = Math.round((W2 - W * fscale) / 2);
      const offY = Math.round((H2 - H * fscale) / 2);

      let newTotal = get().totalSpend;
      let newEntries = get().spendEntries;
      if (cost > 0) {
        const sp = await window.mbrush.spendAdd(cost, { providerId, modelId, mode: "ratio" });
        if (sp.ok && sp.data) {
          newTotal = sp.data.total;
          newEntries = sp.data.entries;
          get().commitToDoc(docId, { spendMonths: sp.data.months ?? {} });
        }
      }

      const layerId = uuid();
      const jobId = uuid();
      const thumb = await makeThumbnail(finalSrc).catch(() => undefined);
      const layer: Layer = {
        id: layerId,
        name: `פורמט ${target} · ${new Date().toLocaleTimeString("he-IL")}`,
        type: "generated",
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: "normal",
        x: 0,
        y: 0,
        width: W2,
        height: H2,
        src: finalSrc,
        metadata: {
          createdAt: new Date().toISOString(),
          mode: "ratio",
          providerId,
          modelId,
          generationJobId: jobId,
          prompt: prompt || undefined,
          frameBefore: { width: W, height: H },
          frameShift: { x: offX, y: offY },
          frameScale: fscale,
        },
      };
      const job = {
        id: jobId,
        timestamp: new Date().toISOString(),
        providerId,
        modelId,
        sourceWidth: W,
        sourceHeight: H,
        prompt: prompt || undefined,
        referenceIds: [],
        mode: "ratio" as const,
        settings,
        outputLayerId: layerId,
        requestId: res.data.metadata?.requestId,
        costEstimate: res.data.metadata?.costEstimate,
        status: "succeeded" as const,
      };

      get().pushHistory(docId);
      get().recordGenTime(providerId, "ratio", performance.now() - genWallStart);
      const cur = docView(get(), docId).project!;
      // Scale + center existing layers into the new frame so they sit fully under the
      // new full layer (not poking out when it's shorter/narrower after the 4K cap).
      const shifted = cur.layers.map((l) => ({
        ...l,
        x: Math.round(offX + l.x * fscale),
        y: Math.round(offY + l.y * fscale),
        width: Math.round(l.width * fscale),
        height: Math.round(l.height * fscale),
      }));
      get().commitToDoc(docId, (s) => ({
        project: touch({
          ...cur,
          canvas: { ...cur.canvas, width: W2, height: H2 },
          layers: [...shifted, layer],
          jobs: [...cur.jobs, job],
        }),
        activeLayerId: layerId,
        thumbnails: thumb ? { ...s.thumbnails, [layerId]: thumb } : s.thumbnails,
        dirty: true,
        busy: false,
        genStartedAt: null,
        totalSpend: newTotal,
        spendEntries: newEntries,
        sessionSpend: s.sessionSpend + cost,
        genCount: s.genCount + 1,
        status: `פורמט שונה ל-${target} · ${dims(W2, H2)}${cost > 0 ? ` · עלות מוערכת ${usd(cost)}` : ""}`,
      }));
    } catch (e: any) {
      set({ busy: false, error: e?.message ?? "שינוי הפורמט נכשל", status: "", genStartedAt: null });
    }
  },

  async adjustFillLayer(id, corr, feather, opts) {
    const { project } = get();
    const layer = project?.layers.find((l) => l.id === id);
    const m = layer?.metadata;
    if (!project || !layer || !m?.fillSrc || !m.fillRef || !m.fillMask || !m.fillBox) {
      return set({ error: "לשכבה זו אין נתוני מילוי לכוונון" });
    }
    const quiet = !!opts?.quiet;
    if (!quiet) set({ busy: true, status: "מחיל תיקון צבע…" });
    try {
      const f = feather ?? m.fillFeather ?? Math.max(2, Math.round(Math.min(m.fillBox.w, m.fillBox.h) * 0.02));
      const corrected = await applyFillColor(m.fillSrc, m.fillRef, m.fillMask, corr);
      // The stored mask is at the patch's own pixel size (canvas size on older layers),
      // so it says which density to rebuild at.
      const patch = fillPatchSize(m.fillBox, (await imageSize(m.fillMask)).width);
      const src = await composeFillPatch(corrected, m.fillMask, patch.w, patch.h, f * patch.density);
      const thumb = await makeThumbnail(src).catch(() => get().thumbnails[id]);
      if (opts?.recordHistory !== false) get().pushHistory();
      const cur = get().project;
      if (!cur) return;
      set((s) => ({
        project: touch({
          ...cur,
          layers: cur.layers.map((l) =>
            l.id === id
              ? { ...l, src, metadata: { ...l.metadata!, fillColor: { ...corr }, fillFeather: f } }
              : l,
          ),
        }),
        thumbnails: thumb ? { ...s.thumbnails, [id]: thumb } : s.thumbnails,
        dirty: true,
        ...(quiet ? {} : { busy: false, status: "תיקון הצבע הוחל" }),
      }));
    } catch (e: any) {
      set({ ...(quiet ? {} : { busy: false, status: "" }), error: e?.message ?? "תיקון הצבע נכשל" });
    }
  },

  async adjustExpandLayer(id, feather, opts) {
    const { project } = get();
    const layer = project?.layers.find((l) => l.id === id);
    const m = layer?.metadata;
    if (!project || !layer || !m?.expandRaw || !m.expandEdge) {
      return set({ error: "לשכבה זו אין נתוני הרחבה לכוונון" });
    }
    const quiet = !!opts?.quiet;
    if (!quiet) set({ busy: true, status: "מכוונן נוצה…" });
    try {
      const f = Math.max(0, Math.round(feather));
      const src = await featherEdge(m.expandRaw, m.expandEdge as InnerEdge, f);
      const thumb = await makeThumbnail(src).catch(() => get().thumbnails[id]);
      if (opts?.recordHistory !== false) get().pushHistory();
      const cur = get().project;
      if (!cur) return;
      set((s) => ({
        project: touch({
          ...cur,
          layers: cur.layers.map((l) =>
            l.id === id ? { ...l, src, metadata: { ...l.metadata!, expandFeather: f } } : l,
          ),
        }),
        thumbnails: thumb ? { ...s.thumbnails, [id]: thumb } : s.thumbnails,
        dirty: true,
        ...(quiet ? {} : { busy: false, status: "הנוצה עודכנה" }),
      }));
    } catch (e: any) {
      set({ ...(quiet ? {} : { busy: false, status: "" }), error: e?.message ?? "כוונון הנוצה נכשל" });
    }
  },

  async generate(opts) {
    // The document this run belongs to: by the time the engine answers it may not be
    // the visible one, so every commit below goes through commitToDoc.
    //
    // opts.docId lets a run be started FOR a tab that is not on screen (the run-all
    // button). The reads below then have to come from that tab's parked slice, not from
    // whatever happens to be visible — the same view commitToDoc writes back into.
    const docId = opts?.docId ?? get().activeDocId;
    const state = docView(get(), docId);
    const erase = opts?.erase;
    const { project, settings } = state;
    // The erase brush borrows the fill (or recreate) pipeline for one run without touching
    // what the dock says: its own mode, its own fixed prompt, its own mask, and none of
    // the reference shelf — style references are an invitation to put something back.
    const mode: GenerationMode = erase ? (erase.whole ? "recreate" : "fill") : state.mode;
    const prompt = erase ? (erase.whole ? "" : ERASE_FILL_PROMPT) : state.prompt;
    const mask = erase ? erase.mask : state.mask;
    const references = erase ? [] : state.references;
    // Session budget cap: hard stop before spending more.
    if (state.budgetCap > 0 && state.sessionSpend >= state.budgetCap) {
      return get().commitToDoc(docId, {
        error: `הגעת לתקרת התקציב להפעלה ($${state.budgetCap.toFixed(2)}). העלה את התקרה בפירוט ההוצאות (לחיצה על המונה בסרגל העליון) כדי להמשיך.`,
      });
    }
    let providerId = state.providerId;
    let modelId = state.modelId;
    let provider = state.providers.find((p) => p.id === providerId);
    // The UI may explicitly redirect this run to another engine (e.g. user agreed
    // to switch a large Reve upscale to umage2). Reflect it in the top bar too.
    if (opts?.overrideProviderId && opts.overrideProviderId !== providerId) {
      const ov = state.providers.find((p) => p.id === opts.overrideProviderId);
      if (ov) {
        providerId = ov.id;
        modelId = ov.models[0]?.id ?? modelId;
        provider = ov;
        get().commitToDoc(docId, { providerId, modelId });
      }
    }
    if (!provider) return get().commitToDoc(docId, { error: "ספק לא זמין" });
    if (provider.requiresApiKey && !state.configuredKeys.includes(providerId)) {
      return get().commitToDoc(docId, { onboarding: true, error: "נדרש מפתח API. הזן אותו במסך ההגדרות." });
    }
    // Background removal needs a real alpha channel from the engine. Refusing here with
    // the reason beats spending on a run that comes back on a white plate.
    if (mode === "removebg" && !canRemoveBackground(provider, modelId)) {
      return get().commitToDoc(docId, {
        error: `המנוע ${provider.name} לא מחזיר רקע שקוף במודל הזה. עבור ל-umage2 עם ${TRANSPARENT_CAPABLE_MODEL} כדי להסיר רקע.`,
      });
    }

    // The erase brush runs on whatever engine is selected. The only real limit is an engine
    // that cannot do the edit at all (an upscaler).
    if (erase && !(erase.whole ? provider.capabilities?.supportsRecreate : provider.capabilities?.supportsInpainting)) {
      return get().commitToDoc(docId, { error: `${provider.name} לא יכול למחוק אובייקטים — בחר מנוע עריכה.` });
    }
    // Every erase is shown a copy of the image with the areas painted over: the brush
    // shape is amorphous and what the engine receives is its bounding rectangle, so the
    // marks are the only thing that says which part of that box to clear. An engine that
    // also takes a mask gets one, as a second, exact hint.
    if (erase) modelId = eraseModelFor(providerId, modelId, provider.models);
    const eraseMask = !!erase && !!provider.capabilities?.supportsMasks;

    // Pins: "📍1 make it asphalt" becomes coordinates the engine can place. Recreate only —
    // it is the one mode whose input is the whole canvas at its own framing, which is what
    // the percentages are measured against. Anywhere else the emoji would go out raw.
    let sendPrompt = prompt;
    let pinEdit = false;
    if (!erase && pinTagsIn(prompt).length) {
      if (mode !== "recreate") {
        return get().commitToDoc(docId, {
          error: "סיכות פועלות במצב יצירה מחדש בלבד. עבור ליצירה מחדש, או הסר את תגי ה-📍 מהפרומפט.",
        });
      }
      if (project) {
        const { width: cw, height: ch } = project.canvas;
        const expanded = expandPinTags(prompt, pinsOf(project.annotations?.items), cw, ch);
        if (expanded.missing.length) {
          const list = expanded.missing.join(", ");
          return get().commitToDoc(docId, {
            error: expanded.missing.length === 1 ? `סיכה ${list} לא קיימת על הקנבס.` : `הסיכות ${list} לא קיימות על הקנבס.`,
          });
        }
        sendPrompt = expanded.text;
        pinEdit = expanded.used.length > 0;
      }
    }

    // Generative expand is a dedicated multi-patch flow (one generation per side).
    if (mode === "expand") return get().runExpand(providerId, modelId);
    // Format/aspect change = one full-canvas outpaint → a single whole layer on top.
    if (mode === "ratio") return get().runRatio(providerId, modelId);

    // References: tell the engine what each one is FOR. The role used to stop at the main
    // process — nothing read it — so a slide attached as a typography sample came back as
    // the output. The text goes in front of the user's own, numbered in the order every
    // engine sends the images: the picture being worked on first, then these.
    // Text-to-image has no picture of its own, so there the references start at 1.
    const hasSource = mode !== "generate";
    // Slots the app needs for itself: the source, and fill's view of the whole picture.
    const reservedImages = (hasSource ? 1 : 0) + (mode === "fill" ? 1 : 0);
    const sentRefs = referencesThatFit(references, provider.capabilities?.maxReferenceImages, reservedImages);
    const refWarning =
      sentRefs.length < references.length
        ? `${provider.name} מקבל עד ${sentRefs.length} תמונות ייחוס בהרצה כזאת — ${references.length - sentRefs.length} האחרונות לא נשלחו.`
        : null;
    const guide = referenceGuide(sentRefs, { hasSource });
    if (guide) sendPrompt = `${guide}\n${sendPrompt}`.trim();

    // A generate with no prompt has nothing to ask for. This used to be checked only on
    // the no-project branch, so with a project open an empty request went to the engine
    // and came back as a paid failure.
    if (mode === "generate" && !prompt.trim()) {
      return get().commitToDoc(docId, { error: "כתוב פרומפט ליצירה" });
    }

    // Generate from scratch (text-to-image, no project open) → creates a new project.
    if (mode === "generate" && !project) {
      genWallStart = performance.now();
      get().commitToDoc(docId, { busy: true, error: null, warning: refWarning, status: `מריץ יצירה דרך ${provider.name}...`, genStartedAt: Date.now() });
      try {
        const nVar = Math.min(3, Math.max(1, Number(settings.variations) || 1));
        const res = await runWithVariants(
          {
            providerId,
            modelId,
            mode: "generate",
            prompt: sendPrompt || undefined,
            references: sentRefs.map((r) => ({ src: r.src, role: r.role, note: r.note })),
            settings: { ...settings },
          },
          nVar,
          set,
        );
        if (res.cancelled) return get().commitToDoc(docId, { busy: false, status: "הבחירה בוטלה", genStartedAt: null });
        if (!res.ok || !res.data) return get().commitToDoc(docId, { error: res.error ?? "היצירה נכשלה", busy: false, status: "", genStartedAt: null });
        const out = res.data.images[0];
        const w = out.width || 1024;
        const h = out.height || 1024;
        const layerId = uuid();
        const jobId = uuid();
        const cost = res.data.metadata?.costEstimate ?? 0;
        let newTotal = get().totalSpend;
        let newEntries = get().spendEntries;
        if (cost > 0) {
          const sp = await window.mbrush.spendAdd(cost, { providerId, modelId, mode: "generate" });
          if (sp.ok && sp.data) {
            newTotal = sp.data.total;
            newEntries = sp.data.entries;
            get().commitToDoc(docId, { spendMonths: sp.data.months ?? {} });
          }
        }
        const now = new Date().toISOString();
        const baseLayer: Layer = {
          id: layerId,
          name: `יצירה · ${new Date().toLocaleTimeString("he-IL")}`,
          type: "generated",
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: "normal",
          x: 0,
          y: 0,
          width: w,
          height: h,
          src: out.src,
          metadata: {
            createdAt: now,
            mode: "generate",
            providerId,
            modelId,
            generationJobId: jobId,
            prompt: prompt || undefined,
            referenceIds: references.map((r) => r.id),
            settings: { ...settings },
          },
        };
        const proj: Project = {
          id: uuid(),
          name: opts?.projectName || "יצירה חדשה",
          createdAt: now,
          updatedAt: now,
          canvas: { width: w, height: h, backgroundColor: "#ffffff" },
          layers: [baseLayer],
          references: [],
          promptHistory: prompt ? [{ id: uuid(), text: prompt, mode: "generate", createdAt: now }] : [],
          jobs: [
            {
              id: jobId,
              timestamp: now,
              providerId,
              modelId,
              prompt: prompt || undefined,
              referenceIds: references.map((r) => r.id),
              mode: "generate",
              settings: { ...settings },
              outputLayerId: layerId,
              requestId: res.data.metadata?.requestId,
              costEstimate: res.data.metadata?.costEstimate,
              status: "succeeded",
            },
          ],
          settings: { defaultProviderId: providerId, autosave: false },
        };
        const thumb = await makeThumbnail(out.src).catch(() => undefined);
        const ph = prompt ? [prompt, ...state.promptHistory.filter((x) => x !== prompt)].slice(0, 25) : state.promptHistory;
        get().commitToDoc(docId, (s) => ({
          project: proj,
          filePath: null,
          dirty: true,
          activeLayerId: layerId,
          mask: { strokes: [], rects: [], bitmaps: [], inverted: false },
          removeMask: { strokes: [], rects: [], bitmaps: [], inverted: false },
          thumbnails: thumb ? { [layerId]: thumb } : {},
          zoom: fitZoom(w, h),
          panX: 0,
          panY: 0,
          past: [],
          future: [],
          busy: false,
          status: `נוצרה תמונה · ${dims(w, h)}${cost > 0 ? ` · עלות מוערכת ${usd(cost)}` : ""}`,
          totalSpend: newTotal,
          spendEntries: newEntries,
          sessionSpend: s.sessionSpend + cost,
          genCount: s.genCount + 1,
          promptHistory: ph,
          genStartedAt: null,
        }));
        get().recordGenTime(providerId, mode, performance.now() - genWallStart);
      } catch (e: any) {
        get().commitToDoc(docId, { error: e?.message ?? "שגיאה לא צפויה", busy: false, status: "", genStartedAt: null });
      }
      return;
    }

    if (!project) return get().commitToDoc(docId, { error: "אין פרויקט פתוח" });
    if (mode === "fill" && !maskHasContent(mask)) {
      return get().commitToDoc(docId, { error: "מילוי גנרטיבי דורש סימון אזור עם המסכה" });
    }

    genWallStart = performance.now();
    get().commitToDoc(docId, { busy: true, error: null, warning: null, status: erase?.label ?? "מכין נתונים...", genStartedAt: Date.now() });
    try {
      const { width, height } = project.canvas;
      let warning: string | null = refWarning;
      const image = await flattenLayers(project.layers, width, height, project.canvas.backgroundColor);

      let sendImage = image;
      // Recreate/upscale rebuild the whole frame, so feed them the layers' real pixels
      // rather than the canvas-sized flatten — a 4K layer in a 2K project was being sent
      // downsampled, capping the result no matter which output resolution was asked for.
      // `image` stays canvas-sized: fill's crop maths and the upscale alignment step are
      // both in canvas coordinates.
      //
      // The cap is on BYTES, not pixels, because PNG size depends on content: the same
      // 4096px frame encodes to 23MB as a photograph and 38MB as fine detail. Past ~10MB
      // the upload dies in transit and the SDK reports a bare "Connection error" with no
      // hint of the cause, so we stay well inside that. A rough-textured image simply
      // gets sent a little smaller than a smooth one.
      if (mode === "recreate" || mode === "upscale" || mode === "removebg") {
        let hi = await flattenLayersHiRes(project.layers, width, height, project.canvas.backgroundColor, HI_SEND_EDGE);
        if (hi.width > width) {
          let bytes = dataUrlBytes(hi.src);
          if (bytes > MAX_SEND_BYTES) {
            // PNG size tracks pixel count closely enough to land in one more attempt.
            const k = Math.sqrt(MAX_SEND_BYTES / bytes);
            const edge = Math.max(width, height, Math.floor(Math.max(hi.width, hi.height) * k));
            hi = await flattenLayersHiRes(project.layers, width, height, project.canvas.backgroundColor, edge);
            bytes = dataUrlBytes(hi.src);
          }
          // Still too heavy, or no longer bigger than the canvas: the canvas-sized
          // flatten is the safe answer, and a failed generation helps nobody.
          if (hi.width > width && bytes <= MAX_SEND_BYTES) sendImage = hi.src;
        }
      }
      let sendMask: string | undefined;
      let fillBox: Box | null = null;
      let fullMaskUrl: string | undefined;
      let contextRef: string | null = null;
      /** The erase areas painted onto the image, for an engine that takes no mask. */
      let eraseMarkRef: string | null = null;
      const reqSettings: GenerationSettings = { ...settings };

      // A recreate that carries pins is an edit: every engine swaps its "recreate faithfully"
      // base for an edit prompt on this flag (shared/erasePrompts.ts).
      if (pinEdit) reqSettings.pinEdit = true;

      if (erase?.whole) {
        // Same guards as a background removal: the point is to change the marked areas and
        // nothing else. The flag swaps the engine's recreate base prompt for the erase one.
        reqSettings.eraseObjects = true;
        reqSettings.preserveIdentity = true;
        reqSettings.preserveGeometry = true;
        reqSettings.preserveColor = true;
      }

      if (mode === "removebg") {
        // The mode IS these settings — it must not depend on what the controls happened
        // to be left on in another mode.
        reqSettings.transparentBackground = true;
        reqSettings.preserveIdentity = true;
        reqSettings.preserveGeometry = true;
        reqSettings.preserveColor = true;
      }

      if (mode === "fill") {
        // Generate ONLY the masked region. We crop its bounding box (plus a
        // context margin) from the source, then UPSCALE that crop to a working
        // resolution before sending — so a tiny selection is treated purely as
        // *content* to edit, never limited by its pixel count. The result is
        // scaled back into the same box, which stays put on the canvas.
        fullMaskUrl = rasterizeMask(mask, width, height);
        const tight = await maskBounds(fullMaskUrl, width, height);
        if (!tight) {
          return get().commitToDoc(docId, { error: "לא נמצא אזור מסומן", busy: false, status: "", genStartedAt: null });
        }
        // A rectangle is a precise instrument: it is sent exactly as drawn, so the size
        // shown in its corner is the size the model works at. Adding the usual ~14%
        // context would push a 1024 mark to 1310 and bring it back resampled. A brush or
        // wand selection has no such promise to keep and still gets its context.
        const rectOnly = mask.rects.length > 0 && !mask.strokes.length && !mask.bitmaps.length;
        fillBox = fillBoxFor(tight, width, height, rectOnly);

        // The crop comes from the layers' real pixels, not the canvas-sized flatten. Over
        // a ×2 upscale the flatten holds half the detail of the layer under the mark, and
        // the model was being sent that half, blown back up to the working size.
        const region = await flattenRegionHiRes(project.layers, fillBox, project.canvas.backgroundColor);

        // The generation size follows the marked area by default — its real pixels, so the
        // patch comes back at the density of what it covers. A size picked in the dock
        // overrides that, for a rectangle as much as for a brush.
        const longEdge = fillLongEdgeFor(region.width, region.height, settings.fillLongEdge);
        const ws = workingSize(region.width, region.height, longEdge);
        // Send the region+context as the image to EDIT IN PLACE — no mask to
        // the model, so it modifies the real content instead of filling a hole.
        // The mask is used only to composite the masked area back afterwards.
        sendImage = await cropRegionResized(
          region.src,
          { x: 0, y: 0, w: region.width, h: region.height },
          ws.w,
          ws.h,
        );
        // An ordinary fill edits the crop in place with no mask. Erasing is different: "the
        // thing in the middle" is a guess, and an engine that takes a mask can be told
        // exactly which pixels to remove. The composite back uses the mask either way.
        sendMask = eraseMask ? await cropRegionResized(fullMaskUrl, fillBox, ws.w, ws.h) : undefined;
        if (erase) {
          eraseMarkRef = await cropRegionResized(await paintMarks(image, fullMaskUrl, width, height), fillBox, ws.w, ws.h);
        }
        reqSettings.outputWidth = ws.w;
        reqSettings.outputHeight = ws.h;
        // Recorded as 0 when it followed the area, so the layer can say so later.
        reqSettings.fillLongEdge = Number(settings.fillLongEdge) || 0;
        // Also send a LOW-RES copy of the whole picture as a reference, so the
        // model understands the crop's context within the full scene (lighting,
        // scale, continuity) instead of seeing an isolated patch.
        contextRef = await makeThumbnail(image, 768).catch(() => null);
      } else {
        // Upscale / recreate / generate. If the user picked a specific aspect
        // ratio, target it; otherwise keep the source framing.
        // The long edge is the user's to choose — it used to be a constant here, which
        // is why recreate could never exceed 2048 however large the project was.
        const srcLong = Math.max(width, height);
        const longEdge =
          mode === "upscale"
            ? Number(settings.upscaleLongEdge) || 3840
            : mode === "recreate"
              ? Number(settings.recreateLongEdge) || srcLong // 0 = כמו המקור
              : mode === "removebg"
                ? Number(settings.removebgLongEdge) || srcLong // default 2048, 0 = כמו המקור
                : 1536;
        const ar = settings.aspectRatio;
        if (ar && ar !== "auto") {
          const [aw, ah] = ar.split(":").map(Number);
          const a = aw / ah;
          if (a >= 1) {
            reqSettings.outputWidth = longEdge;
            reqSettings.outputHeight = Math.round(longEdge / a);
          } else {
            reqSettings.outputHeight = longEdge;
            reqSettings.outputWidth = Math.round(longEdge * a);
          }
        } else if (mode === "recreate" || mode === "upscale" || mode === "removebg") {
          // Keep the source framing exactly, scaled to the requested long edge — so
          // "כמו המקור" reproduces the previous behaviour to the pixel.
          const k = longEdge / srcLong;
          reqSettings.outputWidth = Math.round(width * k);
          reqSettings.outputHeight = Math.round(height * k);
        }
      }

      if (erase?.whole) {
        const areas = rasterizeMask(mask, width, height);
        eraseMarkRef = await paintMarks(image, areas, width, height);
        if (eraseMask) {
          // The mask has to match the image actually sent, which for a recreate can be the
          // layers' own resolution rather than the canvas.
          const sent = await imageSize(sendImage);
          sendMask = await cropRegionResized(areas, { x: 0, y: 0, w: width, h: height }, sent.width, sent.height);
        }
      }

      get().commitToDoc(docId, { status: erase?.label ?? `מריץ ${modeLabel(mode)} דרך ${provider.name}...` });
      // Variations make sense for a look, not for a removal: three patches of the same
      // background, each paid for, is not a choice anybody asked for.
      const nVar = erase ? 1 : Math.min(3, Math.max(1, Number(settings.variations) || 1));
      const res = await runWithVariants(
        {
          providerId,
          modelId,
          mode,
          prompt: sendPrompt || undefined,
          image: sendImage,
          mask: sendMask,
          references: [
            ...sentRefs.map((r) => ({ src: r.src, role: r.role, note: r.note })),
            // The marked copy is "the second image" in the erase prompts: right after the
            // image being edited, and before the fill context.
            ...(eraseMarkRef ? [{ src: eraseMarkRef, role: "composition" as ReferenceRole, note: "erase marks" }] : []),
            // Context ref goes LAST — provider fill prompts refer to "the last reference".
            ...(contextRef
              ? [{ src: contextRef, role: "composition" as ReferenceRole, note: "full-image context" }]
              : []),
          ],
          settings: reqSettings,
        },
        nVar,
        set,
      );

      if (res.cancelled) return get().commitToDoc(docId, { busy: false, status: "הבחירה בוטלה", genStartedAt: null });
      if (!res.ok || !res.data) {
        return get().commitToDoc(docId, { error: res.error ?? "היצירה נכשלה", busy: false, status: "", genStartedAt: null });
      }

      // Every candidate becomes its own layer (variations>1 → no picker). Single-
      // target paths (new project / overwrite) use only the first candidate.
      const results = res.variants && res.variants.length > 1 ? res.variants : [res.data!];
      const singleTarget = !!opts?.asNewProject || !!opts?.overwriteLayerId;

      // Where a whole-frame result lands. Recreate, upscale and background removal are sent
      // the WHOLE canvas flattened, so their result is the whole canvas and belongs on it.
      // It used to be sized into the active layer instead — after a fill, that is a patch,
      // and a full recreate came back shrunk into the patch's corner as an inset.
      // Text-to-image with a project open still anchors to the active layer, which is a
      // choice of where to put a new picture rather than a picture of the canvas.
      const wholeFrame = mode === "recreate" || mode === "upscale" || mode === "removebg";
      const parent = !wholeFrame && state.activeLayerId
        ? project.layers.find((l) => l.id === state.activeLayerId)
        : null;
      const parentBox = parent
        ? { x: parent.x, y: parent.y, width: parent.width, height: parent.height }
        : { x: 0, y: 0, width, height };

      // Turn one engine result into a finished layer + job (conform/align/composite).
      const processOne = async (resData: GenerationResult, idx: number) => {
      const out = resData.images[0];
      let finalSrc = out.src;

      // Conform the result to the SOURCE aspect (default) so an upscale/recreate
      // keeps the exact original shape, instead of the engine's snapped aspect.
      // "model" leaves it as the engine returned it. (Fill is handled below.)
      if (mode !== "fill" && settings.aspectConform !== "model") {
        const conformed = await cropToAspect(out.src, width / height);
        if (conformed !== out.src) {
          finalSrc = conformed;
          const d = await imageSize(conformed);
          out.width = d.width;
          out.height = d.height;
        }
      }

      // Register the upscaled result onto the source so it overlays pixel-perfect.
      // Reference = the source scaled to the result's resolution (keeps it upscaled);
      // a weak match falls back to the unaligned result with a note. (Fill aligns below.)
      if (mode === "upscale" && settings.alignToSource !== false) {
        get().commitToDoc(docId, { status: "מיישר לשכבת המקור…" });
        const refUp = await cropRegionResized(image, { x: 0, y: 0, w: width, h: height }, out.width, out.height);
        const aligned = await alignToReference(finalSrc, refUp);
        if (aligned.ok) finalSrc = aligned.src;
        else warning = "יישור לא ודאי — התוצאה הונחה ללא יישור";
      }

      let lx = 0, ly = 0, lw = width, lh = height;
      // Fill recompute inputs — persisted on the layer so color/feather can be
      // re-adjusted later, non-destructively, from the raw result.
      let fillSrc: string | undefined;
      let fillMaskCrop: string | undefined;
      let fillFeatherVal: number | undefined;
      let alignMatrixVal: { a: number; b: number; c: number; d: number; e: number; f: number } | undefined;
      let alignScoreVal: number | undefined;
      if (mode === "fill" && fillBox && fullMaskUrl) {
        // Edge feather is user-controlled (% of the region's short edge).
        // A rectangle drops in unchanged: no feather unless it is asked for. It stays
        // re-tunable on the layer afterwards, which is where softening a seam belongs.
        const rectFill = mask.rects.length > 0 && !mask.strokes.length && !mask.bitmaps.length;
        // An erase is judged by whether you can see where it happened, so its edge gets a
        // real feather even when the fill slider is sitting low.
        const askedFeather = settings.fillFeatherPct ?? (rectFill ? 0 : 3);
        const fpct = Math.max(0, Math.min(40, erase ? Math.max(askedFeather, 6) : askedFeather)) / 100;
        const feather = Math.max(1, Math.round(Math.min(fillBox.w, fillBox.h) * fpct));
        fillFeatherVal = feather;
        // Conform the model output to the region's aspect (default) so it isn't
        // stretched when scaled back into the box; "model" leaves it as returned.
        const fillResult =
          settings.aspectConform !== "model"
            ? await cropToAspect(out.src, fillBox.w / fillBox.h)
            : out.src;
        fillSrc = fillResult; // raw (pre-color) — the basis for later re-adjustment
        // The patch keeps every pixel the engine returned. It used to be squeezed into
        // fillBox.w × fillBox.h canvas pixels, which over an upscale is less than half
        // the density of the layer it sits on. A layer whose image is denser than its
        // footprint is ordinary here (an upscale is one), so it renders and exports at
        // its own resolution. Never below the canvas, which is where it used to sit.
        const patch = fillPatchSize(fillBox, (await imageSize(fillResult)).width);
        fillMaskCrop = await cropRegionResized(fullMaskUrl, fillBox, patch.w, patch.h);
        // Smart alignment — NON-DESTRUCTIVE: estimate the residual drift using only
        // the stable context OUTSIDE the edited region (mask-weighted), and store
        // the transform as a matrix on the layer (pixels untouched, reversible).
        if (settings.alignToSource !== false && sendImage) {
          get().commitToDoc(docId, { status: "מיישר לפי הסביבה…" });
          const aligned = await alignToReference(fillResult, sendImage, { excludeMask: fillMaskCrop });
          if (aligned.ok && (aligned.matrix.e || aligned.matrix.f || aligned.matrix.a !== 1)) {
            // Convert translation from working-crop px → canvas px (the patch box).
            const rX = fillBox.w / (reqSettings.outputWidth || fillBox.w);
            const rY = fillBox.h / (reqSettings.outputHeight || fillBox.h);
            alignMatrixVal = {
              a: aligned.matrix.a, b: aligned.matrix.b, c: aligned.matrix.c, d: aligned.matrix.d,
              e: aligned.matrix.e * rX, f: aligned.matrix.f * rY,
            };
            alignScoreVal = aligned.score;
          } else if (!aligned.ok) {
            warning = "יישור לא ודאי — הפאץ' הונח ללא יישור";
          }
        }
        // Color correction v2: estimated from context outside the mask; re-tunable.
        let corrected = fillResult;
        try {
          corrected = await applyFillColor(fillResult, sendImage!, fillMaskCrop, DEFAULT_FILL_COLOR);
        } catch {
          /* keep uncorrected result */
        }
        // Patch-sized layer: corrected result masked + feathered, in box space.
        // The feather is kept in canvas pixels (that is what the dialog edits), so it
        // grows with the patch's density to soften the same width on screen.
        finalSrc = await composeFillPatch(corrected, fillMaskCrop, patch.w, patch.h, feather * patch.density);
        lx = fillBox.x; ly = fillBox.y; lw = fillBox.w; lh = fillBox.h;
      } else {
        // Anchor to the parent's top-left, keep the generated aspect by matching
        // the parent's width. If it overflows, the canvas grows below.
        const outAspect = out.width / out.height;
        lw = parentBox.width;
        lh = Math.round(lw / outAspect);
        lx = parentBox.x;
        ly = parentBox.y;
      }

      const layerId = uuid();
      const jobId = uuid();
      const variantTag = results.length > 1 ? ` (${idx + 1})` : "";
      const newLayer: Layer = {
        id: layerId,
        name: `${erase ? "מחיקה" : modeLabel(mode)}${variantTag} · ${new Date().toLocaleTimeString("he-IL")}`,
        type: mode === "fill" ? "fill" : "generated",
        visible: true,
        locked: false,
        // Blend level = how strongly the fill merges with the layer beneath.
        opacity: mode === "fill" ? Math.max(0, Math.min(100, settings.fillBlend ?? 100)) / 100 : 1,
        blendMode: "normal",
        x: lx,
        y: ly,
        width: lw,
        height: lh,
        src: finalSrc,
        metadata: {
          createdAt: new Date().toISOString(),
          sourceLayerId: state.activeLayerId ?? undefined,
          mode,
          providerId,
          modelId,
          generationJobId: jobId,
          prompt: prompt || undefined,
          referenceIds: references.map((r) => r.id),
          settings: reqSettings,
          fillSrc,
          fillRef: mode === "fill" ? sendImage : undefined,
          fillMask: fillMaskCrop,
          fillBox: fillBox ?? undefined,
          fillFeather: fillFeatherVal,
          fillColor: mode === "fill" ? { ...DEFAULT_FILL_COLOR } : undefined,
          alignMatrix: alignMatrixVal,
          alignScore: alignScoreVal,
        },
      };

      const job = {
        id: jobId,
        timestamp: new Date().toISOString(),
        providerId,
        modelId,
        sourceLayerId: state.activeLayerId ?? undefined,
        sourceWidth: width,
        sourceHeight: height,
        prompt: prompt || undefined,
        referenceIds: references.map((r) => r.id),
        mode,
        settings: reqSettings,
        outputLayerId: layerId,
        requestId: resData.metadata?.requestId,
        costEstimate: resData.metadata?.costEstimate,
        costReported: resData.metadata?.costReported,
        status: "succeeded" as const,
      };

      const canvasW = mode === "fill" ? width : Math.max(width, Math.round(lx + lw));
      const canvasH = mode === "fill" ? height : Math.max(height, Math.round(ly + lh));
      const thumb = await makeThumbnail(finalSrc).catch(() => undefined);
      return { out, finalSrc, lx, ly, lw, lh, newLayer, job, layerId, canvasW, canvasH, thumb };
      }; // end processOne

      // Materialize every candidate (single-target paths use only the first).
      const built: Awaited<ReturnType<typeof processOne>>[] = [];
      for (let i = 0; i < (singleTarget ? 1 : results.length); i++) {
        built.push(await processOne(results[i], i));
      }
      const primary = built[0];
      const { out, finalSrc, lx, ly, lw, lh, newLayer, job, layerId, canvasW, canvasH, thumb } = primary;

      // Track spend (estimate) — every candidate was billed; sum them.
      const cost = results.reduce((s, r) => s + (r.metadata?.costEstimate ?? 0), 0);
      let newTotal = get().totalSpend;
      let newEntries = get().spendEntries;
      if (cost > 0) {
        const sp = await window.mbrush.spendAdd(cost, { providerId, modelId, mode });
        if (sp.ok && sp.data) {
          newTotal = sp.data.total;
          newEntries = sp.data.entries;
          get().commitToDoc(docId, { spendMonths: sp.data.months ?? {} });
        }
      }

      // The erase prompt is the app's, not the user's — it has no business in their history.
      const ph = prompt && !erase ? [prompt, ...state.promptHistory.filter((x) => x !== prompt)].slice(0, 25) : state.promptHistory;

      // Open the result as a brand-new project (closing the current one).
      if (opts?.asNewProject) {
        const now = new Date().toISOString();
        const projLayer: Layer = {
          id: layerId,
          name: `${modeLabel(mode)} · ${new Date().toLocaleTimeString("he-IL")}`,
          type: "generated",
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: "normal",
          x: 0,
          y: 0,
          width: out.width,
          height: out.height,
          src: finalSrc,
          metadata: {
            createdAt: now,
            mode,
            providerId,
            modelId,
            generationJobId: job.id,
            prompt: prompt || undefined,
            referenceIds: references.map((r) => r.id),
            settings: reqSettings,
          },
        };
        const proj: Project = {
          id: uuid(),
          name: "פרוייקט חדש",
          createdAt: now,
          updatedAt: now,
          canvas: { width: out.width, height: out.height, backgroundColor: "#ffffff" },
          layers: [projLayer],
          references: [],
          promptHistory: prompt ? [{ id: uuid(), text: prompt, mode, createdAt: now }] : [],
          jobs: [{ ...job, sourceLayerId: undefined }],
          settings: { defaultProviderId: providerId, autosave: false },
        };
        get().commitToDoc(docId, (s) => ({
          project: proj,
          filePath: null,
          dirty: true,
          activeLayerId: layerId,
          mask: { strokes: [], rects: [], bitmaps: [], inverted: false },
          removeMask: { strokes: [], rects: [], bitmaps: [], inverted: false },
          thumbnails: thumb ? { [layerId]: thumb } : {},
          zoom: fitZoom(out.width, out.height),
          panX: 0,
          panY: 0,
          past: [],
          future: [],
          busy: false,
          warning,
          status: `פרוייקט חדש · ${dims(out.width, out.height)}${cost > 0 ? ` · עלות מוערכת ${usd(cost)}` : ""}`,
          promptHistory: ph,
          totalSpend: newTotal,
          spendEntries: newEntries,
          sessionSpend: s.sessionSpend + cost,
          genCount: s.genCount + 1,
          genStartedAt: null,
        }));
        get().recordGenTime(providerId, mode, performance.now() - genWallStart);
        return;
      }

      // Overwrite an existing AI layer in place, or append a new one.
      const overwriteId =
        opts?.overwriteLayerId && mode !== "fill" && project.layers.some((l) => l.id === opts!.overwriteLayerId)
          ? opts!.overwriteLayerId
          : null;

      get().pushHistory();
      get().commitToDoc(docId, (s) => {
        let layers: Layer[];
        let activeId: string;
        let thumbs: Record<string, string>;
        let cw = project.canvas.width;
        let ch = project.canvas.height;
        if (overwriteId) {
          layers = project.layers.map((l) =>
            l.id === overwriteId
              ? { ...l, src: finalSrc, x: lx, y: ly, width: lw, height: lh, metadata: newLayer.metadata }
              : l,
          );
          activeId = overwriteId;
          thumbs = thumb ? { ...s.thumbnails, [overwriteId]: thumb } : s.thumbnails;
          cw = Math.max(cw, Math.round(lx + lw));
          ch = Math.max(ch, Math.round(ly + lh));
        } else {
          // Append every candidate as its own layer (they stack; toggle/compare).
          layers = [...project.layers, ...built.map((b) => b.newLayer)];
          activeId = layerId;
          thumbs = { ...s.thumbnails };
          for (const b of built) if (b.thumb) thumbs[b.newLayer.id] = b.thumb;
          cw = built.reduce((m, b) => Math.max(m, b.canvasW), canvasW);
          ch = built.reduce((m, b) => Math.max(m, b.canvasH), canvasH);
        }
        return {
          project: touch({
            ...project,
            canvas: {
              ...project.canvas,
              width: cw,
              height: ch,
              // The whole point of removing a background is to see through it. Leaving
              // the canvas opaque would show a white plate and read as a failed run.
              backgroundColor: mode === "removebg" ? TRANSPARENT_BG : project.canvas.backgroundColor,
            },
            layers,
            jobs: [...project.jobs, ...(overwriteId ? [job] : built.map((b) => b.job))],
            promptHistory: [
              ...project.promptHistory,
              ...(prompt && !erase ? [{ id: uuid(), text: prompt, mode, createdAt: job.timestamp }] : []),
            ],
          }),
          activeLayerId: activeId,
          thumbnails: thumbs,
          dirty: true,
          busy: false,
          warning,
          status:
            (overwriteId
              ? "השכבה עודכנה"
              : built.length > 1
                ? `נוצרו ${built.length} שכבות (וריאציות)`
                : "נוצרה שכבה חדשה") +
            ` · ${dims(out.width, out.height)}` +
            (cost > 0
              ? results.every((r) => r.metadata?.costReported)
                ? ` · עלות ${usd(cost)}`
                : ` · עלות מוערכת ${usd(cost)}`
              : ""),
          promptHistory: ph,
          totalSpend: newTotal,
          spendEntries: newEntries,
          sessionSpend: s.sessionSpend + cost,
          genCount: s.genCount + 1,
          genStartedAt: null,
          // A finished fill clears the region it filled. An erase run leaves `mask` alone —
          // it never used it — and runErase clears the erase paint itself, area by area.
          mask: mode === "fill" && !erase ? { strokes: [], rects: [], bitmaps: [], inverted: false } : s.mask,
        };
      });
      get().recordGenTime(providerId, mode, performance.now() - genWallStart);
    } catch (e: any) {
      set({ error: e?.message ?? "שגיאה לא צפויה", busy: false, status: "", genStartedAt: null });
    }
  },

  dismissError: () => set({ error: null, warning: null }),
  cancelPendingOpen: () => set({ pendingOpen: null }),
  setOnboarding: (v) => set({ onboarding: v }),
}));

function mutateLayer(s: AppState, id: string, fn: (l: Layer) => Layer): Partial<AppState> {
  if (!s.project) return {};
  const layers = s.project.layers.map((l) => (l.id === id ? fn(l) : l));
  return { project: touch({ ...s.project, layers }), dirty: true };
}

/**
 * The pixel size of a fill patch: the box's shape at the density of an image `pixelW`
 * wide (the engine's result, or a stored mask), never below one image pixel per canvas
 * pixel.
 */
function fillPatchSize(box: Box, pixelW: number): { w: number; h: number; density: number } {
  const density = Math.max(1, pixelW / box.w);
  return { w: Math.max(1, Math.round(box.w * density)), h: Math.max(1, Math.round(box.h * density)), density };
}


// ---- Unsaved work: the main process asks before the window closes ----
let lastUnsaved = -1;
function reportUnsaved(s: AppState) {
  const n = unsavedDocNames(s.docs, s.activeDocId, s).length;
  if (n === lastUnsaved) return;
  lastUnsaved = n;
  window.mbrush?.setUnsaved?.(n);
}
useStore.subscribe(reportUnsaved);
reportUnsaved(useStore.getState()); // a reload starts from zero, and says so

// ---- Autosave: every document with unsaved work keeps its own recovery slot ----
/** The project object last written for each document. Projects are replaced, never
 *  mutated, so "is this the object I wrote" is the whole dirty check. */
const autosaveWritten = new Map<string, unknown>();
/** The project object last SEEN per document — what restarts the debounce. */
const autosaveSeen = new Map<string, unknown>();
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
const AUTOSAVE_DELAY_MS = 2500;

/** A document was saved or closed: its slot has nothing left to protect. `discarded`:
 *  it was closed with unsaved work — a development build keeps that copy aside. */
function dropAutosave(docId: string, discarded = false) {
  autosaveWritten.delete(docId);
  autosaveSeen.delete(docId);
  if (docId) void window.mbrush.autosaveClear(docId, discarded);
}

/** Write every pending recovery slot now, without waiting for the debounce — used when
 *  the interface has crashed and the next thing the user does is reload. */
export async function saveRecoveryNow(): Promise<void> {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  await flushAutosave();
}

async function flushAutosave() {
  autosaveTimer = null;
  const s = useStore.getState();
  for (const d of pendingAutosaves(autosaveDocs(s.docs, s.activeDocId, s), autosaveWritten)) {
    // Marked before the write, so a change that lands while it runs is seen as newer.
    autosaveWritten.set(d.id, d.project);
    const res = await window.mbrush.autosaveWrite(d.project!, d.filePath, d.id).catch(() => null);
    if (!res?.ok && autosaveWritten.get(d.id) === d.project) autosaveWritten.delete(d.id); // try again next time
  }
}

useStore.subscribe((s) => {
  // Restart the wait only when some document's project actually changed: the store also
  // changes on every hover and zoom, and those must not keep pushing the write away.
  let changed = false;
  for (const d of autosaveDocs(s.docs, s.activeDocId, s)) {
    if (autosaveSeen.get(d.id) === d.project) continue;
    autosaveSeen.set(d.id, d.project);
    if (d.project && d.dirty) changed = true;
  }
  if (!changed) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => void flushAutosave(), AUTOSAVE_DELAY_MS);
});

/** Older pictures in the gallery have small, long-side thumbnails. The main process remakes
 *  them square from the picture on disk, a batch at a time, in the background — the list
 *  is on screen already and each batch replaces it as it lands. Projects are not read for
 *  this (a .mbrush can be 100MB); theirs is remade the next time they are opened or saved. */
let upgradingThumbs = false;
async function upgradeGalleryThumbs(set: (partial: Partial<AppState>) => void) {
  if (upgradingThumbs || !window.mbrush.recentsUpgradeThumbs) return;
  upgradingThumbs = true;
  try {
    for (let i = 0; i < 100; i++) {
      const res = await window.mbrush.recentsUpgradeThumbs(12);
      if (!res.ok || !res.data) break;
      if (res.data.changed) set({ recents: res.data.list });
      if (!res.data.remaining) break;
    }
  } finally {
    upgradingThumbs = false;
  }
}

async function applyOpenedProject(
  set: (partial: Partial<AppState>) => void,
  filePath: string,
  project: Project,
) {
  const thumbs: Record<string, string> = {};
  for (const l of project.layers) {
    try {
      thumbs[l.id] = await makeThumbnail(l.src);
    } catch {
      /* ignore */
    }
  }
  // Backfill a preview for older projects: saved before thumbnails existed, or with the
  // small, long-side one the gallery used to show blown up in its square tile.
  if (!(await isGalleryThumb(project.thumbnail))) {
    try {
      const flat = await flattenLayers(
        project.layers,
        project.canvas.width,
        project.canvas.height,
        project.canvas.backgroundColor,
      );
      const thumbnail = await makeGalleryThumb(flat);
      project = { ...project, thumbnail };
      await window.mbrush.recentsAdd({ path: filePath, name: project.name, thumbnail });
    } catch {
      /* ignore */
    }
  }
  set({
    project,
    filePath,
    dirty: false,
    activeLayerId: project.layers[project.layers.length - 1]?.id ?? null,
    mask: { strokes: [], rects: [], bitmaps: [], inverted: false },
    removeMask: { strokes: [], rects: [], bitmaps: [], inverted: false },
    thumbnails: thumbs,
    zoom: fitZoom(project.canvas.width, project.canvas.height),
    panX: 0,
    panY: 0,
    past: [],
    future: [],
    status: `${project.name} · ${dims(project.canvas.width, project.canvas.height)}`,
    // Said now rather than at export time: a missing original means pieces and the export
    // come from the shrunk copy, and the user should get the chance to point at the file.
    // Said now rather than at export time: the piece works without its photo, but cannot
    // go back into it until the user points at where it went.
    warning: project.pieceSource?.original.missing
      ? `התמונה המקורית של החתיכה לא נמצאה (${project.pieceSource.original.path}). ` +
        "אפשר להמשיך לעבוד; כדי להחזיר את החתיכה אליה — ייצוא ← קשר מחדש את המקור."
      : null,
  });
}

function fitZoom(w: number, h: number): number {
  const availW = window.innerWidth - 560;
  const availH = window.innerHeight - 220;
  return Math.max(0.05, Math.min(1, Math.min(availW / w, availH / h)));
}


