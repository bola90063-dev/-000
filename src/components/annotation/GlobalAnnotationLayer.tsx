import React, { useCallback, useEffect, useRef } from 'react';
import { useAnnotation, useAnnotationToolState } from './AnnotationContext';
import {
  adjustSnappedShapeOnDrag,
  createLivePenDraftSession,
  cssBoundsToPixelRect,
  detectHoldShape,
  drawAppleHighlighterStroke,
  drawApplePenStroke,
  getSnappedShapePinPoint,
  hitTestStroke,
  renderLiveHighlighterWithSession,
  renderLivePenDraftWithSession,
  resetLivePenDraftSession,
  traceShapePath,
  unionPixelRects,
  type LivePenDraftSession,
  type PixelRect,
  type RenderTransform,
  type SnapDragBase,
} from './strokeEngine';
import type { AnnotationPoint, AnnotationShape, AnnotationStroke } from './types';

interface LaserSample {
  x: number;
  y: number;
  t: number;
}

interface LaserTrail {
  color: string;
  size: number;
  smoothing: number;
  points: LaserSample[];
  /** Optional universal snapped geometric shape/curve when user pauses briefly with laser */
  shape?: AnnotationShape;
  /** null while the pointer is held down so 100% of the stroke stays visible; timestamped on release to fade out smoothly */
  releasedAt: number | null;
}

interface LaserPulse {
  x: number;
  y: number;
  startedAt: number;
  color: string;
}

const LASER_HOLD_AFTER_RELEASE_MS = 240;
const LASER_FADE_DURATION_MS = 1320;
const LASER_PULSE_LIFE_MS = 460;
const HOLD_SNAP_DELAY_MS = 350;
const HOLD_MOVE_THRESHOLD_PX = 6;
const MAX_GLOBAL_DPR = 1.5;
const MAX_LASER_DPR = 1.5;
const SYNC_PAINT_MIN_INTERVAL_MS = 4;

const IDENTITY_TRANSFORM: RenderTransform = {
  scaleX: 1,
  scaleY: 1,
  offsetX: 0,
  offsetY: 0,
  unitScale: 1,
};

function smoothLaserSamples(raw: LaserSample[], smoothingAmount: number): LaserSample[] {
  const n = raw.length;
  if (n <= 2 || smoothingAmount <= 0.02) return raw;

  const clamped = Math.max(0, Math.min(1, smoothingAmount));

  const minDist = 1.2 + clamped * 2.0;
  const filtered: LaserSample[] = [raw[0]];
  let lastKept = raw[0];
  for (let i = 1; i < n - 1; i++) {
    const pt = raw[i];
    if (Math.hypot(pt.x - lastKept.x, pt.y - lastKept.y) >= minDist) {
      filtered.push(pt);
      lastKept = pt;
    } else {
      const next = raw[i + 1];
      const v1x = pt.x - lastKept.x;
      const v1y = pt.y - lastKept.y;
      const v2x = next.x - pt.x;
      const v2y = next.y - pt.y;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      if (l1 > 0.8 && l2 > 0.8 && (v1x * v2x + v1y * v2y) / (l1 * l2) < 0.25) {
        filtered.push(pt);
        lastKept = pt;
      }
    }
  }
  filtered.push(raw[n - 1]);

  const m = filtered.length;
  if (m <= 2) return filtered;

  const passes = clamped >= 0.72 ? 4 : clamped >= 0.38 ? 3 : 2;
  const strength = 0.26 + clamped * 0.46;

  let cur = filtered;
  for (let pass = 0; pass < passes; pass++) {
    const next: LaserSample[] = new Array(m);
    next[0] = cur[0];
    next[m - 1] = cur[m - 1];
    for (let i = 1; i < m - 1; i++) {
      const prev = cur[i - 1];
      const pt = cur[i];
      const after = cur[i + 1];

      const v1x = pt.x - prev.x;
      const v1y = pt.y - prev.y;
      const v2x = after.x - pt.x;
      const v2y = after.y - pt.y;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      let cornerFactor = 1.0;
      if (l1 > 0.001 && l2 > 0.001) {
        const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
        cornerFactor = Math.max(0.1, Math.min(1.0, (dot + 0.15) / 0.85));
      }

      let tx: number;
      let ty: number;
      if (i >= 2 && i <= m - 3) {
        const prev2 = cur[i - 2];
        const after2 = cur[i + 2];
        tx = 0.08 * prev2.x + 0.22 * prev.x + 0.4 * pt.x + 0.22 * after.x + 0.08 * after2.x;
        ty = 0.08 * prev2.y + 0.22 * prev.y + 0.4 * pt.y + 0.22 * after.y + 0.08 * after2.y;
      } else {
        tx = 0.25 * prev.x + 0.5 * pt.x + 0.25 * after.x;
        ty = 0.25 * prev.y + 0.5 * pt.y + 0.25 * after.y;
      }

      const alpha = strength * cornerFactor;
      next[i] = {
        x: pt.x + (tx - pt.x) * alpha,
        y: pt.y + (ty - pt.y) * alpha,
        t: pt.t,
      };
    }
    cur = next;
  }
  return cur;
}

