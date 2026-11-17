// Shared types used by both the Electron main process and the React renderer.
// Keep this file free of any runtime/Node/DOM dependencies.

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "soft-light"
  | "difference"
  | "color"
  | "luminosity";

export type LayerType =
  | "base"
  | "generated"
  | "fill"
  | "mask"
  | "reference"
  | "adjustment";

export type GenerationMode = "upscale" | "recreate" | "fill" | "generate" | "expand" | "ratio" | "removebg";

/** What a reference image is for. The first six are what the menu offers; the last four
 *  are from before it was cut down and survive only so saved projects still load — see
 *  shared/referenceGuide.ts, which is where a role turns into words for the engine. */
export type ReferenceRole =
  | "general"
  | "style"
  | "typography"
  | "identity"
  | "object"
  | "composition"
  | "texture"
  | "lighting"
  | "color"
  | "material";

/** A big photo a piece was cut from. Kept by reference — a 90MB photo inside every save
 *  would make the .mbrush file the problem. */
export interface OriginalRef {
  path: string;
  width: number;
  height: number;
  /** Session-only handle the main process serves the file under; refreshed on load. */
  token?: string;
  /** The file was not where the project said when it was opened. */
  missing?: boolean;
}

/** A project that is a full-resolution piece cut out of a photo too big to work on whole.
 *  Its export can put the result back into a copy of that photo, at the exact spot. */
export interface PieceSource {
  original: OriginalRef;
  /** Where the piece was cut from, in the original's pixels. */
  rect: { x: number; y: number; w: number; h: number };
}

export interface LayerMetadata {
  createdAt: string;
  sourceLayerId?: string;
  sourceMaskId?: string;
  mode?: GenerationMode;
  providerId?: string;
  modelId?: string;
  generationJobId?: string;
  prompt?: string;
  referenceIds?: string[];
  settings?: GenerationSettings;
  /** For fill layers: the raw generated crop (rectangle, no mask/feather) so it can
   *  be exported as the original output instead of the composited overlay. */
  fillSrc?: string;
  /** Fill recompute inputs — enable non-destructive color/feather re-adjustment. */
  fillRef?: string; // the source crop that was sent to the model
  fillMask?: string; // the mask cropped to the fill box, at the patch's pixel size (unfeathered)
  fillBox?: { x: number; y: number; w: number; h: number };
  fillFeather?: number;
  fillColor?: {
    mode: "off" | "global" | "local";
    strength: number;
    brightness: number;
    temperature: number;
    saturation: number;
  };
  /** Non-destructive smart-alignment transform (2×3 affine, canvas px, applied to
   *  the layer's box at render time). Reversible — clearing it restores the box. */
  alignMatrix?: { a: number; b: number; c: number; d: number; e: number; f: number };
  /** Alignment confidence (NCC score) for the UI chip. */
  alignScore?: number;
  /** For expand/ratio layers: the canvas size before this layer grew the frame,
   *  and the shift applied to the other layers — used to restore the original
   *  frame when this layer is deleted. */
  frameBefore?: { width: number; height: number };
  frameShift?: { x: number; y: number };
  /** Uniform scale applied to the sibling layers when this layer grew the frame
   *  (ratio reformat). Default 1 (pure shift). Reversed on delete. */
  frameScale?: number;
  /** For directional-expand patch layers: the unfeathered piece + which edge meets
   *  the original, so the seam feather can be re-tuned live (non-destructive). */
  expandRaw?: string;
  expandEdge?: "left" | "right" | "up" | "down";
  expandFeather?: number;
  expandMargin?: number;
}

export interface Layer {
  id: string;
  name: string;
  type: LayerType;
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1
  blendMode: BlendMode;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Data URL (PNG) of the layer pixels. Stored as asset in project package. */
  src: string;
  maskId?: string;
  metadata?: LayerMetadata;
}

export interface ReferenceImage {
  id: string;
  src: string; // data URL
  role: ReferenceRole;
  /** "What to take from this one", in the user's words. Sent to the engine. */
  note?: string;
  /** Set when the reference is a snapshot of another open tab's canvas, so it can be
   *  refreshed from that tab and shows where it came from. */
  fromDocId?: string;
  fromName?: string;
}

export interface PromptRecord {
  id: string;
  text: string;
  mode: GenerationMode;
  createdAt: string;
}

export interface GenerationJob {
  id: string;
  timestamp: string;
  providerId: string;
  modelId: string;
  sourceLayerId?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  maskId?: string;
  prompt?: string;
  referenceIds?: string[];
  mode: GenerationMode;
  settings?: GenerationSettings;
  outputLayerId?: string;
  requestId?: string;
  costEstimate?: number;
  costReported?: boolean;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error?: string;
}

/** A finished (or paused) workflow run, stored with the project it produced.
 *  `skill` is the whole workflow rather than an id: a saved skill can be edited or
 *  deleted, and the run has to still make sense a month later. */
