import { WELL, STEEL_900, STEEL_300, STEEL_100, CHECK_DARK, CHECK_LIGHT } from "./steel";
import { useView } from "../state/view";
import { useLayout } from "../state/layout";
import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer as KLayer, Image as KImage, Rect, Group, Circle, Line, Arrow, Text as KText, Label, Tag, Transformer, Shape } from "react-konva";
import { hatchTile, hatchGap, hatchBitmap, INK, ON_INK } from "./inkColor";
import useImage from "use-image";
import type Konva from "konva";
import { useStore } from "../state/store";
import { maskHasContent, rasterizeMask } from "../compositing";
import { regionReadout } from "../fillRegion";
import { markDensity, useLayerNaturalWidths } from "./layerDensity";
import { nextPinNumber, type Pin } from "../pins";
import { EraseBar } from "../ui/EraseBar";
import { getMosaicLayers, mosaicCells, fitContain, type Cell } from "../mosaic";
import type { Annotation, Layer, BlendMode } from "../../shared/types";

const BLEND: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  "soft-light": "soft-light",
  difference: "difference",
  color: "color",
  luminosity: "luminosity",
};

function LayerImage({ layer, draggable, onMoved, nodeRef, onTransformed }: {
  layer: Layer;
  draggable?: boolean;
  onMoved?: (x: number, y: number) => void;
  nodeRef?: React.Ref<Konva.Image>;
  onTransformed?: (x: number, y: number, w: number, h: number) => void;
}) {
  const [img] = useImage(layer.src);
  if (!layer.visible || !img) return null;
  // Non-destructive smart-alignment: apply the stored affine to the layer's box
  // at render time (pixels untouched). V1 transforms are similarity (scale +
  // translation, optional rotation) → map cleanly to box + Konva rotation.
  const m = layer.metadata?.alignMatrix;
  let rx = layer.x, ry = layer.y, rw = layer.width, rh = layer.height, rRot = 0;
  if (m) {
    const sx = Math.hypot(m.a, m.b) || 1;
    const sy = Math.hypot(m.c, m.d) || 1;
    rRot = (Math.atan2(m.b, m.a) * 180) / Math.PI;
    rx = layer.x + m.e;
    ry = layer.y + m.f;
    rw = layer.width * sx;
    rh = layer.height * sy;
  }
  return (
    <KImage
      ref={nodeRef}
      image={img}
      x={rx}
      y={ry}
      width={rw}
      height={rh}
      rotation={rRot}
      opacity={layer.opacity}
      globalCompositeOperation={BLEND[layer.blendMode]}
      listening={!!draggable}
      draggable={!!draggable}
      onDragEnd={(e) => onMoved?.(e.target.x(), e.target.y())}
      onTransformEnd={(e) => {
        // Bake the transformer's scale into width/height, then reset the scale
        // so the layer model stays a plain box (x, y, w, h).
        const node = e.target as Konva.Image;
        const w = node.width() * node.scaleX();
        const h = node.height() * node.scaleY();
        node.scaleX(1);
        node.scaleY(1);
        onTransformed?.(node.x(), node.y(), w, h);
      }}
    />
  );
}

/** A single mosaic tile: the layer image aspect-fit + centered into its grid cell,
 *  with hover handlers that drive the canvas→panel highlight. */