function traceSmoothLaserPath(ctx: CanvasRenderingContext2D, pts: LaserSample[]): void {
  const n = pts.length;
  if (n < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (n === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }
  for (let i = 1; i < n - 1; i++) {
    const midX = (pts[i].x + pts[i + 1].x) * 0.5;
    const midY = (pts[i].y + pts[i + 1].y) * 0.5;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
  }
  ctx.lineTo(pts[n - 1].x, pts[n - 1].y);
}

const LASER_CHROME_CONTROLS_SELECTOR =
  '[data-annotation-ui="true"], #main-header, .mushaf-sticky-hud, .mushaf-toolbar-row, .mushaf-toolbar, .mushaf-teacher-dock, .mushaf-bookmarks-popover, .mushaf-side-nav-rail, .mushaf-pagination-bar, .mushaf-liquid-lens-header, .mushaf-liquid-lens-footer, .nav-tabs, .topic-dropdown-wrapper, select, input, textarea';

function getElementFromTarget(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Mounted inside `.app` (below `#main-header` z-index 100).
 * Provides an automatic document-anchored Apple Pen / Highlighter / Eraser canvas
 * for any program screen without a dedicated bounded canvas (e.g., Tajweed, Home).
 *
 * Completely unmounts its fixed canvases whenever a bounded surface (such as the Mushaf)
 * is mounted so Chrome NEVER runs an idle full-screen `mix-blend-mode: multiply` pass!
 */
export const GlobalAnnotationLayer: React.FC = () => {
  const {
    activeTool,
    penSettings,
    highlighterSettings,
    eraserSettings,
    activeSurfaceId,
    hasBoundedSurface,
    getStrokes,
    addStroke,
    removeStrokes,
  } = useAnnotation();

  const hlCanvasRef = useRef<HTMLCanvasElement>(null);
  const penCanvasRef = useRef<HTMLCanvasElement>(null);
  const draftCanvasRef = useRef<HTMLCanvasElement>(null);

  const hlCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const penCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const draftCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const committedHlCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const committedHlCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasCommittedHlRef = useRef(false);

  const renderedStrokesRef = useRef<AnnotationStroke[]>([]);
  const renderedSurfaceIdRef = useRef<string | null>(null);
  const prevDraftRectRef = useRef<PixelRect | null>(null);
  const prevHlDraftRectRef = useRef<PixelRect | null>(null);

  const activePointerIdRef = useRef<number | null>(null);
  const draftRef = useRef<AnnotationStroke | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdDeadlineRef = useRef<number>(0);
  const holdAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const snapPulseRef = useRef<{ x: number; y: number; color: string; startedAt: number } | null>(null);
  const erasePulseRef = useRef<{ x: number; y: number; startedAt: number } | null>(null);
  const snapBaseRef = useRef<SnapDragBase | null>(null);
  const livePenSessionRef = useRef<LivePenDraftSession | null>(null);
  const drawRafRef = useRef<number>(0);
  const dirtyLiveRef = useRef<{ draft: boolean; hl: boolean }>({ draft: false, hl: false });
  const lastLivePaintTsRef = useRef<number>(0);
  const anchorOriginRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 });
  const canvasRectRef = useRef<{ left: number; top: number; width: number; height: number }>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });

  const globalSurfaceId = !hasBoundedSurface ? activeSurfaceId : null;
  const globalStrokes = globalSurfaceId ? getStrokes(globalSurfaceId) : [];
  const globalStrokesRef = useRef(globalStrokes);
  globalStrokesRef.current = globalStrokes;

  const isGlobalDrawActive =
    !hasBoundedSurface &&
    (activeTool === 'pen' || activeTool === 'highlighter' || activeTool === 'eraser');

  const getHlCtx = useCallback((): CanvasRenderingContext2D | null => {
    if (!hlCtxRef.current && hlCanvasRef.current) {
      hlCtxRef.current = hlCanvasRef.current.getContext('2d');
    }
    return hlCtxRef.current;
  }, []);

  const getPenCtx = useCallback((): CanvasRenderingContext2D | null => {
    if (!penCtxRef.current && penCanvasRef.current) {
      penCtxRef.current = penCanvasRef.current.getContext('2d');
    }
    return penCtxRef.current;
  }, []);

  const getDraftCtx = useCallback((): CanvasRenderingContext2D | null => {
    if (!draftCtxRef.current && draftCanvasRef.current) {
      draftCtxRef.current = draftCanvasRef.current.getContext('2d');
    }
    return draftCtxRef.current;
  }, []);

  const ensureCommittedHlBuffer = useCallback((pw: number, ph: number): CanvasRenderingContext2D | null => {
    if (!committedHlCanvasRef.current) {
      committedHlCanvasRef.current = document.createElement('canvas');
      committedHlCtxRef.current = committedHlCanvasRef.current.getContext('2d');
    }
    const cHl = committedHlCanvasRef.current;
    if (cHl.width !== pw || cHl.height !== ph) {
      cHl.width = pw;
      cHl.height = ph;
    }
    return committedHlCtxRef.current;
  }, []);

  const ensureScratchCanvas = useCallback((): HTMLCanvasElement => {
    if (!scratchCanvasRef.current) {
      scratchCanvasRef.current = document.createElement('canvas');
    }
    return scratchCanvasRef.current;
  }, []);

  const refreshGlobalGeometry = useCallback(() => {
    const appEl = document.querySelector('.app');
    if (appEl) {
      const r = appEl.getBoundingClientRect();
      anchorOriginRef.current = { left: r.left, top: r.top };
    } else {
      anchorOriginRef.current = { left: -window.scrollX, top: -window.scrollY };
    }
    const penCanvas = penCanvasRef.current;
    if (penCanvas) {
      const r = penCanvas.getBoundingClientRect();
      canvasRectRef.current = {
        left: r.left,
        top: r.top,
        width: r.width || document.documentElement.clientWidth || window.innerWidth,
        height: r.height || document.documentElement.clientHeight || window.innerHeight,
      };
    }
  }, []);

  const getCachedGlobalTransform = useCallback((): RenderTransform => {
    const origin = anchorOriginRef.current;
    const cRect = canvasRectRef.current;
    return {
      scaleX: 1,
      scaleY: 1,
      offsetX: origin.left - cRect.left,
      offsetY: origin.top - cRect.top,
      unitScale: 1,
    };
  }, []);

  const syncGlobalCanvasDimensions = useCallback((): { vw: number; vh: number; pw: number; ph: number } | null => {
    const hlCanvas = hlCanvasRef.current;
    const penCanvas = penCanvasRef.current;
    const draftCanvas = draftCanvasRef.current;
    if (!hlCanvas || !penCanvas || !draftCanvas) return null;

    const cRect = canvasRectRef.current;
    const vw = cRect.width || document.documentElement.clientWidth || window.innerWidth;
    const vh = cRect.height || document.documentElement.clientHeight || window.innerHeight;
    if (vw <= 0 || vh <= 0) return null;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_GLOBAL_DPR);
    const pw = Math.max(1, Math.round(vw * dpr));
    const ph = Math.max(1, Math.round(vh * dpr));

    if (
      hlCanvas.width !== pw ||
      hlCanvas.height !== ph ||
      penCanvas.width !== pw ||
      penCanvas.height !== ph ||
      draftCanvas.width !== pw ||
      draftCanvas.height !== ph
    ) {
      hlCanvas.width = pw;
      hlCanvas.height = ph;
      penCanvas.width = pw;
      penCanvas.height = ph;
      draftCanvas.width = pw;
      draftCanvas.height = ph;
      prevDraftRectRef.current = null;
      prevHlDraftRectRef.current = null;
    }
    return { vw, vh, pw, ph };
  }, []);

  const clearGlobalDraftOverlay = useCallback(() => {
    const draftCanvas = draftCanvasRef.current;
    const dCtx = getDraftCtx();
    const prev = prevDraftRectRef.current;
    if (dCtx && draftCanvas && prev) {
      dCtx.save();
      dCtx.setTransform(1, 0, 0, 1, 0, 0);
      dCtx.clearRect(prev.x, prev.y, prev.w, prev.h);
      dCtx.restore();
    }
    if (livePenSessionRef.current) {
      resetLivePenDraftSession(livePenSessionRef.current);
    }
    prevDraftRectRef.current = null;
    if (draftCanvas) {
      if (draftCanvas.style.opacity !== '') {
        draftCanvas.style.opacity = '';
      }
      if (!snapPulseRef.current && !erasePulseRef.current && draftCanvas.style.display !== 'none') {
        draftCanvas.style.display = 'none';
      }
    }
  }, [getDraftCtx]);

  const restoreGlobalHlDraftArea = useCallback(() => {
    const prev = prevHlDraftRectRef.current;
    if (!prev) return;
    const hlCanvas = hlCanvasRef.current;
    const hlCtx = getHlCtx();
    if (hlCtx && hlCanvas) {
      hlCtx.save();
      hlCtx.setTransform(1, 0, 0, 1, 0, 0);
      hlCtx.clearRect(prev.x, prev.y, prev.w, prev.h);
      if (hasCommittedHlRef.current && committedHlCanvasRef.current) {
        hlCtx.drawImage(
          committedHlCanvasRef.current,
          prev.x,
          prev.y,
          prev.w,
          prev.h,
          prev.x,
          prev.y,
          prev.w,
          prev.h
        );
      }
      hlCtx.restore();
    }
    prevHlDraftRectRef.current = null;
    if (hlCanvas && !hasCommittedHlRef.current) {
      hlCanvas.style.display = 'none';
    }
  }, [getHlCtx]);

  const stampGlobalCommittedStroke = useCallback(
    (stroke: AnnotationStroke, clearPrevHlDraft = false) => {
      if (hasBoundedSurface) return;
      const dims = syncGlobalCanvasDimensions();
      const hlCanvas = hlCanvasRef.current;
      if (!dims || !hlCanvas) return;

      const { vw, vh, pw, ph } = dims;
      const dprX = pw / vw;
      const dprY = ph / vh;
      const tf = getCachedGlobalTransform();

      if (stroke.kind === 'pen') {
        const penCtx = getPenCtx();
        if (!penCtx) return;
        penCtx.save();
        penCtx.setTransform(dprX, 0, 0, dprY, 0, 0);
        drawApplePenStroke(penCtx, stroke, tf, false);
        penCtx.restore();
        return;
      }

      if (stroke.kind === 'highlighter') {
        const cHlCtx = ensureCommittedHlBuffer(pw, ph);
        const hlCtx = getHlCtx();
        if (!cHlCtx || !hlCtx) return;

        if (!hasCommittedHlRef.current && committedHlCanvasRef.current) {
          cHlCtx.save();
          cHlCtx.setTransform(1, 0, 0, 1, 0, 0);
          cHlCtx.clearRect(0, 0, pw, ph);
          cHlCtx.restore();
        }

        const scratch = ensureScratchCanvas();
        const finalRect = drawAppleHighlighterStroke(cHlCtx, scratch, stroke, tf, dprX, dprY, false);
        hasCommittedHlRef.current = true;
        if (hlCanvas.style.display !== 'block') {
          hlCanvas.style.display = 'block';
        }

        const dirty = clearPrevHlDraft
          ? unionPixelRects(prevHlDraftRectRef.current, finalRect)
          : finalRect;
        prevHlDraftRectRef.current = null;

        if (dirty && committedHlCanvasRef.current) {
          hlCtx.save();
          hlCtx.setTransform(1, 0, 0, 1, 0, 0);
          hlCtx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
          hlCtx.drawImage(
            committedHlCanvasRef.current,
            dirty.x,
            dirty.y,
            dirty.w,
            dirty.h,
            dirty.x,
            dirty.y,
            dirty.w,
            dirty.h
          );
          hlCtx.restore();
        }
      }
    },
    [
      ensureCommittedHlBuffer,
      ensureScratchCanvas,
      getCachedGlobalTransform,
      getHlCtx,
      getPenCtx,
      hasBoundedSurface,
      syncGlobalCanvasDimensions,
    ]
  );

  const rebuildGlobalCommittedLayers = useCallback(() => {
    if (hasBoundedSurface) return;
    refreshGlobalGeometry();
    const dims = syncGlobalCanvasDimensions();
    const hlCanvas = hlCanvasRef.current;
    const draftCanvas = draftCanvasRef.current;
    if (!dims || !hlCanvas) return;

    const { vw, vh, pw, ph } = dims;
    const dprX = pw / vw;
    const dprY = ph / vh;
    const list = globalStrokesRef.current;

    let hasHl = false;
    let hasPen = false;
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === 'highlighter') hasHl = true;
      else if (list[i].kind === 'pen') hasPen = true;
    }
    hasCommittedHlRef.current = hasHl;

    const tf = getCachedGlobalTransform();
    const hlCtx = getHlCtx();

    if (hasHl && hlCtx) {
      const cHlCtx = ensureCommittedHlBuffer(pw, ph);
      const scratch = ensureScratchCanvas();
      if (cHlCtx && committedHlCanvasRef.current) {
        cHlCtx.save();
        cHlCtx.setTransform(1, 0, 0, 1, 0, 0);
        cHlCtx.clearRect(0, 0, pw, ph);
        cHlCtx.restore();
        for (let i = 0; i < list.length; i++) {
          if (list[i].kind === 'highlighter') {
            drawAppleHighlighterStroke(cHlCtx, scratch, list[i], tf, dprX, dprY, false);
          }
        }
        hlCtx.save();
        hlCtx.setTransform(1, 0, 0, 1, 0, 0);
        hlCtx.clearRect(0, 0, pw, ph);
        hlCtx.drawImage(committedHlCanvasRef.current, 0, 0);
        hlCtx.restore();
      }
      if (hlCanvas.style.display !== 'block') {
        hlCanvas.style.display = 'block';
      }
    } else {
      if (committedHlCtxRef.current && committedHlCanvasRef.current) {
        committedHlCtxRef.current.clearRect(
          0,
          0,
          committedHlCanvasRef.current.width,
          committedHlCanvasRef.current.height
        );
      }
      if (hlCtx) {
        hlCtx.save();
        hlCtx.setTransform(1, 0, 0, 1, 0, 0);
        hlCtx.clearRect(0, 0, pw, ph);
        hlCtx.restore();
      }
      if (draftRef.current?.kind !== 'highlighter' && hlCanvas.style.display !== 'none') {
        hlCanvas.style.display = 'none';
      }
    }
    prevHlDraftRectRef.current = null;

    const penCtx = getPenCtx();
    if (penCtx) {
      penCtx.save();
      penCtx.setTransform(1, 0, 0, 1, 0, 0);
      penCtx.clearRect(0, 0, pw, ph);
      if (hasPen) {
        penCtx.scale(dprX, dprY);
        for (let i = 0; i < list.length; i++) {
          if (list[i].kind === 'pen') {
            drawApplePenStroke(penCtx, list[i], tf, false);
          }
        }
      }
      penCtx.restore();
    }

    if (draftCanvas) {
      const dCtx = getDraftCtx();
      if (dCtx) {
        dCtx.save();
        dCtx.setTransform(1, 0, 0, 1, 0, 0);
        dCtx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
        dCtx.restore();
      }
      prevDraftRectRef.current = null;
      if (!draftRef.current && !snapPulseRef.current && !erasePulseRef.current) {
        draftCanvas.style.display = 'none';
      }
    }

    renderedStrokesRef.current = list.slice();
    renderedSurfaceIdRef.current = globalSurfaceId;
  }, [
    ensureCommittedHlBuffer,
    ensureScratchCanvas,
    getCachedGlobalTransform,
    getDraftCtx,
    getHlCtx,
    getPenCtx,
    globalSurfaceId,
    hasBoundedSurface,
    refreshGlobalGeometry,
    syncGlobalCanvasDimensions,
  ]);

  const renderGlobalLiveDraft = useCallback(() => {
    if (drawRafRef.current) {
      cancelAnimationFrame(drawRafRef.current);
      drawRafRef.current = 0;
    }
    if (hasBoundedSurface) return;

    const hlCanvas = hlCanvasRef.current;
    const draftCanvas = draftCanvasRef.current;
    if (!hlCanvas || !draftCanvas) return;

    const dims = syncGlobalCanvasDimensions();
    if (!dims) return;
    const { vw, vh, pw, ph } = dims;
    const dprX = pw / vw;
    const dprY = ph / vh;

    const draft = draftRef.current;
    const redrawHl = dirtyLiveRef.current.hl;
    const redrawDraft = dirtyLiveRef.current.draft;
    dirtyLiveRef.current.hl = false;
    dirtyLiveRef.current.draft = false;

    const tf = getCachedGlobalTransform();

    if (redrawHl) {
      const hlCtx = getHlCtx();
      if (hlCtx) {
        const isHlDraft = draft && draft.kind === 'highlighter';
        if (isHlDraft) {
          if (hlCanvas.style.display !== 'block') {
            hlCanvas.style.display = 'block';
          }
          const scratch = ensureScratchCanvas();
          if (!livePenSessionRef.current) {
            livePenSessionRef.current = createLivePenDraftSession();
          }
          const currRect = renderLiveHighlighterWithSession(
            scratch,
            livePenSessionRef.current,
            draft,
            tf,
            dprX,
            dprY,
            pw,
            ph
          );
          const dirty = unionPixelRects(prevHlDraftRectRef.current, currRect);
          if (dirty) {
            hlCtx.save();
            hlCtx.setTransform(1, 0, 0, 1, 0, 0);
            hlCtx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
            if (hasCommittedHlRef.current && committedHlCanvasRef.current) {
              hlCtx.drawImage(
                committedHlCanvasRef.current,
                dirty.x,
                dirty.y,
                dirty.w,
                dirty.h,
                dirty.x,
                dirty.y,
                dirty.w,
                dirty.h
              );
            }
            if (currRect) {
              hlCtx.globalCompositeOperation = 'multiply';
              hlCtx.globalAlpha = draft.opacity;
              hlCtx.drawImage(
                scratch,
                currRect.x,
                currRect.y,
                currRect.w,
                currRect.h,
                currRect.x,
                currRect.y,
                currRect.w,
                currRect.h
              );
            }
            hlCtx.restore();
          }
          prevHlDraftRectRef.current = currRect;
        } else {
          restoreGlobalHlDraftArea();
        }
      }
    }

    let needsMoreFrames = false;
    const hasSnappedShape = Boolean(draft && draft.shape);
    if (redrawDraft || snapPulseRef.current || erasePulseRef.current || hasSnappedShape) {
      const hasPenDraft = Boolean(draft && draft.kind === 'pen');
      const hasWork =
        hasPenDraft ||
        hasSnappedShape ||
        Boolean(snapPulseRef.current) ||
        Boolean(erasePulseRef.current);

      if (hasWork && draftCanvas.style.display !== 'block') {
        draftCanvas.style.display = 'block';
      }

      const dCtx = getDraftCtx();
      if (dCtx) {
        let nextRect: PixelRect | null = null;
        const prevRect = prevDraftRectRef.current;

        if (draft && draft.kind === 'pen') {
          if (!livePenSessionRef.current) {
            livePenSessionRef.current = createLivePenDraftSession();
          }
          nextRect = renderLivePenDraftWithSession(
            dCtx,
            draftCanvas,
            livePenSessionRef.current,
            draft,
            tf,
            dprX,
            dprY,
            pw,
            ph,
            prevRect
          );
        } else {
          if (draftCanvas.style.opacity !== '') {
            draftCanvas.style.opacity = '';
          }
          if (
            (!draft || draft.kind !== 'highlighter') &&
            livePenSessionRef.current &&
            (livePenSessionRef.current.strokeId || livePenSessionRef.current.frozenBounds)
          ) {
            resetLivePenDraftSession(livePenSessionRef.current);
          }
          if (prevRect) {
            dCtx.save();
            dCtx.setTransform(1, 0, 0, 1, 0, 0);
            dCtx.clearRect(prevRect.x, prevRect.y, prevRect.w, prevRect.h);
            dCtx.restore();
          }
        }

        const pinPt =
          draft && draft.shape
            ? getSnappedShapePinPoint(draft.shape, snapBaseRef.current, tf)
            : null;
        if (pinPt || snapPulseRef.current || erasePulseRef.current) {
          dCtx.save();
          dCtx.setTransform(dprX, 0, 0, dprY, 0, 0);

          if (pinPt && draft) {
            const pinColor = draft.kind === 'highlighter' ? '#007AFF' : draft.color;
            dCtx.save();
            dCtx.globalAlpha = 0.72;
            dCtx.beginPath();
            dCtx.arc(pinPt.x, pinPt.y, 4.2, 0, Math.PI * 2);
            dCtx.fillStyle = '#FFFFFF';
            dCtx.fill();
            dCtx.lineWidth = 1.6;
            dCtx.strokeStyle = pinColor;
            dCtx.stroke();
            dCtx.beginPath();
            dCtx.arc(pinPt.x, pinPt.y, 1.5, 0, Math.PI * 2);
            dCtx.fillStyle = pinColor;
            dCtx.fill();
            dCtx.restore();
            nextRect = unionPixelRects(
              nextRect,
              cssBoundsToPixelRect(
                { minX: pinPt.x - 8, minY: pinPt.y - 8, maxX: pinPt.x + 8, maxY: pinPt.y + 8 },
                dprX,
                dprY,
                pw,
                ph
              )
            );
          }

          const pulse = snapPulseRef.current;
          if (pulse) {
            const elapsed = performance.now() - pulse.startedAt;
            if (elapsed < 380) {
              const p = elapsed / 380;
              const ease = 1 - Math.pow(1 - p, 3);
              const outerR = 5 + ease * 21;
              const fade = Math.pow(1 - p, 1.35);
              dCtx.save();
              dCtx.beginPath();
              dCtx.arc(pulse.x, pulse.y, outerR, 0, Math.PI * 2);
              dCtx.strokeStyle = hexToRgba(pulse.color, fade * 0.58);
              dCtx.lineWidth = 1.9 * (1 - p * 0.35);
              dCtx.stroke();

              dCtx.beginPath();
              dCtx.arc(pulse.x, pulse.y, 2.5 + ease * 11, 0, Math.PI * 2);
              dCtx.strokeStyle = `rgba(255, 255, 255, ${fade * 0.85})`;
              dCtx.lineWidth = 1.15;
              dCtx.stroke();
              dCtx.restore();

              const pad = outerR + 4;
              nextRect = unionPixelRects(
                nextRect,
                cssBoundsToPixelRect(
                  { minX: pulse.x - pad, minY: pulse.y - pad, maxX: pulse.x + pad, maxY: pulse.y + pad },
                  dprX,
                  dprY,
                  pw,
                  ph
                )
              );
              needsMoreFrames = true;
            } else {
              snapPulseRef.current = null;
            }
          }

          const erasePulse = erasePulseRef.current;
          if (erasePulse) {
            const elapsed = performance.now() - erasePulse.startedAt;
            if (elapsed < 260) {
              const p = elapsed / 260;
              const ease = 1 - Math.pow(1 - p, 3);
              const fade = 1 - p;
              const r = 7 + ease * 15;
              dCtx.save();
              dCtx.beginPath();
              dCtx.arc(erasePulse.x, erasePulse.y, r, 0, Math.PI * 2);
              dCtx.strokeStyle = `rgba(236, 72, 153, ${fade * 0.42})`;
              dCtx.lineWidth = 1.5;
              dCtx.stroke();
              dCtx.restore();

              const pad = r + 4;
              nextRect = unionPixelRects(
                nextRect,
                cssBoundsToPixelRect(
                  {
                    minX: erasePulse.x - pad,
                    minY: erasePulse.y - pad,
                    maxX: erasePulse.x + pad,
                    maxY: erasePulse.y + pad,
                  },
                  dprX,
                  dprY,
                  pw,
                  ph
                )
              );
              needsMoreFrames = true;
            } else {
              erasePulseRef.current = null;
            }
          }

          dCtx.restore();
        }

        prevDraftRectRef.current = nextRect;
        if (!nextRect && !needsMoreFrames && draftCanvas.style.display !== 'none') {
          draftCanvas.style.display = 'none';
        }
      }
    }

    if (needsMoreFrames) {
      dirtyLiveRef.current.draft = true;
      drawRafRef.current = requestAnimationFrame(renderGlobalLiveDraft);
    }
  }, [
    ensureScratchCanvas,
    getCachedGlobalTransform,
    getDraftCtx,
    getHlCtx,
    hasBoundedSurface,
    restoreGlobalHlDraftArea,
    syncGlobalCanvasDimensions,
  ]);

  const scheduleGlobalDraw = useCallback(
    (layers: { draft?: boolean; hl?: boolean }) => {
      if (layers.draft) dirtyLiveRef.current.draft = true;
      if (layers.hl) dirtyLiveRef.current.hl = true;
      if (drawRafRef.current) return;
      drawRafRef.current = requestAnimationFrame(renderGlobalLiveDraft);
    },
    [renderGlobalLiveDraft]
  );

  const paintGlobalLiveNow = useCallback(
    (layers: { draft?: boolean; hl?: boolean }) => {
      if (layers.draft) dirtyLiveRef.current.draft = true;
      if (layers.hl) dirtyLiveRef.current.hl = true;
      const now = performance.now();
      if (now - lastLivePaintTsRef.current >= SYNC_PAINT_MIN_INTERVAL_MS) {
        lastLivePaintTsRef.current = now;
        renderGlobalLiveDraft();
        return;
      }
      if (!drawRafRef.current) {
        drawRafRef.current = requestAnimationFrame(renderGlobalLiveDraft);
      }
    },
    [renderGlobalLiveDraft]
  );

  useEffect(() => {
    if (hasBoundedSurface) {
      hlCtxRef.current = null;
      penCtxRef.current = null;
      draftCtxRef.current = null;
      renderedStrokesRef.current = [];
      renderedSurfaceIdRef.current = null;
      return;
    }

    const surfaceChanged = renderedSurfaceIdRef.current !== globalSurfaceId;
    if (surfaceChanged) {
      rebuildGlobalCommittedLayers();
      return;
    }

    const prev = renderedStrokesRef.current;
    const curr = globalStrokes;

    if (prev.length === curr.length) {
      let same = true;
      for (let i = 0; i < curr.length; i++) {
        if (prev[i] !== curr[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }

    if (curr.length > prev.length) {
      let prefixMatches = true;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i] !== curr[i]) {
          prefixMatches = false;
          break;
        }
      }
      if (prefixMatches) {
        for (let i = prev.length; i < curr.length; i++) {
          stampGlobalCommittedStroke(curr[i], false);
        }
        renderedStrokesRef.current = curr.slice();
        return;
      }
    }

    rebuildGlobalCommittedLayers();
  }, [
    globalStrokes,
    globalSurfaceId,
    hasBoundedSurface,
    rebuildGlobalCommittedLayers,
    stampGlobalCommittedStroke,
  ]);

  useEffect(() => {
    if (hasBoundedSurface) return;
    let scrollRaf = 0;
    const onScrollOrResize = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        rebuildGlobalCommittedLayers();
      });
    };
    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize);
      window.removeEventListener('resize', onScrollOrResize);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (drawRafRef.current) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = 0;
      }
      if (holdTimerRef.current) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
  }, [hasBoundedSurface, rebuildGlobalCommittedLayers]);

  useEffect(() => {
    document.body.classList.remove('is-annotation-drawing');
    if (draftRef.current) {
      draftRef.current = null;
      clearGlobalDraftOverlay();
      restoreGlobalHlDraftArea();
    }
    snapBaseRef.current = null;
    activePointerIdRef.current = null;
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, [activeTool, activeSurfaceId, hasBoundedSurface, clearGlobalDraftOverlay, restoreGlobalHlDraftArea]);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const armHoldSnapTimer = useCallback(
    (clientX: number, clientY: number) => {
      const draft = draftRef.current;
      if (!draft) return;
      if (draft.kind === 'pen' && !penSettings.smartShapes) return;
      if (draft.kind === 'highlighter' && !highlighterSettings.straightAssist) return;

      holdAnchorRef.current = { x: clientX, y: clientY };
      holdDeadlineRef.current = performance.now() + HOLD_SNAP_DELAY_MS;
      if (holdTimerRef.current !== null) return;

      const scheduleCheck = (delayMs: number) => {
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null;
          const cur = draftRef.current;
          if (!cur || cur.shape) return;
          const remaining = holdDeadlineRef.current - performance.now();
          if (remaining > 18) {
            scheduleCheck(remaining);
            return;
          }
          if (cur.points.length < 4) return;
          const detected = detectHoldShape(cur.points, 1, 1, cur.kind === 'pen');
          if (detected) {
            const lastPt = cur.points[cur.points.length - 1];
            snapBaseRef.current = {
              shape: detected,
              anchorX: lastPt.x,
              anchorY: lastPt.y,
            };
            cur.shape = detected;
            const cRect = canvasRectRef.current;
            const anchor = holdAnchorRef.current;
            snapPulseRef.current = {
              x: (anchor ? anchor.x : clientX) - cRect.left,
              y: (anchor ? anchor.y : clientY) - cRect.top,
              color: cur.kind === 'highlighter' ? '#007AFF' : cur.color,
              startedAt: performance.now(),
            };
            scheduleGlobalDraw({ draft: true, hl: cur.kind === 'highlighter' });
          }
        }, delayMs);
      };

      scheduleCheck(HOLD_SNAP_DELAY_MS);
    },
    [penSettings.smartShapes, highlighterSettings.straightAssist, scheduleGlobalDraw]
  );

  const eraseGlobalAt = useCallback(
    (clientX: number, clientY: number) => {
      if (!globalSurfaceId) return;
      const tf = getCachedGlobalTransform();
      const cRect = canvasRectRef.current;
      const localX = clientX - cRect.left;
      const localY = clientY - cRect.top;
      const radiusPx = Math.max(10, eraserSettings.size * 0.55);
      const hitIds: string[] = [];
      const list = globalStrokesRef.current;
      for (let i = 0; i < list.length; i++) {
        if (hitTestStroke(localX, localY, list[i], radiusPx, tf)) {
          hitIds.push(list[i].id);
        }
      }
      if (hitIds.length > 0) {
        erasePulseRef.current = { x: localX, y: localY, startedAt: performance.now() };
        removeStrokes(globalSurfaceId, hitIds);
        scheduleGlobalDraw({ draft: true });
      }
    },
    [eraserSettings.size, getCachedGlobalTransform, globalSurfaceId, removeStrokes, scheduleGlobalDraw]
  );

  const handleGlobalPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isGlobalDrawActive || !globalSurfaceId) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    if (canvasRectRef.current.width <= 0) {
      refreshGlobalGeometry();
    }
    const origin = anchorOriginRef.current;
    const docX = e.clientX - origin.left;
    const docY = e.clientY - origin.top;

    if (typeof window.focus === 'function' && !document.hasFocus()) {
      window.focus();
    }

    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic/unsupported pointer capture errors
    }
    activePointerIdRef.current = e.pointerId;
    document.body.classList.add('is-annotation-drawing');

    if (activeTool === 'eraser') {
      eraseGlobalAt(e.clientX, e.clientY);
      return;
    }

    const pt: AnnotationPoint = {
      x: docX,
      y: docY,
      pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
      t: performance.now(),
    };

    const isHighlighter = activeTool === 'highlighter';
    snapBaseRef.current = null;
    draftRef.current = {
      id: `gst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind: isHighlighter ? 'highlighter' : 'pen',
      color: isHighlighter ? highlighterSettings.color : penSettings.color,
      size: isHighlighter ? highlighterSettings.size : penSettings.size,
      opacity: isHighlighter ? highlighterSettings.opacity : penSettings.opacity,
      smoothing: isHighlighter ? highlighterSettings.smoothing : penSettings.smoothing,
      points: [pt],
      shape: e.shiftKey ? { type: 'line', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y } : undefined,
    };

    if (draftCanvasRef.current) {
      draftCanvasRef.current.style.opacity =
        !isHighlighter && penSettings.opacity < 0.999 ? String(penSettings.opacity) : '';
    }

    armHoldSnapTimer(e.clientX, e.clientY);
    dirtyLiveRef.current = { draft: !isHighlighter, hl: isHighlighter };
    lastLivePaintTsRef.current = performance.now();
    renderGlobalLiveDraft();
  };

  const handleGlobalPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isGlobalDrawActive) return;

    if (activeTool === 'eraser') {
      if (activePointerIdRef.current === e.pointerId) {
        eraseGlobalAt(e.clientX, e.clientY);
      }
      return;
    }

    if (activePointerIdRef.current !== e.pointerId || !draftRef.current) return;
    const draft = draftRef.current;
    const origin = anchorOriginRef.current;
    const nowTs = performance.now();

    if (draft.shape) {
      const rawPt: AnnotationPoint = {
        x: e.clientX - origin.left,
        y: e.clientY - origin.top,
        pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
        t: nowTs,
      };
      draft.shape = adjustSnappedShapeOnDrag(draft.shape, rawPt, 1, 1, snapBaseRef.current);
      paintGlobalLiveNow(draft.kind === 'highlighter' ? { hl: true, draft: true } : { draft: true });
      return;
    }

    const samples =
      typeof e.nativeEvent.getCoalescedEvents === 'function'
        ? e.nativeEvent.getCoalescedEvents()
        : null;
    const sampleCount = samples && samples.length > 0 ? samples.length : 0;
    const smoothThresh = penSettings.smoothing > 0.1 ? 2.4 : 1.3;
    let didAppend = false;

    const loopLen = sampleCount > 0 ? sampleCount : 1;
    for (let i = 0; i < loopLen; i++) {
      const ev = sampleCount > 0 ? samples![i] : e.nativeEvent;
      const sx = ev.clientX - origin.left;
      const sy = ev.clientY - origin.top;
      const prev = draft.points[draft.points.length - 1];
      const minStepPx =
        draft.kind === 'highlighter'
          ? 3.0
          : ev.pointerType === 'pen'
          ? 1.6
          : smoothThresh;
      const dx = sx - prev.x;
      const dy = sy - prev.y;
      if (dx * dx + dy * dy < minStepPx * minStepPx) continue;

      let finalY = sy;
      if (draft.kind === 'highlighter' && highlighterSettings.straightAssist && draft.points.length >= 2) {
        const first = draft.points[0];
        const totalDx = Math.abs(sx - first.x);
        const totalDy = Math.abs(sy - first.y);
        if (totalDx > 14 && totalDy < Math.max(12, totalDx * 0.14)) {
          finalY = prev.y * 0.72 + first.y * 0.16 + sy * 0.12;
        }
      }

      draft.points.push({
        x: sx,
        y: finalY,
        pressure: ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 0.5,
        t: nowTs,
      });
      didAppend = true;
    }

    if (!didAppend) return;

    const anchor = holdAnchorRef.current;
    if (
      !anchor ||
      (e.clientX - anchor.x) * (e.clientX - anchor.x) +
        (e.clientY - anchor.y) * (e.clientY - anchor.y) >
        HOLD_MOVE_THRESHOLD_PX * HOLD_MOVE_THRESHOLD_PX
    ) {
      armHoldSnapTimer(e.clientX, e.clientY);
    }
    paintGlobalLiveNow(draft.kind === 'highlighter' ? { hl: true } : { draft: true });
  };

  const commitGlobalPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    activePointerIdRef.current = null;
    document.body.classList.remove('is-annotation-drawing');
    clearHoldTimer();
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore release errors
    }

    if (activeTool === 'eraser') {
      return;
    }

    const draft = draftRef.current;
    draftRef.current = null;
    snapBaseRef.current = null;
    if (draft && globalSurfaceId && (draft.points.length > 0 || draft.shape)) {
      if (draft.kind === 'pen') {
        stampGlobalCommittedStroke(draft, false);
        clearGlobalDraftOverlay();
      } else {
        stampGlobalCommittedStroke(draft, true);
        clearGlobalDraftOverlay();
      }
      renderedStrokesRef.current = [...renderedStrokesRef.current, draft];
      addStroke(globalSurfaceId, draft);
    } else {
      clearGlobalDraftOverlay();
      restoreGlobalHlDraftArea();
    }
  };

  // Do NOT mount full-screen fixed canvases while a bounded surface (e.g. Mushaf) owns drawing!
  if (hasBoundedSurface) {
    return null;
  }

  return (
    <>
      <canvas
        ref={hlCanvasRef}
        className="global-annotation-canvas is-highlighter-layer"
        style={{ display: 'none' }}
        aria-hidden="true"
      />
      <canvas
        ref={penCanvasRef}
        tabIndex={-1}
        className={`global-annotation-stage is-tool-${activeTool} ${
          isGlobalDrawActive ? 'is-capturing' : ''
        }`}
        aria-hidden="true"
        onPointerDown={handleGlobalPointerDown}
        onPointerMove={handleGlobalPointerMove}
        onPointerUp={commitGlobalPointer}
        onPointerCancel={commitGlobalPointer}
      />
      <canvas
        ref={draftCanvasRef}
        className="global-annotation-canvas is-draft-layer"
        style={{ display: 'none' }}
        aria-hidden="true"
      />
    </>
  );
};

/**
 * Root-level Pro-Grade Optical Laser Layer (mounted at root stacking context, z-index 9990).
 *
 * Demand-driven RAF architecture:
 * - Zero idle spin! Automatically halts requestAnimationFrame when the pointer rests still
 *   and no trails/pulses are fading — eliminating needless video encoding frames during Google Meet.
 * - Zero getBoundingClientRect() during pointermove or animation frames via cached viewport metrics.
 * - Hides the canvas completely when inactive in other tools so GPU VRAM & compositor stay free.
 */
export const OpticalLaserLayer: React.FC = () => {
  const { activeTool, laserSettings } = useAnnotationToolState();

  const laserCanvasRef = useRef<HTMLCanvasElement>(null);
  const laserRafRef = useRef<number>(0);
  const laserActiveRef = useRef(false);
  const laserDownRef = useRef(false);
  const laserHoldStartRef = useRef<number>(0);
  const laserTargetRef = useRef<{ x: number; y: number } | null>(null);
  const laserSmoothRef = useRef<{ x: number; y: number } | null>(null);
  const laserOverUiRef = useRef(false);
  const laserTrailsRef = useRef<LaserTrail[]>([]);
  const laserWriteTrailRef = useRef<LaserTrail | null>(null);
  const laserPulsesRef = useRef<LaserPulse[]>([]);
  const laserHoldTimerRef = useRef<number | null>(null);
  const laserHoldAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const laserSnapBaseRef = useRef<SnapDragBase | null>(null);
  const laserRectRef = useRef<{ left: number; top: number; width: number; height: number }>({
    left: 0,
    top: 0,
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  });

  const laserSettingsRef = useRef(laserSettings);
  laserSettingsRef.current = laserSettings;

  const syncLaserViewport = useCallback(() => {
    const canvas = laserCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const vw = rect.width || document.documentElement.clientWidth || window.innerWidth;
    const vh = rect.height || document.documentElement.clientHeight || window.innerHeight;
    laserRectRef.current = {
      left: rect.width > 0 ? rect.left : 0,
      top: rect.height > 0 ? rect.top : 0,
      width: vw,
      height: vh,
    };
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_LASER_DPR);
    const pw = Math.max(1, Math.round(vw * dpr));
    const ph = Math.max(1, Math.round(vh * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
  }, []);

  const renderLaserFrame = useCallback(() => {
    laserRafRef.current = 0;

    const canvas = laserCanvasRef.current;
    if (!canvas) return;

    const trails = laserTrailsRef.current;
    const pulses = laserPulsesRef.current;
    const isVisibleNeeded = laserActiveRef.current || trails.length > 0 || pulses.length > 0;
    const nextDisplay = isVisibleNeeded ? 'block' : 'none';
    if (canvas.style.display !== nextDisplay) {
      canvas.style.display = nextDisplay;
      if (isVisibleNeeded) {
        syncLaserViewport();
      }
    }
    if (!isVisibleNeeded) return;

    if (canvas.width <= 1 || canvas.height <= 1) {
      syncLaserViewport();
    }

    const { width: vw, height: vh } = laserRectRef.current;
    const pw = canvas.width;
    const ph = canvas.height;
    if (vw <= 0 || vh <= 0 || pw <= 0 || ph <= 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const now = performance.now();
    const { color: activeColor, mode, size: activeLaserSize } = laserSettingsRef.current;
    const totalFadeWindowMs = LASER_HOLD_AFTER_RELEASE_MS + LASER_FADE_DURATION_MS;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    ctx.scale(pw / vw, ph / vh);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let hasFadingTrails = false;
    for (let tIdx = trails.length - 1; tIdx >= 0; tIdx--) {
      const trail = trails[tIdx];

      let life = 1;
      if (trail.releasedAt !== null) {
        const elapsedSinceRelease = now - trail.releasedAt;
        if (elapsedSinceRelease >= totalFadeWindowMs) {
          trails.splice(tIdx, 1);
          continue;
        }
        hasFadingTrails = true;
        if (elapsedSinceRelease > LASER_HOLD_AFTER_RELEASE_MS) {
          const u = (elapsedSinceRelease - LASER_HOLD_AFTER_RELEASE_MS) / LASER_FADE_DURATION_MS;
          life = Math.pow(Math.max(0, 1 - u), 1.55);
        }
      }

      if (!trail.shape && (trail.points.length < 2 || life <= 0.01)) continue;
      if (life <= 0.01) continue;

      const beamW = Math.max(1.9, trail.size);
      const smoothed = trail.shape ? null : smoothLaserSamples(trail.points, trail.smoothing);

      const traceTrail = () => {
        if (trail.shape) {
          traceShapePath(ctx, trail.shape, IDENTITY_TRANSFORM);
        } else if (smoothed) {
          traceSmoothLaserPath(ctx, smoothed);
        }
      };

      // Pass 1: Wide atmospheric optical dispersion aura
      traceTrail();
      ctx.strokeStyle = hexToRgba(trail.color, life * 0.11);
      ctx.lineWidth = beamW * (3.2 + 0.35 * life);
      ctx.stroke();

      // Pass 2: Focused chromatic bloom sheath
      traceTrail();
      ctx.strokeStyle = hexToRgba(trail.color, life * 0.28);
      ctx.lineWidth = beamW * (1.88 + 0.22 * life);
      ctx.stroke();

      // Pass 3: Saturated optical plasma core
      traceTrail();
      ctx.strokeStyle = hexToRgba(trail.color, life * 0.94);
      ctx.lineWidth = beamW * (0.94 + 0.12 * life);
      ctx.stroke();

      // Pass 4: Pure incandescent white-hot inner filament
      const filamentLife = Math.pow(life, 1.32);
      traceTrail();
      ctx.strokeStyle = `rgba(255, 255, 255, ${filamentLife * 0.98})`;
      ctx.lineWidth = Math.max(0.9, beamW * 0.36);
      ctx.stroke();
    }

    for (let pIdx = pulses.length - 1; pIdx >= 0; pIdx--) {
      const pulse = pulses[pIdx];
      const elapsed = now - pulse.startedAt;
      if (elapsed >= LASER_PULSE_LIFE_MS) {
        pulses.splice(pIdx, 1);
        continue;
      }

      const u = elapsed / LASER_PULSE_LIFE_MS;
      const easeOut = 1 - Math.pow(1 - u, 3);
      const outerR = 3.5 + easeOut * 19;
      const innerR = 2 + easeOut * 10;
      const fade = Math.pow(1 - u, 1.5);

      ctx.beginPath();
      ctx.arc(pulse.x, pulse.y, outerR, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(pulse.color, fade * 0.65);
      ctx.lineWidth = 1.65 * (1 - u * 0.45);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(pulse.x, pulse.y, innerR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${fade * 0.86})`;
      ctx.lineWidth = 1.05;
      ctx.stroke();
    }

    let headStillSettling = false;
    const target = laserTargetRef.current;
    if (laserActiveRef.current && target && !laserOverUiRef.current) {
      if (!laserSmoothRef.current) {
        laserSmoothRef.current = { x: target.x, y: target.y };
      } else {
        const dx = target.x - laserSmoothRef.current.x;
        const dy = target.y - laserSmoothRef.current.y;
        if (Math.hypot(dx, dy) < 0.35) {
          laserSmoothRef.current.x = target.x;
          laserSmoothRef.current.y = target.y;
        } else {
          laserSmoothRef.current.x += dx * 0.86;
          laserSmoothRef.current.y += dy * 0.86;
          headStillSettling = true;
        }
      }

      const hx = laserSmoothRef.current.x;
      const hy = laserSmoothRef.current.y;
      const isDotMode = mode === 'dot';
      const isPressed = laserDownRef.current;
      const sizeFactor = 0.72 + Math.min(11, Math.max(2, activeLaserSize)) * 0.052;
      const headScale = sizeFactor * (isDotMode ? 1.12 : isPressed ? 1.04 : 0.94);

      const bloomR = (isPressed ? 15.5 : 12.2) * headScale;
      const grad = ctx.createRadialGradient(hx, hy, 0.5, hx, hy, bloomR);
      grad.addColorStop(0, hexToRgba(activeColor, 0.9));
      grad.addColorStop(0.28, hexToRgba(activeColor, 0.42));
      grad.addColorStop(0.65, hexToRgba(activeColor, 0.11));
      grad.addColorStop(1, hexToRgba(activeColor, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(hx, hy, bloomR, 0, Math.PI * 2);
      ctx.fill();

      const reticleR = (isPressed ? 6.0 : 6.9) * headScale;
      ctx.beginPath();
      ctx.arc(hx, hy, reticleR, 0, Math.PI * 2);
      ctx.strokeStyle = isPressed
        ? `rgba(255, 255, 255, 0.72)`
        : hexToRgba(activeColor, 0.42);
      ctx.lineWidth = isPressed ? 1.0 : 0.9;
      ctx.stroke();

      const tickInner = reticleR + 1.1;
      const tickOuter = reticleR + (isPressed ? 3.1 : 3.6);
      ctx.beginPath();
      ctx.moveTo(hx - tickOuter, hy);
      ctx.lineTo(hx - tickInner, hy);
      ctx.moveTo(hx + tickInner, hy);
      ctx.lineTo(hx + tickOuter, hy);
      ctx.moveTo(hx, hy - tickOuter);
      ctx.lineTo(hx, hy - tickInner);
      ctx.moveTo(hx, hy + tickInner);
      ctx.lineTo(hx, hy + tickOuter);
      ctx.strokeStyle = hexToRgba(activeColor, isPressed ? 0.72 : 0.48);
      ctx.lineWidth = 1.0;
      ctx.stroke();

      if (isPressed) {
        const holdElapsed = now - laserHoldStartRef.current;
        const breathe = 0.5 + 0.5 * Math.sin(holdElapsed * 0.0085);
        const auraR = (9.2 + breathe * 3.0) * headScale;
        ctx.beginPath();
        ctx.arc(hx, hy, auraR, 0, Math.PI * 2);
        ctx.strokeStyle = hexToRgba(activeColor, 0.22 + breathe * 0.22);
        ctx.lineWidth = 1.1;
        ctx.stroke();

        const flareLen = (5.2 + breathe * 1.6) * headScale;
        ctx.beginPath();
        ctx.moveTo(hx - flareLen, hy - flareLen);
        ctx.lineTo(hx + flareLen, hy + flareLen);
        ctx.moveTo(hx + flareLen, hy - flareLen);
        ctx.lineTo(hx - flareLen, hy + flareLen);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.42 + breathe * 0.24})`;
        ctx.lineWidth = 0.85;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(hx, hy, 3.15 * headScale, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(activeColor, 0.98);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(hx, hy, 1.45 * headScale, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
    }

    ctx.restore();

    // Only keep spinning RAF when actively animating (ZERO idle CPU/GPU spin!)
    const needsNextFrame =
      hasFadingTrails ||
      pulses.length > 0 ||
      headStillSettling ||
      (laserActiveRef.current && laserDownRef.current && !laserOverUiRef.current);

    if (needsNextFrame) {
      laserRafRef.current = requestAnimationFrame(renderLaserFrame);
    } else if (!laserActiveRef.current && trails.length === 0 && pulses.length === 0) {
      canvas.style.display = 'none';
    }
  }, [syncLaserViewport]);

  const ensureLaserLoop = useCallback(() => {
    if (!laserRafRef.current) {
      laserRafRef.current = requestAnimationFrame(renderLaserFrame);
    }
  }, [renderLaserFrame]);

  // Keep cached laser viewport synced on window resize
  useEffect(() => {
    const onResize = () => {
      if (laserActiveRef.current || laserTrailsRef.current.length > 0) {
        syncLaserViewport();
        ensureLaserLoop();
      }
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, [syncLaserViewport, ensureLaserLoop]);

  useEffect(() => {
    const isLaser = activeTool === 'laser';
    laserActiveRef.current = isLaser;

    if (!isLaser) {
      if (laserWriteTrailRef.current && laserWriteTrailRef.current.releasedAt === null) {
        laserWriteTrailRef.current.releasedAt = performance.now();
      }
      laserDownRef.current = false;
      laserWriteTrailRef.current = null;
      laserTargetRef.current = null;
      laserSmoothRef.current = null;
      document.body.classList.remove('is-laser-pointer-active', 'is-laser-over-ui');
      ensureLaserLoop();
      return;
    }

    syncLaserViewport();
    laserOverUiRef.current = true;
    document.body.classList.add('is-laser-pointer-active', 'is-laser-over-ui');
    ensureLaserLoop();

    const isOverChromeControls = (target: EventTarget | null): boolean => {
      const el = getElementFromTarget(target);
      if (!el) return false;
      return Boolean(el.closest(LASER_CHROME_CONTROLS_SELECTOR));
    };

    const clearLaserHoldTimer = () => {
      if (laserHoldTimerRef.current !== null) {
        window.clearTimeout(laserHoldTimerRef.current);
        laserHoldTimerRef.current = null;
      }
    };

    const armLaserHoldSnap = (x: number, y: number) => {
      clearLaserHoldTimer();
      const cur = laserWriteTrailRef.current;
      if (!cur || cur.shape || laserSettingsRef.current.mode !== 'trail') return;
      laserHoldAnchorRef.current = { x, y };
      laserHoldTimerRef.current = window.setTimeout(() => {
        laserHoldTimerRef.current = null;
        const activeTrail = laserWriteTrailRef.current;
        if (!activeTrail || activeTrail.shape || activeTrail.points.length < 4) return;
        const asPoints: AnnotationPoint[] = activeTrail.points.map((pt) => ({
          x: pt.x,
          y: pt.y,
          pressure: 0.5,
          t: pt.t,
        }));
        const detected = detectHoldShape(asPoints, 1, 1, true);
        if (detected) {
          const lastPt = activeTrail.points[activeTrail.points.length - 1];
          laserSnapBaseRef.current = {
            shape: detected,
            anchorX: lastPt.x,
            anchorY: lastPt.y,
          };
          activeTrail.shape = detected;
          laserPulsesRef.current.push({
            x,
            y,
            startedAt: performance.now(),
            color: activeTrail.color,
          });
          ensureLaserLoop();
        }
      }, HOLD_SNAP_DELAY_MS);
    };

    const releaseActiveWriteTrail = () => {
      clearLaserHoldTimer();
      laserHoldAnchorRef.current = null;
      laserSnapBaseRef.current = null;
      laserDownRef.current = false;
      if (laserWriteTrailRef.current) {
        if (laserWriteTrailRef.current.releasedAt === null) {
          laserWriteTrailRef.current.releasedAt = performance.now();
        }
        laserWriteTrailRef.current = null;
      }
    };

    const appendToWriteTrail = (x: number, y: number, now: number) => {
      let current = laserWriteTrailRef.current;
      if (!current) {
        current = {
          color: laserSettingsRef.current.color,
          size: laserSettingsRef.current.size,
          smoothing: laserSettingsRef.current.smoothing,
          points: [],
          releasedAt: null,
        };
        laserWriteTrailRef.current = current;
        laserTrailsRef.current.push(current);
      }
      if (current.shape) {
        current.shape = adjustSnappedShapeOnDrag(
          current.shape,
          { x, y, pressure: 0.5, t: now },
          1,
          1,
          laserSnapBaseRef.current
        );
        return;
      }
      const last = current.points[current.points.length - 1];
      if (!last || Math.hypot(x - last.x, y - last.y) >= 2.0) {
        current.points.push({ x, y, t: now });
        const anchor = laserHoldAnchorRef.current;
        if (!anchor || Math.hypot(x - anchor.x, y - anchor.y) > HOLD_MOVE_THRESHOLD_PX) {
          armLaserHoldSnap(x, y);
        }
      }
    };

    const toLaserCoords = (clientX: number, clientY: number): { x: number; y: number } => {
      const r = laserRectRef.current;
      return {
        x: clientX - r.left,
        y: clientY - r.top,
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      const overUi = laserDownRef.current ? false : isOverChromeControls(e.target);
      if (laserOverUiRef.current !== overUi) {
        laserOverUiRef.current = overUi;
        document.body.classList.toggle('is-laser-over-ui', overUi);
      }

      const pos = toLaserCoords(e.clientX, e.clientY);
      laserTargetRef.current = pos;

      const primaryHeld = laserDownRef.current || (e.buttons & 1) === 1;
      if (primaryHeld && !overUi) {
        if (!laserDownRef.current) {
          laserDownRef.current = true;
          laserHoldStartRef.current = performance.now();
        }
        if (laserSettingsRef.current.mode === 'trail') {
          appendToWriteTrail(pos.x, pos.y, performance.now());
        }
      } else if (!primaryHeld && laserDownRef.current) {
        releaseActiveWriteTrail();
      }

      ensureLaserLoop();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (laserRectRef.current.width <= 0) {
        syncLaserViewport();
      }
      const overUi = isOverChromeControls(e.target);
      laserOverUiRef.current = overUi;
      document.body.classList.toggle('is-laser-over-ui', overUi);
      if (overUi) return;

      if (typeof window.focus === 'function' && !document.hasFocus()) {
        window.focus();
      }
      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLSelectElement ||
        activeEl instanceof HTMLTextAreaElement
      ) {
        activeEl.blur();
      }

      if (e.cancelable) {
        e.preventDefault();
      }

      const now = performance.now();
      const pos = toLaserCoords(e.clientX, e.clientY);
      laserDownRef.current = true;
      laserHoldStartRef.current = now;
      laserTargetRef.current = pos;
      laserSmoothRef.current = { x: pos.x, y: pos.y };

      laserPulsesRef.current.push({
        x: pos.x,
        y: pos.y,
        startedAt: now,
        color: laserSettingsRef.current.color,
      });

      if (laserSettingsRef.current.mode === 'trail') {
        const nextTrail: LaserTrail = {
          color: laserSettingsRef.current.color,
          size: laserSettingsRef.current.size,
          smoothing: laserSettingsRef.current.smoothing,
          points: [{ x: pos.x, y: pos.y, t: now }],
          releasedAt: null,
        };
        laserWriteTrailRef.current = nextTrail;
        laserTrailsRef.current.push(nextTrail);
      }

      ensureLaserLoop();
    };

    const onPointerUp = (e: PointerEvent) => {
      releaseActiveWriteTrail();
      if (e.pointerType === 'touch') {
        laserTargetRef.current = null;
        laserSmoothRef.current = null;
      }
      ensureLaserLoop();
    };

    const onClickCapture = (e: MouseEvent) => {
      if (!isOverChromeControls(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onPointerLeave = () => {
      releaseActiveWriteTrail();
      laserTargetRef.current = null;
      laserSmoothRef.current = null;
      ensureLaserLoop();
    };

    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: false });
    window.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
    window.addEventListener('pointercancel', onPointerUp, { capture: true, passive: true });
    window.addEventListener('click', onClickCapture, { capture: true });
    document.addEventListener('mouseleave', onPointerLeave);
    window.addEventListener('blur', onPointerLeave);

    return () => {
      if (laserHoldTimerRef.current !== null) {
        window.clearTimeout(laserHoldTimerRef.current);
        laserHoldTimerRef.current = null;
      }
      if (laserWriteTrailRef.current && laserWriteTrailRef.current.releasedAt === null) {
        laserWriteTrailRef.current.releasedAt = performance.now();
      }
      document.body.classList.remove('is-laser-pointer-active', 'is-laser-over-ui');
      window.removeEventListener('pointermove', onPointerMove, { capture: true });
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointerup', onPointerUp, { capture: true });
      window.removeEventListener('pointercancel', onPointerUp, { capture: true });
      window.removeEventListener('click', onClickCapture, { capture: true });
      document.removeEventListener('mouseleave', onPointerLeave);
      window.removeEventListener('blur', onPointerLeave);
    };
  }, [activeTool, ensureLaserLoop, syncLaserViewport]);

  useEffect(() => {
    return () => {
      if (laserHoldTimerRef.current !== null) {
        window.clearTimeout(laserHoldTimerRef.current);
        laserHoldTimerRef.current = null;
      }
      if (laserRafRef.current) {
        cancelAnimationFrame(laserRafRef.current);
        laserRafRef.current = 0;
      }
    };
  }, []);

  return (
    <canvas
      ref={laserCanvasRef}
      className="global-laser-canvas"
      style={{ display: 'none' }}
      aria-hidden="true"
    />
  );
};