export interface SavedSkillRun {
  /** The whole workflow, not an id: a saved skill can be edited or deleted, and the run
   *  has to still make sense a month later. Typed `unknown` on purpose — it comes out of
   *  a file the app did not write this session, so it goes back through parseSkill()
   *  before anything runs it. */
  skill: unknown;
  answers: Record<string, string>;
  finalPrompt: string;
  /** Which of the project's reference images this run put there. */
  referenceIds: string[];
  savedAt: string;
}

/** One piece of explanatory markup, in canvas (document) coordinates. */
export type Annotation =
  | { kind: "brush"; points: number[]; color: string; width: number }
  | { kind: "arrow"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number; color: string; width: number }
  | { kind: "text"; x: number; y: number; text: string; color: string; size: number }
  /** A numbered point with the change wanted there. `n` is stable for the pin's life —
   *  deleting pin 2 does not renumber pin 3, or a "📍3" already typed in the prompt box
   *  would quietly move to another spot. */
  | { kind: "pin"; x: number; y: number; n: number; note: string; color: string };

export interface Annotations {
  items: Annotation[];
  /** The markup layer's own on/off switch. */
  visible: boolean;
  /** The highest pin number ever handed out in this project. Numbers are never reused:
   *  "highest pin on the canvas + 1" would give a deleted top pin's number to the next
   *  one, and a tag already typed for the old pin would silently point at the new spot. */
  pinSeq?: number;
}

export interface GenerationSettings {
  quality?: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
  /** Whole-image erase: the engine's recreate base prompt is swapped for the erase one. */
  eraseObjects?: boolean;
  /** A recreate whose prompt carries pin coordinates: an edit, not a faithful re-render. */
  pinEdit?: boolean;
  outputWidth?: number;
  outputHeight?: number;
  fidelity?: number; // 0..1
  detailStrength?: number; // 0..1
  preserveColor?: boolean;
  preserveGeometry?: boolean;
  preserveIdentity?: boolean;
  negativePrompt?: string;
  seed?: number;
  variations?: number;
  /** For generative fill: long-edge resolution of the generated crop (default 1024). */
  fillLongEdge?: number;
  /** Generative-fill edge feather as % of the region's short edge (default 3). */
  fillFeatherPct?: number;
  /** Generative-fill blend level — opacity of the resulting fill layer, 0..100 (default 100). */
  fillBlend?: number;
  /** Generative-expand direction: which side(s) to grow into. */
  expandDir?: "left" | "right" | "up" | "down" | "horizontal" | "vertical";
  /** Generative-expand amount as % of the source dimension, per chosen side (default 50). */
  expandAmount?: number;
  /** Format/aspect-change target ratio (e.g. "16:9"). */
  ratioTarget?: string;
  /** Generate/recreate: chosen art medium (English phrase), inserted at the start of
   *  the prompt. */
  medium?: string;
  /** Generate/recreate: chosen style text, appended as "in the style of <text>". */
  styleText?: string;
  /** Ask the engine for a real alpha channel instead of an opaque plate. Not a
   *  post-process: it steers the generation itself. */
  transparentBackground?: boolean;
  /** Output aspect ratio for upscale/recreate/generate. "auto" = keep source. */
  aspectRatio?: string; // "auto" | "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3" | "21:9"
  /** Nano Banana resolution tier: "0.5K" | "1K" | "2K" | "4K". */
  nanoResolution?: string;
  /** gpt-image generate: long-edge of the requested output (default 2048). */
  genLongEdge?: number;
  /** Recreate output long edge; 0/absent = keep the source's own. */
  recreateLongEdge?: number;
  /** Upscale output long edge (default 3840, the engine ceiling). */
  upscaleLongEdge?: number;
  /** Background-removal output long edge (default 2048); 0 = keep the source's own. */
  removebgLongEdge?: number;
  /** Reformat output long edge — applied by the app, so it holds for every engine. */
  ratioLongEdge?: number;
  /** Nano Banana tiers, one per mode, so each keeps its own honest default. */
  nanoRecreateResolution?: string;
  nanoUpscaleResolution?: string;
  /** Grok Imagine resolution tier: "1k" | "2k". */
  grokResolution?: string;
  /** Reve effort (test_time_scaling): 1 = normal, 2/3 = better (higher cost). */
  testTimeScaling?: number;
  /** How to reconcile a result whose aspect differs from the source:
   *  "source" = center-crop back to the original aspect (default), "model" = keep as returned. */
  aspectConform?: "source" | "model";
  /** Auto-align (register) the result onto the source layer for fill/upscale so it
   *  sits pixel-perfect. Default on (undefined = on); false disables. */
  alignToSource?: boolean;
  /** Allow engine-specific option keys. */
  [key: string]: unknown;
}

/** A single adjustable control a provider exposes for the options UI. */
export interface ProviderOptionChoice {
  value: string | number;
  label: string;
  /** Models this choice exists on. Omit = every model of the engine. `ProviderInfo.options`
   *  is built once from the engine's default model and so cannot answer "does the model
   *  selected right now accept this?" — same reason `supportsTransparency` lives on the
   *  model. The renderer filters on it; the adapter clamps again before the call. */
  models?: string[];
}
export interface ProviderOption {
  key: string; // maps to a GenerationSettings key
  label: string;
  type: "select" | "toggle";
  choices?: ProviderOptionChoice[];
  default?: string | number | boolean;
  /** Modes this option applies to. Omit = all modes. */
  modes?: GenerationMode[];
  note?: string;
}