function MosaicTile({ layer, cell, hovered, strokeW, onEnter, onLeave }: {
  layer: Layer;
  cell: Cell;
  hovered: boolean;
  strokeW: number;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const [img] = useImage(layer.src);
  if (!img) return null;
  const fit = fitContain(layer.width, layer.height, cell.w, cell.h);
  const x = cell.x + (cell.w - fit.w) / 2;
  const y = cell.y + (cell.h - fit.h) / 2;
  return (
    <>
      <KImage image={img} x={x} y={y} width={fit.w} height={fit.h} onMouseEnter={onEnter} onMouseLeave={onLeave} />
      {hovered && (
        <Rect x={x} y={y} width={fit.w} height={fit.h} stroke={STEEL_100} strokeWidth={strokeW} listening={false} />
      )}
    </>
  );
}

/** The classic transparency checkerboard, drawn once and reused as a fill pattern. */
const checkerPattern = (() => {
  if (typeof document === "undefined") return undefined;
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = CHECK_LIGHT;
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = CHECK_DARK;
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillRect(16, 16, 16, 16);
  const img = new Image();
  img.src = c.toDataURL();
  return img;
})();


/** A marked rectangle with its live size readout.
 *
 *  The number shown is the rectangle in image pixels — canvas pixels times the density
 *  of the sharpest layer under it, so over a ×2 upscale a 512 mark reads 1024 — and beside it the region
 *  resolution the crop will actually land on — the pipeline pads the mark by ~14% a side
 *  before resampling, so the rectangle's own size is NOT what the model works at. The
 *  frame thickens (and the readout turns bright) when the two line up, which is when the patch comes back 1:1 and
 *  drops in without resampling. */
function RegionRect({
  box,
  canvasW,
  canvasH,
  zoom,
  exact,
  density = 1,
  children,
}: {
  box: { x: number; y: number; w: number; h: number };
  canvasW: number;
  canvasH: number;
  zoom: number;
  exact?: boolean;
  density?: number;
  children?: React.ReactNode;
}) {
  // Normalise: dragging up/left gives negative width.
  const x = box.w < 0 ? box.x + box.w : box.x;
  const y = box.h < 0 ? box.y + box.h : box.y;
  const w = Math.abs(box.w);
  const h = Math.abs(box.h);
  if (w < 2 || h < 2) return <>{children}</>;
  const r = regionReadout({ x, y, w, h }, canvasW, canvasH, exact, density);
  const fs = 11 / zoom;
  const pad = 5 / zoom;
  // The rectangle is sent as drawn, so this IS the size the model works at. The label
  // appears only when the long edge is exactly a generation size.
  const text = r.onBenchmark ? `${r.w} × ${r.h}  ·  ${r.nearest.label}` : `${r.w} × ${r.h}`;
  // Above the box when there is room, inside it when the box is at the canvas top.
  const ty = y > fs * 1.8 ? y - fs * 1.5 : y + pad;
  return (
    <>
      {children}
      <KText
        x={x + pad}
        y={ty}
        text={text}
        fontSize={fs}
        fontFamily={MONO}
        fontStyle={r.onBenchmark ? "500" : "normal"}
        fill={r.onBenchmark ? STEEL_100 : STEEL_300}
        stroke={WELL}
        strokeWidth={3 / zoom}
        fillAfterStrokeEnabled
        listening={false}
      />
    </>
  );
}

/** Marks on the canvas (דיו ופלדה, the Marks component): what the person marked is
 *  veiled in steel and hatched in dry ink. A fill area is hatched one way; an erase area
 *  is cross-hatched — crossed out — so the two stay apart when both are on the picture.
 *  A rectangle also gets a steel hairline frame. None of it is part of any image sent
 *  to an engine. */
const MARK_VEIL = STEEL_900;
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
const HAND = '"David Libre", "Frank Ruhl Libre", serif';

/** A brush stroke painted with a pattern instead of a colour — Konva lines take only
 *  colours, so this one draws itself. The veil goes under the hatch in the same pass. */
function HatchStroke({ points, width, tile }: { points: number[]; width: number; tile: HTMLCanvasElement }) {
  return (
    <Shape
      listening={false}
      sceneFunc={(kctx) => {
        if (points.length < 2) return;
        const c = (kctx as unknown as { _context: CanvasRenderingContext2D })._context;
        c.save();
        c.lineCap = "round";
        c.lineJoin = "round";
        c.lineWidth = width;
        c.beginPath();
        c.moveTo(points[0], points[1]);
        for (let i = 2; i < points.length; i += 2) c.lineTo(points[i], points[i + 1]);
        if (points.length === 2) c.lineTo(points[0] + 0.01, points[1]);
        c.strokeStyle = MARK_VEIL;
        c.stroke();
        c.strokeStyle = c.createPattern(tile, "repeat")!;
        c.stroke();
        c.restore();
      }}
    />
  );
}

/** A numbered pin: its number on a flat ink plate (the design system's sixth place for
 *  the ink). The plate is the pin on screen only — the picture the prompt assistant is
 *  shown still draws the pin in the note colour it was placed with (compositing.ts).
 *  The same size on screen at any zoom — a pin that shrinks to a dot when
 *  you zoom out to see the whole picture is a pin you cannot find. Its note rides beside
 *  it, shortened, so the canvas explains itself without opening anything. */
function PinMarker({ pin, zoom, editable, onEdit }: { pin: Pin; zoom: number; editable: boolean; onEdit: () => void }) {
  const R = 13;
  const BW = pin.n > 9 ? 32 : 26;
  const BH = 22;
  const note = pin.note.trim();
  const shown = note.length > 42 ? `${note.slice(0, 40)}…` : note;
  return (
    <Group x={pin.x} y={pin.y} scaleX={1 / zoom} scaleY={1 / zoom} listening={editable}>
      {/* The hit target: invisible, about the plate's size. */}
      <Circle name="pin" radius={R} fill="rgba(0,0,0,0)" onDblClick={onEdit} />
      <Rect x={-BW / 2} y={-BH / 2} width={BW} height={BH} fill={INK} listening={false} />
      <KText
        name="pin"
        text={String(pin.n)}
        x={-R}
        y={-R}
        width={R * 2}
        height={R * 2}
        align="center"
        verticalAlign="middle"
        fontSize={pin.n > 9 ? 12 : 14}
        fontFamily={MONO}
        fontStyle="500"
        fill={ON_INK}
        onDblClick={onEdit}
      />
      {shown && (
        <Label x={BW / 2 + 6} y={-13} listening={false}>
          <Tag fill={STEEL_900} opacity={0.92} />
          <KText text={shown} fontSize={15} fontFamily={HAND} padding={5} fill={STEEL_100} />
        </Label>
      )}
    </Group>
  );
}

export function CanvasStage() {
  const project = useStore((s) => s.project);
  const layerWidths = useLayerNaturalWidths(project?.layers);
  const zoom = useStore((s) => s.zoom);
  // Konva cannot read CSS variables, so the picture's edge colour is read from the token
  // whenever the theme or the surround changes.
  const lookTheme = useLayout((s) => s.theme);
  const lookWell = useLayout((s) => s.well);
  const pictureEdge = useMemo(
    () => getComputedStyle(document.documentElement).getPropertyValue("--picture-edge").trim() || "rgba(128,128,128,0.5)",
    [lookTheme, lookWell],
  );
  const panX = useStore((s) => s.panX);
  const panY = useStore((s) => s.panY);
  const tool = useStore((s) => s.tool);
  const brushSize = useStore((s) => s.brushSize);
  const brushHardness = useStore((s) => s.brushHardness);
  const mask = useStore((s) => s.mask);
  const removeMask = useStore((s) => s.removeMask);
  const addRemoveStroke = useStore((s) => s.addRemoveStroke);
  const compare = useStore((s) => s.compare);
  const activeLayerId = useStore((s) => s.activeLayerId);
  const mosaic = useStore((s) => s.mosaic);
  const selectedLayerIds = useStore((s) => s.selectedLayerIds);
  const hoveredLayerId = useStore((s) => s.hoveredLayerId);
  const setHoveredLayer = useStore((s) => s.setHoveredLayer);

  const setZoom = useStore((s) => s.setZoom);
  const setPan = useStore((s) => s.setPan);
  const addRect = useStore((s) => s.addRect);
  const addStroke = useStore((s) => s.addStroke);
  const moveRect = useStore((s) => s.moveRect);
  const pushHistory = useStore((s) => s.pushHistory);
  const commitLayerErase = useStore((s) => s.commitLayerErase);
  const setLayerPosition = useStore((s) => s.setLayerPosition);
  const setLayerBox = useStore((s) => s.setLayerBox);
  const wandSelectAt = useStore((s) => s.wandSelectAt);
  const elementSelectAt = useStore((s) => s.elementSelectAt);
  const setLayerAlign = useStore((s) => s.setLayerAlign);
  const showMask = useStore((s) => s.showMask);
  const rectSquare = useStore((s) => s.rectSquare);
  // Explanatory markup drawn on top of the canvas (never sent to the image engine).
  const annotations = useStore((s) => s.project?.annotations ?? null);
  const noteShape = useStore((s) => s.noteShape);
  const noteColor = useStore((s) => s.noteColor);
  const noteSize = useStore((s) => s.noteSize);
  const addAnnotation = useStore((s) => s.addAnnotation);
  const updateAnnotation = useStore((s) => s.updateAnnotation);
  const removeAnnotation = useStore((s) => s.removeAnnotation);

  const containerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<Konva.Layer>(null);
  // Stretch handles for the active layer (move tool).
  const trRef = useRef<Konva.Transformer>(null);
  const activeNodeRef = useRef<Konva.Image>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [draftRect, setDraftRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Live brush cursor position (document coords).
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // Live preview of brush size/feather while the sliders (or [ ] keys) change:
  // shown at the viewport center for a moment after the last change.
  const brushPreviewAt = useStore((s) => s.brushPreviewAt);
  const [, previewTick] = useState(0);
  useEffect(() => {
    if (!brushPreviewAt) return;
    const t = setTimeout(() => previewTick((v) => v + 1), 1300);
    return () => clearTimeout(t);
  }, [brushPreviewAt]);
  const showBrushPreview = tool === "erase-layer" && Date.now() - brushPreviewAt < 1200;

  // Real-time layer erase: an offscreen canvas mirrors the active layer and is
  // mutated as the user drags; the active layer renders straight from it.
  const eraseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const eraseOrigRef = useRef<HTMLImageElement | null>(null);
  const eraseStrokeRef = useRef<HTMLCanvasElement | null>(null);
  const eraseSelMaskRef = useRef<HTMLCanvasElement | null>(null);
  const eraseTempRef = useRef<HTMLCanvasElement | null>(null);
  const erasing = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const [eraseV, setEraseV] = useState(0);

  // Rectangle selection drawing flag (ref = reliable across mouse quirks).
  const drawingRect = useRef(false);
  const rectStart = useRef<{ x: number; y: number } | null>(null);

  // Freehand mark brush: accumulate the stroke's doc points; draftStroke renders it
  // live, then it's committed to the mask on mouse-up.
  const marking = useRef(false);
  const markPts = useRef<number[]>([]);
  const [draftStroke, setDraftStroke] = useState<number[] | null>(null);
  // Konva only flattens a group's opacity — instead of multiplying it per child — while
  // the group is cached. Without this the mask's overlapping strokes compound.
  const maskGroupRef = useRef<Konva.Group>(null);
  const commitMarkStroke = () => {
    if (!marking.current) return;
    marking.current = false;
    const points = markPts.current;
    markPts.current = [];
    setDraftStroke(null);
    if (points.length >= 2) addStroke({ tool: "brush", size: brushSize, hardness: 100, points });
  };

  // Erase brush: the same gesture as the mark brush, into its own mask, in its own colour
  // — so what will be removed can never be mistaken for what will be filled.
  const removing = useRef(false);
  const removePts = useRef<number[]>([]);
  const [draftRemove, setDraftRemove] = useState<number[] | null>(null);
  const removeGroupRef = useRef<Konva.Group>(null);
  const commitRemoveStroke = () => {
    if (!removing.current) return;
    removing.current = false;
    const points = removePts.current;
    removePts.current = [];
    setDraftRemove(null);
    if (points.length >= 2) addRemoveStroke({ tool: "brush", size: brushSize, hardness: 100, points });
  };
  // The hatch tiles for this document, one way for fill and crossed for erase.
  const gap = project ? hatchGap(project.canvas.width, project.canvas.height) : 8;
  const fillTile = useMemo(() => hatchTile(gap), [gap]);
  const eraseTile = useMemo(() => hatchTile(gap, true), [gap]);
  // Smart selections (magic wand / segments) arrive as tinted bitmaps; hatched once here.
  const fillBitmaps = useMemo(() => mask.bitmaps.map((b) => hatchBitmap(b, fillTile, MARK_VEIL)), [mask.bitmaps, fillTile]);
  // Areas that failed to erase come back as bitmaps (white = painted). Hatched once here
  // rather than every frame.
  const removeBitmaps = useMemo(
    () =>
      removeMask.bitmaps.map((b) => hatchBitmap(b, eraseTile, MARK_VEIL)),
    [removeMask.bitmaps],
  );

  // ---- Explanatory markup ------------------------------------------------
  // The in-progress mark: freehand points, or the two corners of an arrow/box.
  const noting = useRef(false);
  const notePts = useRef<number[]>([]);
  const noteStart = useRef<{ x: number; y: number } | null>(null);
  const [noteDraft, setNoteDraft] = useState<Annotation | null>(null);
  /** The floating text editor: which item it edits (null = a new one) and where. */
  const [noteEdit, setNoteEdit] = useState<{
    index: number | null;
    x: number;
    y: number;
    value: string;
    /** Editing a pin's note rather than a text annotation. */
    pin?: boolean;
    /** The pin was placed by this very click: Esc takes it back off the canvas. */
    fresh?: boolean;
    /** Which pin — an index alone can point at a different item once something is removed. */
    n?: number;
  } | null>(null);

  const commitNote = () => {
    if (!noting.current) return;
    noting.current = false;
    const draft = noteDraft;
    notePts.current = [];
    noteStart.current = null;
    setNoteDraft(null);
    if (!draft) return;
    if (draft.kind === "brush" && draft.points.length < 4) return;
    if (draft.kind === "arrow" && Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) < 4) return;
    if (draft.kind === "rect" && (Math.abs(draft.w) < 4 || Math.abs(draft.h) < 4)) return;
    if (draft.kind === "rect") {
      addAnnotation({
        ...draft,
        x: draft.w < 0 ? draft.x + draft.w : draft.x,
        y: draft.h < 0 ? draft.y + draft.h : draft.y,
        w: Math.abs(draft.w),
        h: Math.abs(draft.h),
      });
      return;
    }
    addAnnotation(draft);
  };

  /** Commit the floating text box — an empty one just disappears. */
  const commitNoteText = () => {
    if (!noteEdit) return;
    const text = noteEdit.value.trim();
    const { index } = noteEdit;
    setNoteEdit(null);
    if (noteEdit.pin) {
      // A pin with no note is kept on purpose — the assistant asks what it is for.
      // Read fresh from the store: if the pin was just deleted, the index now belongs to
      // something else, and writing a note into it would corrupt that item.
      const current = index != null ? useStore.getState().project?.annotations?.items[index] : undefined;
      if (current?.kind === "pin" && current.n === noteEdit.n) updateAnnotation(index!, { note: text });
      return;
    }
    if (index != null) {
      if (text) updateAnnotation(index, { text });
      else removeAnnotation(index);
      return;
    }
    if (text) addAnnotation({ kind: "text", x: noteEdit.x, y: noteEdit.y, text, color: noteColor, size: Math.max(14, noteSize * 4) });
  };

  const commitRect = () => {
    if (!drawingRect.current) return;
    drawingRect.current = false;
    const r = draftRect;
    setDraftRect(null);
    rectStart.current = null;
    if (r && Math.abs(r.w) > 2 && Math.abs(r.h) > 2) {
      const x = r.w < 0 ? r.x + r.w : r.x;
      const y = r.h < 0 ? r.y + r.h : r.y;
      addRect({ x, y, w: Math.abs(r.w), h: Math.abs(r.h) });
    }
  };

  const activeLayer = project?.layers.find((l) => l.id === activeLayerId) ?? null;
  const canTransform = tool === "move" && !!activeLayer && !activeLayer.locked && !compare && !mosaic;

  // (Re)attach the stretch handles whenever the transformable target changes.
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    if (canTransform && activeNodeRef.current) {
      tr.nodes([activeNodeRef.current]);
    } else {
      tr.nodes([]);
    }
    tr.getLayer()?.batchDraw();
  }, [canTransform, activeLayerId, activeLayer?.src, activeLayer?.width, activeLayer?.height]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const publish = () => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      useView.setState({ w: el.clientWidth, h: el.clientHeight });
    };
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    publish();
    return () => ro.disconnect();
  }, []);

  // A newly opened picture starts in the middle of the canvas. Every open path sets the
  // pan to (0, 0), which is the stage's top-left corner — so the image used to sit against
  // one side with half the canvas empty. It is also fitted to the space there really is.
  // Done once per project, only while the pan is
  // still that untouched (0, 0), and only once the stage has its real size; a picture
  // larger than the view keeps its top-left start.
  const FIT_MARGIN = 24;
  const measured = useRef(false);
  const centredFor = useRef<string | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    // `size` starts as a placeholder; it is real once it agrees with the element.
    if (el && el.clientWidth === size.w && el.clientHeight === size.h) measured.current = true;
    const id = project?.id ?? null;
    if (!id || !measured.current || centredFor.current === id) return;
    centredFor.current = id;
    if (panX !== 0 || panY !== 0) return; // this document already has a place of its own
    // The store guesses the zoom from the window's size before the stage exists; the
    // guess assumes chrome of a fixed height and can leave the picture cut off below.
    // Here the real space is known: fit it, with a margin, never above 100%.
    const { width: cw, height: ch } = project!.canvas;
    const fit = Math.max(0.05, Math.min(1, (size.w - FIT_MARGIN * 2) / cw, (size.h - FIT_MARGIN * 2) / ch));
    if (Math.abs(fit - zoom) > 0.001) setZoom(fit);
    const x = Math.max(0, Math.round((size.w - cw * fit) / 2));
    const y = Math.max(0, Math.round((size.h - ch * fit) / 2));
    if (x || y) setPan(x, y);
  }, [project?.id, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps


  // (Re)build the erase working canvases whenever the active layer or tool changes.
  // eraseCanvas = what's displayed/committed; eraseOrig = pristine layer pixels;
  // eraseStroke = the accumulated stroke alpha; eraseSelMask = the current
  // selection mapped to layer space (erase is clipped to it when present).
  useEffect(() => {
    if (tool !== "erase-layer" || !activeLayer) {
      eraseCanvasRef.current = null;
      eraseOrigRef.current = null;
      eraseStrokeRef.current = null;
      eraseSelMaskRef.current = null;
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d")!.drawImage(img, 0, 0);
      eraseCanvasRef.current = c;
      eraseOrigRef.current = img;
      const stroke = document.createElement("canvas");
      stroke.width = w;
      stroke.height = h;
      eraseStrokeRef.current = stroke;
      eraseSelMaskRef.current = null;
      // Map the selection (if any) into layer pixel space for clipped erasing.
      if (maskHasContent(mask) && project) {
        const maskUrl = rasterizeMask(mask, project.canvas.width, project.canvas.height);
        const mImg = new Image();
        mImg.onload = () => {
          if (cancelled) return;
          const mc = document.createElement("canvas");
          mc.width = w;
          mc.height = h;
          const sx = w / activeLayer.width;
          const sy = h / activeLayer.height;
          mc.getContext("2d")!.drawImage(
            mImg,
            -activeLayer.x * sx,
            -activeLayer.y * sy,
            project.canvas.width * sx,
            project.canvas.height * sy,
          );
          eraseSelMaskRef.current = mc;
        };
        mImg.src = maskUrl;
      }
      setEraseV((v) => v + 1);
    };
    img.src = activeLayer.src;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, activeLayer?.id, activeLayer?.src, mask]);

  if (!project) return <div className="canvas-empty" ref={containerRef}>פתח תמונה כדי להתחיל</div>;

  const docPoint = (stage: Konva.Stage) => {
    const p = stage.getPointerPosition();
    if (!p) return null;
    return { x: (p.x - panX) / zoom, y: (p.y - panY) / zoom };
  };

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = e.target.getStage()!;
    const pointer = stage.getPointerPosition()!;
    const oldZoom = zoom;
    const dir = e.evt.deltaY > 0 ? -1 : 1;
    const factor = 1.08;
    const newZoom = Math.max(0.05, Math.min(8, dir > 0 ? oldZoom * factor : oldZoom / factor));
    const docX = (pointer.x - panX) / oldZoom;
    const docY = (pointer.y - panY) / oldZoom;
    setPan(pointer.x - docX * newZoom, pointer.y - docY * newZoom);
    setZoom(newZoom);
  };

  const drawEraseSegment = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const c = eraseCanvasRef.current;
    const stroke = eraseStrokeRef.current;
    const orig = eraseOrigRef.current;
    if (!c || !stroke || !orig || !activeLayer) return;
    const sx = c.width / activeLayer.width;
    const sy = c.height / activeLayer.height;
    const radius = (brushSize * sx) / 2;
    const inner = Math.max(0, Math.min(1, brushHardness / 100));

    // Overlapping stamps accumulate opacity, which would harden the feather.
    // Compensate each stamp's alpha so the ACCUMULATED stroke profile equals the
    // intended one: full erase inside the inner radius, smooth linear falloff to
    // zero at the brush edge (a' = 1-(1-target)^(1/overlap)).
    const OVERLAP = 8; // ≈ stamps covering a point at spacing radius/4
    const sctx = stroke.getContext("2d")!;
    const stamp = (x: number, y: number) => {
      const g = sctx.createRadialGradient(x, y, radius * inner, x, y, radius);
      for (let i = 0; i <= 8; i++) {
        const p = i / 8;
        const target = 1 - p; // intended coverage at this ring position
        const a = i === 0 ? 1 : 1 - Math.pow(1 - target, 1 / OVERLAP);
        g.addColorStop(p, `rgba(0,0,0,${a.toFixed(4)})`);
      }
      sctx.fillStyle = g;
      sctx.beginPath();
      sctx.arc(x, y, radius, 0, Math.PI * 2);
      sctx.fill();
    };
    const x0 = (from.x - activeLayer.x) * sx;
    const y0 = (from.y - activeLayer.y) * sy;
    const x1 = (to.x - activeLayer.x) * sx;
    const y1 = (to.y - activeLayer.y) * sy;
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(d / Math.max(1, radius * 0.25)));
    for (let k = 0; k <= n; k++) stamp(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);

    // Clip the stroke to the selection (when one exists) — erasing affects only
    // the selected pixels.
    let eraseSrc: HTMLCanvasElement = stroke;
    const selMask = eraseSelMaskRef.current;
    if (selMask) {
      if (!eraseTempRef.current) {
        eraseTempRef.current = document.createElement("canvas");
      }
      const tmp = eraseTempRef.current;
      tmp.width = c.width;
      tmp.height = c.height;
      const tctx = tmp.getContext("2d")!;
      tctx.clearRect(0, 0, tmp.width, tmp.height);
      tctx.drawImage(stroke, 0, 0);
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(selMask, 0, 0);
      tctx.globalCompositeOperation = "source-over";
      eraseSrc = tmp;
    }

    // Recompose: pristine layer minus the (clipped) stroke.
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(orig, 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(eraseSrc, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    layerRef.current?.batchDraw();
    setEraseV((v) => v + 1);
  };

  // Marking (rect + brush) is confined to the canvas — clamp doc points to its bounds.
  const clampDoc = (p: { x: number; y: number }) => ({
    x: Math.max(0, Math.min(project!.canvas.width, p.x)),
    y: Math.max(0, Math.min(project!.canvas.height, p.y)),
  });

  const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = e.target.getStage()!;
    const dp = docPoint(stage);
    if (!dp) return;
    if (tool === "rect") {
      // Clicking an existing marked rect (a listening shape) starts a drag, not a
      // new draw — only the empty canvas (target === stage) begins a fresh box.
      if (e.target !== stage) return;
      const cp = clampDoc(dp);
      drawingRect.current = true;
      rectStart.current = cp;
      setDraftRect({ x: cp.x, y: cp.y, w: 0, h: 0 });
    } else if (tool === "erase-layer" && activeLayer && eraseCanvasRef.current) {
      erasing.current = true;
      lastPt.current = dp;
      drawEraseSegment(dp, dp);
    } else if (tool === "brush") {
      const cp = clampDoc(dp);
      marking.current = true;
      markPts.current = [cp.x, cp.y];
      setDraftStroke([cp.x, cp.y]);
    } else if (tool === "remove") {
      const cp = clampDoc(dp);
      removing.current = true;
      removePts.current = [cp.x, cp.y];
      setDraftRemove([cp.x, cp.y]);
    } else if (tool === "wand") {
      wandSelectAt(dp.x, dp.y);
    } else if (tool === "element") {
      elementSelectAt(dp.x, dp.y);
    } else if (tool === "note") {
      const cp = clampDoc(dp);
      if (noteShape === "text" || noteShape === "pin") {
        // Both open a floating field that must keep focus. The field mounts and focuses
        // while this mousedown is still being handled — and the browser's default action
        // for a mousedown on a non-focusable canvas then moves focus to <body>, blurring
        // the field, whose blur commits and closes it. Measured: mount → focusout → unmount,
        // all before mouseup. That is why a text note's box vanished before you could type.
        e.evt.preventDefault();
      }
      if (noteShape === "text") {
        // Clicking with the text tool opens the editor where you clicked.
        setNoteEdit({ index: null, x: cp.x, y: cp.y, value: "" });
        return;
      }
      if (noteShape === "pin") {
        // Clicking an existing pin is a double-click-to-edit gesture, not a new pin.
        if (e.target !== stage && e.target.name() === "pin") return;
        const index = annotations?.items.length ?? 0;
        const n = nextPinNumber(annotations?.items, annotations?.pinSeq);
        addAnnotation({ kind: "pin", x: cp.x, y: cp.y, n, note: "", color: noteColor });
        // The field opens right where the pin landed: placing a pin is saying "here",
        // and the next thing to say is what should change here.
        setNoteEdit({ index, x: cp.x, y: cp.y, value: "", pin: true, fresh: true, n });
        return;
      }
      noting.current = true;
      noteStart.current = cp;
      if (noteShape === "brush") {
        notePts.current = [cp.x, cp.y];
        setNoteDraft({ kind: "brush", points: [cp.x, cp.y], color: noteColor, width: noteSize });
      } else if (noteShape === "arrow") {
        setNoteDraft({ kind: "arrow", x1: cp.x, y1: cp.y, x2: cp.x, y2: cp.y, color: noteColor, width: noteSize });
      } else {
        setNoteDraft({ kind: "rect", x: cp.x, y: cp.y, w: 0, h: 0, color: noteColor, width: noteSize });
      }
    }
  };

  const onMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = e.target.getStage()!;
    const dp = docPoint(stage);
    if (!dp) return;
    setCursor(dp);
    if (tool === "rect" && drawingRect.current && rectStart.current) {
      const s = rectStart.current;
      const cp = clampDoc(dp);
      let w = cp.x - s.x;
      let h = cp.y - s.y;
      if (rectSquare) {
        // Lock the marking to a 1:1 square (largest dragged edge wins), shrunk so
        // the far corner stays inside the canvas. Free to any size — the size readout
        // tells you where you are, it does not decide it for you.
        const sw = Math.sign(w || 1);
        const sh = Math.sign(h || 1);
        let side = Math.max(Math.abs(w), Math.abs(h));
        const maxX = sw > 0 ? project.canvas.width - s.x : s.x;
        const maxY = sh > 0 ? project.canvas.height - s.y : s.y;
        side = Math.min(side, maxX, maxY);
        w = sw * side;
        h = sh * side;
      }
      setDraftRect({ x: s.x, y: s.y, w, h });
    } else if (tool === "erase-layer" && erasing.current) {
      drawEraseSegment(lastPt.current ?? dp, dp);
      lastPt.current = dp;
    } else if (tool === "brush" && marking.current) {
      const cp = clampDoc(dp);
      markPts.current.push(cp.x, cp.y);
      setDraftStroke([...markPts.current]);
    } else if (tool === "remove" && removing.current) {
      const cp = clampDoc(dp);
      removePts.current.push(cp.x, cp.y);
      setDraftRemove([...removePts.current]);
    } else if (tool === "note" && noting.current && noteStart.current) {
      const cp = clampDoc(dp);
      const st = noteStart.current;
      if (noteShape === "brush") {
        notePts.current.push(cp.x, cp.y);
        setNoteDraft({ kind: "brush", points: [...notePts.current], color: noteColor, width: noteSize });
      } else if (noteShape === "arrow") {
        setNoteDraft({ kind: "arrow", x1: st.x, y1: st.y, x2: cp.x, y2: cp.y, color: noteColor, width: noteSize });
      } else {
        setNoteDraft({ kind: "rect", x: st.x, y: st.y, w: cp.x - st.x, h: cp.y - st.y, color: noteColor, width: noteSize });
      }
    }
  };

  const onMouseUp = () => {
    if (tool === "rect") {
      commitRect();
    } else if (tool === "erase-layer" && erasing.current) {
      erasing.current = false;
      lastPt.current = null;
      const c = eraseCanvasRef.current;
      if (c && activeLayer) commitLayerErase(activeLayer.id, c.toDataURL("image/png"));
    } else if (tool === "brush") {
      commitMarkStroke();
    } else if (tool === "remove") {
      commitRemoveStroke();
    } else if (tool === "note") {
      commitNote();
    }
  };

  const draggablePan = tool === "pan";
  const mosaicLayers = mosaic ? getMosaicLayers(project.layers, selectedLayerIds) : [];
  const showMosaic = mosaicLayers.length >= 2;

  // Re-cache whenever what the group draws changes; an out-of-date cache would freeze
  // the mask's appearance mid-stroke.
  useEffect(() => {
    const g = maskGroupRef.current;
    if (!g) return;
    g.clearCache();
    // A zero-area group cannot be cached, and Konva warns if asked.
    if (project && project.canvas.width > 0 && project.canvas.height > 0) {
      g.cache({ x: 0, y: 0, width: project.canvas.width, height: project.canvas.height });
    }
    return () => {
      g.clearCache();
    };
  }, [mask.strokes, fillBitmaps, fillTile, draftStroke, brushSize, showMask, compare, showMosaic, project?.canvas.width, project?.canvas.height]);

  // Same reason, for the erase paint.
  useEffect(() => {
    const g = removeGroupRef.current;
    if (!g) return;
    g.clearCache();
    if (project && project.canvas.width > 0 && project.canvas.height > 0) {
      g.cache({ x: 0, y: 0, width: project.canvas.width, height: project.canvas.height });
    }
    return () => {
      g.clearCache();
    };
  }, [removeMask.strokes, removeBitmaps, eraseTile, draftRemove, brushSize, compare, showMosaic, project?.canvas.width, project?.canvas.height]);

  const visibleLayers = compare ? project.layers.slice(0, 1) : project.layers;
  const showCursorRing = (tool === "erase-layer" || tool === "brush" || tool === "remove") && cursor;
  const cursorStyle =
    tool === "pan"
      ? "grab"
      : tool === "erase-layer" || tool === "brush" || tool === "remove"
      ? "none"
      : tool === "note"
      ? noteShape === "text"
        ? "text"
        : "crosshair"
      : tool === "rect" || tool === "wand" || tool === "element"
      ? "crosshair"
      : tool === "move"
      ? "move"
      : "default";

  const innerR = (brushSize / 2) * (brushHardness / 100);

  return (
    <div className="canvas-host" ref={containerRef}>
      <Stage
        width={size.w}
        height={size.h}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          setCursor(null);
          if (drawingRect.current) commitRect();
          if (marking.current) commitMarkStroke();
          if (removing.current) commitRemoveStroke();
          if (noting.current) commitNote();
          if (erasing.current) {
            erasing.current = false;
            lastPt.current = null;
            const c = eraseCanvasRef.current;
            if (c && activeLayer) commitLayerErase(activeLayer.id, c.toDataURL("image/png"));
          }
        }}
        draggable={draggablePan}
        onDragEnd={(e) => {
          if (draggablePan) setPan(e.target.x() + panX, e.target.y() + panY);
          e.target.position({ x: 0, y: 0 });
        }}
        style={{ cursor: cursorStyle, background: "var(--well)" }}
      >
        <KLayer ref={layerRef}>
          <Group x={panX} y={panY} scaleX={zoom} scaleY={zoom}>
            {/* A transparent project gets a checkerboard instead of a fill — otherwise
                "transparent" and "white" look identical and the toggle does nothing
                visible until you export. */}
            {/* A hairline just outside the picture, so its edge reads against any surround. */}
            <Rect
              x={-1 / zoom}
              y={-1 / zoom}
              width={project.canvas.width + 2 / zoom}
              height={project.canvas.height + 2 / zoom}
              stroke={pictureEdge}
              strokeWidth={1 / zoom}
              listening={false}
            />
            {project.canvas.backgroundColor === "transparent" ? (
              <Rect
                x={0}
                y={0}
                width={project.canvas.width}
                height={project.canvas.height}
                fillPatternImage={checkerPattern}
                fillPatternRepeat="repeat"
                fillPatternScaleX={1 / zoom}
                fillPatternScaleY={1 / zoom}
                listening={false}
              />
            ) : (
              <Rect x={0} y={0} width={project.canvas.width} height={project.canvas.height} fill={project.canvas.backgroundColor || "#ffffff"} listening={false} />
            )}

            {showMosaic &&
              mosaicCells(
                mosaicLayers.length,
                project.canvas.width,
                project.canvas.height,
                Math.round(Math.min(project.canvas.width, project.canvas.height) * 0.012),
              ).map((cell, i) => (
                <MosaicTile
                  key={mosaicLayers[i].id}
                  layer={mosaicLayers[i]}
                  cell={cell}
                  hovered={hoveredLayerId === mosaicLayers[i].id}
                  strokeW={3 / zoom}
                  onEnter={() => setHoveredLayer(mosaicLayers[i].id)}
                  onLeave={() => setHoveredLayer(null)}
                />
              ))}

            {!showMosaic && visibleLayers.map((l) => {
              const isActive = l.id === activeLayerId;
              // Erase-mode live preview — but still honor layer visibility (the
              // hide-layer toggle must work in every tool, this branch included).
              if (tool === "erase-layer" && isActive && l.visible && eraseCanvasRef.current) {
                return (
                  <KImage
                    key={l.id + ":erase:" + eraseV}
                    image={eraseCanvasRef.current}
                    x={l.x}
                    y={l.y}
                    width={l.width}
                    height={l.height}
                    opacity={l.opacity}
                    listening={false}
                  />
                );
              }
              if (tool === "move" && isActive && !l.locked) {
                // Manually editing an aligned layer bakes the current (visual)
                // position into the box and clears the align matrix — the coords
                // Konva reports already include the matrix, so this is WYSIWYG.
                const hasAlign = !!l.metadata?.alignMatrix;
                return (
                  <LayerImage
                    key={l.id}
                    layer={l}
                    draggable
                    onMoved={(x, y) => {
                      setLayerPosition(l.id, x, y);
                      if (hasAlign) setLayerAlign(l.id, undefined);
                    }}
                    nodeRef={activeNodeRef}
                    onTransformed={(x, y, w, h) => {
                      setLayerBox(l.id, x, y, w, h);
                      if (hasAlign) setLayerAlign(l.id, undefined);
                    }}
                  />
                );
              }
              return <LayerImage key={l.id} layer={l} />;
            })}

            {/* Stretch/resize handles for the active layer (move tool). Corners
                keep the aspect ratio; edge handles stretch a single axis. */}
            {canTransform && (
              <Transformer
                ref={trRef}
                rotateEnabled={false}
                flipEnabled={false}
                ignoreStroke
                // Konva keeps the transformer's anchors/border at a CONSTANT screen
                // size (it counters the parent group's zoom), so use fixed values —
                // dividing by zoom here would make them balloon when zoomed out.
                anchorSize={8}
                anchorCornerRadius={2}
                anchorStroke={STEEL_100}
                anchorFill={STEEL_900}
                borderStroke={STEEL_100}
                borderStrokeWidth={1}
                anchorStrokeWidth={1}
                boundBoxFunc={(oldBox, newBox) =>
                  Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox
                }
              />
            )}

            {/* Smart selections (magic wand / AI segments) are drawn with the brush
                strokes below, in the same veiled, hatched group. */}

            {/* Generative-fill region selection (rectangles). With the rect tool
                active they're draggable — grab to reposition the marked area
                precisely (clamped to the canvas). */}
            {!compare && !showMosaic && showMask && mask.rects.map((r, i) => {
              const drag = tool === "rect" && !drawingRect.current;
              const density = markDensity(project.layers, layerWidths, r);
              const read = regionReadout(r, project.canvas.width, project.canvas.height, true, density);
              return (
                <RegionRect key={`r${i}`} box={r} canvasW={project.canvas.width} canvasH={project.canvas.height} zoom={zoom} exact density={density}>
                <Rect
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fillPatternImage={fillTile as unknown as HTMLImageElement}
                  fillPatternRepeat="repeat"
                  stroke={STEEL_100}
                  strokeWidth={(read.onBenchmark ? 2 : 1) / zoom}
                  listening={drag}
                  draggable={drag}
                  onMouseEnter={(e) => { if (drag) e.target.getStage()!.container().style.cursor = "move"; }}
                  onMouseLeave={(e) => { if (drag) e.target.getStage()!.container().style.cursor = "crosshair"; }}
                  dragBoundFunc={(pos) => {
                    // Convert stage coords → doc coords, clamp the box inside the canvas.
                    const dx = (pos.x - panX) / zoom;
                    const dy = (pos.y - panY) / zoom;
                    const cx = Math.max(0, Math.min(project.canvas.width - r.w, dx));
                    const cy = Math.max(0, Math.min(project.canvas.height - r.h, dy));
                    return { x: cx * zoom + panX, y: cy * zoom + panY };
                  }}
                  onDragStart={() => pushHistory()}
                  onDragEnd={(e) => moveRect(i, e.target.x(), e.target.y())}
                />
                </RegionRect>
              );
            })}
            {draftRect && (() => {
              const draftBox = {
                x: draftRect.w < 0 ? draftRect.x + draftRect.w : draftRect.x,
                y: draftRect.h < 0 ? draftRect.y + draftRect.h : draftRect.y,
                w: Math.abs(draftRect.w),
                h: Math.abs(draftRect.h),
              };
              const density = markDensity(project.layers, layerWidths, draftBox);
              return (
              <RegionRect box={draftRect} canvasW={project.canvas.width} canvasH={project.canvas.height} zoom={zoom} exact density={density}>
                <Rect
                  x={draftRect.x}
                  y={draftRect.y}
                  width={draftRect.w}
                  height={draftRect.h}
                  fillPatternImage={fillTile as unknown as HTMLImageElement}
                  fillPatternRepeat="repeat"
                  stroke={STEEL_100}
                  strokeWidth={
                    (regionReadout(draftBox, project.canvas.width, project.canvas.height, true, density).onBenchmark
                      ? 2
                      : 1) / zoom
                  }
                  listening={false}
                />
              </RegionRect>
              );
            })()}

            {/* Free-hand mark-brush strokes (committed) + the in-progress stroke.
                Clipped to the canvas so a wide brush near the edge doesn't paint
                outside it (the rasterized mask is doc-sized anyway — this aligns
                the visuals with the real selection). */}
            <Group
              ref={maskGroupRef}
              clipX={0}
              clipY={0}
              clipWidth={project.canvas.width}
              clipHeight={project.canvas.height}
              listening={false}
              // The strokes are drawn OPAQUE and the group carries the transparency, so
              // two strokes that cross look the same as one. Rendering each stroke at 45%
              // made every overlap compound into a darker patch — the mask read as a pile
              // of blobs rather than one continuous selection. (The mask actually sent to
              // the engine was always right; rasterizeMask paints opaque white.)
              // Group opacity only flattens like this while the group is cached, which is
              // what the effect below maintains.
              opacity={0.6}
            >
              {!compare && !showMosaic && showMask && fillBitmaps.map((b, i) => (
                <KImage key={`b${i}`} image={b} x={0} y={0} width={project.canvas.width} height={project.canvas.height} listening={false} />
              ))}
              {!compare && !showMosaic && showMask && mask.strokes.map((s, i) =>
                s.tool === "brush" ? <HatchStroke key={`s${i}`} points={s.points} width={s.size} tile={fillTile} /> : null,
              )}
              {draftStroke && draftStroke.length >= 2 && <HatchStroke points={draftStroke} width={brushSize} tile={fillTile} />}
            </Group>

            {/* Erase-brush paint. Its own cached group, for the same no-compounding reason,
                and its own colour. Shown even with the fill mask hidden: it is a pending
                destructive action, and hiding it would hide what a click will do. */}
            <Group
              ref={removeGroupRef}
              clipX={0}
              clipY={0}
              clipWidth={project.canvas.width}
              clipHeight={project.canvas.height}
              listening={false}
              opacity={0.6}
            >
              {!compare && !showMosaic && removeBitmaps.map((b, i) => (
                <KImage key={`rb${i}`} image={b} x={0} y={0} width={project.canvas.width} height={project.canvas.height} listening={false} />
              ))}
              {!compare && !showMosaic && removeMask.strokes.map((s, i) => (
                <HatchStroke key={`rs${i}`} points={s.points} width={s.size} tile={eraseTile} />
              ))}
              {draftRemove && draftRemove.length >= 2 && (
                <HatchStroke points={draftRemove} width={brushSize} tile={eraseTile} />
              )}
            </Group>

            {/* Explanatory markup, on top of everything. Its own switchable layer:
                these marks talk to the assistant and never reach the image engine. */}
            {annotations?.visible && !showMosaic && (
              <Group listening={tool === "note"}>
                {annotations.items.map((a, i) => {
                  const key = `n${i}`;
                  if (a.kind === "brush") {
                    return <Line key={key} points={a.points} stroke={a.color} strokeWidth={a.width} lineCap="round" lineJoin="round" listening={false} />;
                  }
                  if (a.kind === "arrow") {
                    return (
                      <Arrow
                        key={key}
                        points={[a.x1, a.y1, a.x2, a.y2]}
                        stroke={a.color}
                        fill={a.color}
                        strokeWidth={a.width}
                        pointerLength={a.width * 3}
                        pointerWidth={a.width * 2.6}
                        listening={false}
                      />
                    );
                  }
                  if (a.kind === "rect") {
                    return <Rect key={key} x={a.x} y={a.y} width={a.w} height={a.h} stroke={a.color} strokeWidth={a.width} listening={false} />;
                  }
                  if (a.kind === "pin") {
                    return (
                      <PinMarker
                        key={key}
                        pin={a}
                        zoom={zoom}
                        editable={tool === "note"}
                        onEdit={() => setNoteEdit({ index: i, x: a.x, y: a.y, value: a.note, pin: true, n: a.n })}
                      />
                    );
                  }
                  return (
                    <KText
                      key={key}
                      x={a.x}
                      y={a.y}
                      text={a.text}
                      fill={a.color}
                      fontSize={a.size}
                      fontStyle="600"
                      align={/[\u0590-\u05ff]/.test(a.text) ? "right" : "left"}
                      offsetX={/[\u0590-\u05ff]/.test(a.text) ? a.text.length * a.size * 0.5 : 0}
                      shadowColor="rgba(0,0,0,0.85)"
                      shadowBlur={a.size * 0.4}
                      listening={tool === "note"}
                      onDblClick={() => setNoteEdit({ index: i, x: a.x, y: a.y, value: a.text })}
                    />
                  );
                })}
              </Group>
            )}

            {/* The mark being drawn RIGHT NOW. Outside the visibility guard on purpose:
                project.annotations does not exist until the first mark is committed, so
                keeping the draft inside it meant the very first stroke was invisible
                until mouse-up. A live tool must draw while you draw. */}
            {noteDraft && !showMosaic && (
              <Group listening={false}>
                {noteDraft && noteDraft.kind === "brush" && noteDraft.points.length >= 4 && (
                  <Line points={noteDraft.points} stroke={noteDraft.color} strokeWidth={noteDraft.width} lineCap="round" lineJoin="round" listening={false} />
                )}
                {noteDraft && noteDraft.kind === "arrow" && (
                  <Arrow points={[noteDraft.x1, noteDraft.y1, noteDraft.x2, noteDraft.y2]} stroke={noteDraft.color} fill={noteDraft.color} strokeWidth={noteDraft.width} pointerLength={noteDraft.width * 3} pointerWidth={noteDraft.width * 2.6} listening={false} />
                )}
                {noteDraft && noteDraft.kind === "rect" && (
                  <Rect x={noteDraft.x} y={noteDraft.y} width={noteDraft.w} height={noteDraft.h} stroke={noteDraft.color} strokeWidth={noteDraft.width} listening={false} />
                )}
              </Group>
            )}

            {/* Brush cursor: outer = full diameter, inner = full-strength core,
                the gap between them is the feather gradient zone */}
            {showCursorRing && cursor && (
              <>
                <Circle x={cursor.x} y={cursor.y} radius={brushSize / 2} stroke="rgba(255,255,255,0.9)" strokeWidth={1 / zoom} listening={false} />
                <Circle x={cursor.x} y={cursor.y} radius={brushSize / 2} stroke="rgba(0,0,0,0.6)" strokeWidth={2 / zoom} dash={[4 / zoom, 4 / zoom]} listening={false} />
                {tool === "erase-layer" && innerR > 1 && (
                  <Circle x={cursor.x} y={cursor.y} radius={innerR} stroke="rgba(255,255,255,0.7)" strokeWidth={1 / zoom} listening={false} />
                )}
              </>
            )}

            {/* Live size/feather preview at the viewport center while adjusting
                the sliders: the gradient fill demonstrates the actual feather —
                full strength inside the inner circle, fading to zero at the edge */}
            {showBrushPreview && (() => {
              const cx = (size.w / 2 - panX) / zoom;
              const cy = (size.h / 2 - panY) / zoom;
              const outerR = brushSize / 2;
              return (
                <>
                  <Circle
                    x={cx} y={cy} radius={outerR}
                    fillRadialGradientStartPoint={{ x: 0, y: 0 }}
                    fillRadialGradientEndPoint={{ x: 0, y: 0 }}
                    fillRadialGradientStartRadius={innerR}
                    fillRadialGradientEndRadius={outerR}
                    fillRadialGradientColorStops={[0, "rgba(255,255,255,0.55)", 1, "rgba(255,255,255,0)"]}
                    listening={false}
                  />
                  <Circle x={cx} y={cy} radius={outerR} stroke="rgba(255,255,255,0.9)" strokeWidth={1 / zoom} listening={false} />
                  <Circle x={cx} y={cy} radius={outerR} stroke="rgba(0,0,0,0.6)" strokeWidth={2 / zoom} dash={[4 / zoom, 4 / zoom]} listening={false} />
                  {innerR > 1 && (
                    <Circle x={cx} y={cy} radius={innerR} stroke="rgba(255,255,255,0.8)" strokeWidth={1 / zoom} listening={false} />
                  )}
                </>
              );
            })()}
          </Group>
        </KLayer>
      </Stage>
      {/* The floating note editor. Positioned in screen space over the point that was
          clicked, so what you type sits where the note will land. */}
      {noteEdit && noteEdit.pin && noteEdit.index != null && (
        <button
          className="pin-delete"
          title="הסר את הסיכה"
          style={{ left: noteEdit.x * zoom + panX - 12, top: noteEdit.y * zoom + panY + 20 }}
          // mousedown, not click: the textarea's blur would commit and close the editor
          // before a click ever landed here.
          onMouseDown={(e) => {
            e.preventDefault();
            const index = noteEdit.index!;
            setNoteEdit(null);
            removeAnnotation(index);
          }}
        >
          ✕
        </button>
      )}
      {noteEdit && (
        <textarea
          className={`note-editor ${noteEdit.pin ? "pin-editor" : ""}`}
          autoFocus
          dir="auto"
          value={noteEdit.value}
          placeholder={noteEdit.pin ? "מה לשנות כאן? (אפשר להשאיר ריק)" : "מה לשנות כאן?"}
          style={{
            // A pin's field sits beside the pin, not over it — you should see where you
            // are writing about while you write.
            left: noteEdit.x * zoom + panX + (noteEdit.pin ? 20 : 0),
            top: noteEdit.y * zoom + panY + (noteEdit.pin ? 18 : 0),
            color: noteColor,
            fontSize: Math.max(13, Math.min(28, noteSize * 4 * zoom)),
          }}
          onChange={(e) => setNoteEdit({ ...noteEdit, value: e.target.value })}
          onBlur={commitNoteText}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              // Esc on a pin placed a moment ago means "I didn't mean to put that there".
              if (noteEdit.pin && noteEdit.fresh && noteEdit.index != null) removeAnnotation(noteEdit.index);
              setNoteEdit(null);
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitNoteText();
            }
          }}
        />
      )}
      <EraseBar />
      {compare && <div className="compare-badge">תצוגת "לפני" — מוצגת שכבת הבסיס בלבד</div>}
      {showMosaic && <div className="mosaic-badge">תצוגת מוזאיק — {mosaicLayers.length} שכבות זו לצד זו · ריחוף מסמן בפאנל</div>}
    </div>
  );
}