export interface CanvasDoc {
  width: number;
  height: number;
  colorProfile?: string;
  backgroundColor?: string;
}

export interface ProjectSettings {
  defaultProviderId: string;
  autosave: boolean;
}

export interface Project {
  /** Set when this project is a piece cut from a bigger photo. */
  pieceSource?: PieceSource;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Small flattened preview (data URL) embedded on save. */
  thumbnail?: string;
  canvas: CanvasDoc;
  layers: Layer[];
  /** The workflow that produced this project, if one did — the steps, every answer
   *  given, and the prompt it ended on. Saved so the run can be picked up again
   *  tomorrow instead of being re-run from the photographs. */
  skillRun?: SavedSkillRun;
  /** User markup drawn on top of the canvas to explain an intent to the assistant.
   *  Deliberately NOT a Layer: layers get flattened into the image sent to the image
   *  engine, and an arrow drawn to say "fix this" must never be generated INTO the
   *  picture. Optional, so older project files load unchanged. */
  annotations?: Annotations;
  references: ReferenceImage[];
  promptHistory: PromptRecord[];
  jobs: GenerationJob[];
  settings: ProjectSettings;
}

// ---- Provider contracts (shared shape, executed in main) ----

export interface ProviderCapabilities {
  supportsUpscale: boolean;
  supportsRecreate: boolean;
  supportsInpainting: boolean;
  supportsMasks: boolean;
  supportsTransparency: boolean;
  supportsReferenceImages: boolean;
  supportsMultipleReferenceImages: boolean;
  supportsNegativePrompt: boolean;
  supportsSeed: boolean;
  supportsVariations: boolean;
  supportsCustomOutputSize: boolean;
  maxInputImageSize?: number;
  maxReferenceImages?: number;
  supportedFormats: string[];
  notes?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** This model returns a real alpha channel. Per MODEL, not per engine: umage2 offers
   *  it on gpt-image-2 and the API rejects it on the gpt-image-1 family, and the
   *  renderer has to know which one is selected right now. */
  supportsTransparency?: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  version?: string;
  capabilities: ProviderCapabilities;
  models: ModelInfo[];
  options: ProviderOption[];
  requiresApiKey: boolean;
  docsUrl?: string;
}

export interface ValidationResult {
  valid: boolean;
  message?: string;
}

export interface GeneratedImage {
  /** Data URL (PNG) */
  src: string;
  width: number;
  height: number;
}

export interface GenerationResult {
  id: string;
  providerId: string;
  modelId: string;
  images: GeneratedImage[];
  metadata?: {
    requestId?: string;
    costEstimate?: number;
    /** True when costEstimate is what the engine itself reported charging, not a guess. */
    costReported?: boolean;
    latencyMs?: number;
  };
}

// Requests flowing renderer -> main over IPC. Images are data URLs.
export interface BaseGenerationRequest {
  providerId: string;
  modelId?: string;
  mode: GenerationMode;
  prompt?: string;
  image?: string; // data URL of flattened source
  mask?: string; // data URL of mask (white = regenerate)
  references?: { src: string; role: ReferenceRole; note?: string }[];
  settings?: GenerationSettings;
}

export interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface SpendEntry {
  ts: string;
  cost: number;
  providerId?: string;
  modelId?: string;
  mode?: string;
}

export interface SpendData {
  total: number;
  count: number;
  entries: SpendEntry[];
  /** Running totals per "YYYY-MM". Kept separately because `entries` is capped, so the
   *  months could not be recovered from it once a year's worth has scrolled past. */
  months?: Record<string, { total: number; count: number }>;
}

export interface RecentEntry {
  path: string;
  name: string;
  thumbnail?: string;
  updatedAt: string;
  /** A saved project (.mbrush), or a picture worked on: opened, or exported as a result.
   *  Missing on entries written before pictures were listed — those are projects. */
  kind?: "project" | "image";
}

export interface LicenseStatus {
  activated: boolean;
  name?: string;
  email?: string;
  exp?: number;
  reason?: string;
}

// ---- Series (a workflow run across a folder of subjects) ----

export interface DatasetImage {
  name: string;
  path: string;
  bytes: number;
}

export interface DatasetFolder {
  name: string;
  path: string;
  images: DatasetImage[];
}

export interface DatasetScan {
  root: string;
  folders: DatasetFolder[];
  /** Spreadsheets found at the root (.xlsx / .csv / .tsv). */
  sheets: { name: string; path: string }[];
  /** Images sitting loose at the root, outside any subfolder. */
  looseImages: DatasetImage[];
}

export interface SheetData {
  columns: string[];
  rows: Record<string, string>[];
  /** Which sheet inside the workbook was read (xlsx may hold several). */
  sheetName?: string;
}
