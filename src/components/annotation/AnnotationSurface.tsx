import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAnnotation } from './AnnotationContext';
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
  unionPixelRects,
  type LivePenDraftSession,
  type PixelRect,
  type RenderTransform,
  type SnapDragBase,
} from './strokeEngine';
import type { AnnotationPoint, AnnotationStroke } from './types';

interface AnnotationSurfaceProps {
  /** Unique persistent ID for this drawing surface (e.g. "mushaf:page:1", "whiteboard:1") */
  surfaceId: string;
  /** Optional accessible label */
  ariaLabel?: string;
  /** Optional extra CSS class */
  className?: string;
}

const HOLD_SNAP_DELAY_MS = 350;
const HOLD_MOVE_THRESHOLD_PX = 6;
const MAX_SURFACE_DPR = 1.5;
const SYNC_PAINT_MIN_INTERVAL_MS = 4;

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
  if (Number.isNaN(num)) return `rgba(0, 122, 255, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Reusable bounded High-DPI Apple PencilKit drawing surface.
 *
 * Ultra-low-latency 3-layer architecture (0-frame pen-to-ink latency even during Google Meet screen share):
 * - Static committed `penCanvas` & `hlCanvas`: NEVER cleared or copied during `pointermove`!
 * - Dedicated live `draftCanvas` (`display: none` when idle) with tight dirty-rect clearing (~100x fewer pixels).
 * - Tight dirty-rect restore + multiply composite for live highlighter dragging.
 * - Synchronous 0-frame-delay live paint inside `pointermove` so ink lands in the exact same frame as the nib cursor.
 * - Incremental O(1) stroke commit on `pointerup` (stamps only the 1 new stroke — zero full-page rebuild!).
 * - Zero `getBoundingClientRect()` on `pointerdown` or `pointermove` via scroll-tracked cached geometry.
 */
export const AnnotationSurface: React.FC<AnnotationSurfaceProps> = ({
  surfaceId,
  ariaLabel = 'طبقة الرسم والشرح',
  className = '',
}) => {
  const {
    activeTool,
    penSettings,
    highlighterSettings,
    eraserSettings,
    registerBoundedSurface,
    unregisterBoundedSurface,
    getStrokes,
    addStroke,
    removeStrokes,
  } = useAnnotation();

  const containerRef = useRef<HTMLDivElement>(null);
  const hlCanvasRef = useRef<HTMLCanvasElement>(null);
  const penCanvasRef = useRef<HTMLCanvasElement>(null);
  const draftCanvasRef = useRef<HTMLCanvasElement>(null);

  // Cached 2D contexts (avoids repeated getContext lookups on every pointer frame)
  const hlCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const penCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const draftCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Offscreen static highlighter cache + reusable scratch canvas for chisel meniscus
  const committedHlCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const committedHlCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasCommittedHlRef = useRef(false);

  // Incremental O(1) commit tracking
  const renderedStrokesRef = useRef<AnnotationStroke[]>([]);
  const renderedSurfaceIdRef = useRef<string>(surfaceId);
  const lastBuiltSizeTickRef = useRef<number>(-1);

  // Tight device-pixel dirty rects for O(1) live draft clearing
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

  const sizeRef = useRef<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 1 });
  const rectRef = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  } | null>(null);

  const rafRenderRef = useRef<number>(0);
  const dirtyLiveRef = useRef<{ draft: boolean; hl: boolean }>({ draft: false, hl: false });
  const lastLivePaintTsRef = useRef<number>(0);

  const [sizeTick, setSizeTick] = useState(0);
  const strokes = getStrokes(surfaceId);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;

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

  // Register this bounded surface while mounted
  useEffect(() => {
    registerBoundedSurface(surfaceId);
    return () => {
      unregisterBoundedSurface(surfaceId);
    };
  }, [surfaceId, registerBoundedSurface, unregisterBoundedSurface]);

  useEffect(() => {
    return () => {
      document.body.classList.remove('is-annotation-drawing');
      if (holdTimerRef.current) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (rafRenderRef.current) {
        cancelAnimationFrame(rafRenderRef.current);
        rafRenderRef.current = 0;
      }
      if (livePenSessionRef.current) {
        resetLivePenDraftSession(livePenSessionRef.current);
      }
    };
  }, []);

  const refreshCachedRect = useCallback(() => {
    const el = penCanvasRef.current || containerRef.current;
    if (!el) {
      rectRef.current = null;
      return null;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      rectRef.current = null;
      return null;
    }
    const cached = {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
    rectRef.current = cached;
    return cached;
  }, []);

  const getTransform = useCallback((): RenderTransform => {
    const { w, h } = sizeRef.current;
    return {
      scaleX: w / 1000,
      scaleY: h / 1000,
      offsetX: 0,
      offsetY: 0,
      unitScale: Math.max(0.55, Math.min(1.65, w / 920)),
    };
  }, []);

  const clearDraftOverlay = useCallback(() => {
    const draftCanvas = draftCanvasRef.current;
    const draftCtx = getDraftCtx();
    const prev = prevDraftRectRef.current;
    if (draftCtx && draftCanvas && prev) {
      draftCtx.save();
      draftCtx.setTransform(1, 0, 0, 1, 0, 0);
      draftCtx.clearRect(prev.x, prev.y, prev.w, prev.h);
      draftCtx.restore();
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

  const restoreHlDraftArea = useCallback(() => {
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

  // Cancel active draft & hold timer cleanly when tool or surface changes
  useEffect(() => {
    document.body.classList.remove('is-annotation-drawing');
    if (draftRef.current) {
      draftRef.current = null;
      clearDraftOverlay();
      restoreHlDraftArea();
    }
    snapBaseRef.current = null;
    activePointerIdRef.current = null;
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, [activeTool, surfaceId, clearDraftOverlay, restoreHlDraftArea]);

  /**
   * Stamps a single committed stroke incrementally onto the permanent layer(s) in O(1) time.
   */
  const stampCommittedStroke = useCallback(
    (stroke: AnnotationStroke, clearPrevHlDraft = false) => {
      const hlCanvas = hlCanvasRef.current;
      const penCanvas = penCanvasRef.current;
      if (!hlCanvas || !penCanvas) return;

      const { w, h } = sizeRef.current;
      const pw = penCanvas.width;
      const ph = penCanvas.height;
      if (w <= 0 || h <= 0 || pw <= 0 || ph <= 0) return;

      const tf = getTransform();
      const dprX = pw / w;
      const dprY = ph / h;

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
    [ensureCommittedHlBuffer, ensureScratchCanvas, getHlCtx, getPenCtx, getTransform]
  );

  /**
   * Full rebuild of committed layers — called ONLY on Undo, Redo, Erase, Clear, Page Switch, or Resize.
   * NEVER called during live drawing or normal stroke commit!
   */
  const rebuildAllCommittedLayers = useCallback(() => {
    const hlCanvas = hlCanvasRef.current;
    const penCanvas = penCanvasRef.current;
    const draftCanvas = draftCanvasRef.current;
    if (!hlCanvas || !penCanvas) return;

    const { w, h } = sizeRef.current;
    const pw = penCanvas.width;
    const ph = penCanvas.height;
    if (w <= 0 || h <= 0 || pw <= 0 || ph <= 0) return;

    const tf = getTransform();
    const dprX = pw / w;
    const dprY = ph / h;
    const list = strokesRef.current;

    let hasHl = false;
    let hasPen = false;
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === 'highlighter') hasHl = true;
      else if (list[i].kind === 'pen') hasPen = true;
    }
    hasCommittedHlRef.current = hasHl;

    // 1. Committed Highlighter layer
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
        const cHl = committedHlCanvasRef.current;
        if (cHl.width > 0 && cHl.height > 0) {
          committedHlCtxRef.current.clearRect(0, 0, cHl.width, cHl.height);
        }
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

    // 2. Committed Pen layer
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

    // 3. Clear any stale pixels on live draft overlay
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
    renderedSurfaceIdRef.current = surfaceId;
  }, [ensureCommittedHlBuffer, ensureScratchCanvas, getDraftCtx, getHlCtx, getPenCtx, getTransform, surfaceId]);

  /**
   * Ultra-fast dirty-rect live draft & ripple renderer.
   * Touches ONLY the tiny bounding box of the live stroke — NEVER touches `penCanvas`!
   */
  const renderLiveDraftFrame = useCallback(() => {
    if (rafRenderRef.current) {
      cancelAnimationFrame(rafRenderRef.current);
      rafRenderRef.current = 0;
    }

    const hlCanvas = hlCanvasRef.current;
    const draftCanvas = draftCanvasRef.current;
    if (!hlCanvas || !draftCanvas) return;

    const { w, h } = sizeRef.current;
    if (w <= 0 || h <= 0) return;

    const pw = draftCanvas.width;
    const ph = draftCanvas.height;
    if (pw <= 0 || ph <= 0) return;

    const dprX = pw / w;
    const dprY = ph / h;
    const tf = getTransform();
    const draft = draftRef.current;

    const redrawHl = dirtyLiveRef.current.hl;
    const redrawDraft = dirtyLiveRef.current.draft;
    dirtyLiveRef.current.hl = false;
    dirtyLiveRef.current.draft = false;

    // 1. Live Highlighter draft (dirty-rect restore + multiply composite ONLY in the stroke region!)
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
          restoreHlDraftArea();
        }
      }
    }

    // 2. Live Pen draft + Snap/Erase ripples + live Anchor Pin on dedicated `draftCanvas`
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

          // Refined dual-ring Apple PencilKit Hold-to-Snap confirmation shimmer
          const pulse = snapPulseRef.current;
          if (pulse) {
            const elapsed = performance.now() - pulse.startedAt;
            if (elapsed < 380) {
              const progress = elapsed / 380;
              const ease = 1 - Math.pow(1 - progress, 3);
              const outerR = 5 + ease * 21;
              const innerR = 2.5 + ease * 11;
              const fade = Math.pow(1 - progress, 1.35);
              dCtx.save();
              dCtx.beginPath();
              dCtx.arc(pulse.x, pulse.y, outerR, 0, Math.PI * 2);
              dCtx.strokeStyle = hexToRgba(pulse.color, fade * 0.58);
              dCtx.lineWidth = 1.9 * (1 - progress * 0.35);
              dCtx.stroke();

              dCtx.beginPath();
              dCtx.arc(pulse.x, pulse.y, innerR, 0, Math.PI * 2);
              dCtx.strokeStyle = `rgba(255, 255, 255, ${fade * 0.85})`;
              dCtx.lineWidth = 1.15;
              dCtx.stroke();
              dCtx.restore();

              const pad = outerR + 4;
              const pulseRect = cssBoundsToPixelRect(
                { minX: pulse.x - pad, minY: pulse.y - pad, maxX: pulse.x + pad, maxY: pulse.y + pad },
                dprX,
                dprY,
                pw,
                ph
              );
              nextRect = unionPixelRects(nextRect, pulseRect);
              needsMoreFrames = true;
            } else {
              snapPulseRef.current = null;
            }
          }

          // Subtle frosted-rose dissolve ripple on eraser hit
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
              const epRect = cssBoundsToPixelRect(
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
              );
              nextRect = unionPixelRects(nextRect, epRect);
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
      rafRenderRef.current = requestAnimationFrame(renderLiveDraftFrame);
    }
  }, [ensureScratchCanvas, getDraftCtx, getHlCtx, getTransform, restoreHlDraftArea]);

  const scheduleLiveDraw = useCallback(
    (layers: { draft?: boolean; hl?: boolean }) => {
      if (layers.draft) dirtyLiveRef.current.draft = true;
      if (layers.hl) dirtyLiveRef.current.hl = true;
      if (rafRenderRef.current) return;
      rafRenderRef.current = requestAnimationFrame(renderLiveDraftFrame);
    },
    [renderLiveDraftFrame]
  );

  const paintLiveNow = useCallback(
    (layers: { draft?: boolean; hl?: boolean }) => {
      if (layers.draft) dirtyLiveRef.current.draft = true;
      if (layers.hl) dirtyLiveRef.current.hl = true;
      const now = performance.now();
      if (now - lastLivePaintTsRef.current >= SYNC_PAINT_MIN_INTERVAL_MS) {
        lastLivePaintTsRef.current = now;
        renderLiveDraftFrame();
        return;
      }
      if (!rafRenderRef.current) {
        rafRenderRef.current = requestAnimationFrame(renderLiveDraftFrame);
      }
    },
    [renderLiveDraftFrame]
  );

  const syncCanvasSize = useCallback((): boolean => {
    const hlCanvas = hlCanvasRef.current;
    const penCanvas = penCanvasRef.current;
    const draftCanvas = draftCanvasRef.current;
    if (!hlCanvas || !penCanvas || !draftCanvas) return false;

    const rect = refreshCachedRect();
    if (!rect) return false;

    const w = rect.width;
    const h = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_SURFACE_DPR);
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));

    if (
      Math.abs(sizeRef.current.w - w) > 0.5 ||
      Math.abs(sizeRef.current.h - h) > 0.5 ||
      sizeRef.current.dpr !== dpr ||
      hlCanvas.width !== pw ||
      hlCanvas.height !== ph ||
      penCanvas.width !== pw ||
      penCanvas.height !== ph ||
      draftCanvas.width !== pw ||
      draftCanvas.height !== ph
    ) {
      sizeRef.current = { w, h, dpr };
      hlCanvas.width = pw;
      hlCanvas.height = ph;
      penCanvas.width = pw;
      penCanvas.height = ph;
      draftCanvas.width = pw;
      draftCanvas.height = ph;
      prevDraftRectRef.current = null;
      prevHlDraftRectRef.current = null;
      return true;
    }
    return false;
  }, [refreshCachedRect]);

  // Keep High-DPI canvases cleanly synced to container size on resize / zoom / scroll (any scroll ancestor)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleResize = () => {
      if (syncCanvasSize()) {
        setSizeTick((t) => t + 1);
        rebuildAllCommittedLayers();
      }
    };

    const handleScroll = () => {
      refreshCachedRect();
    };

    if (syncCanvasSize()) {
      setSizeTick((t) => t + 1);
    }
    rebuildAllCommittedLayers();

    window.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(handleResize);
      ro.observe(el);
    }
    return () => {
      window.removeEventListener('scroll', handleScroll, { capture: true });
      ro?.disconnect();
    };
  }, [rebuildAllCommittedLayers, syncCanvasSize, refreshCachedRect]);

  // Incremental O(1) reconciliation when committed strokes or sizeTick change
  useEffect(() => {
    const sizeChanged = lastBuiltSizeTickRef.current !== sizeTick;
    const surfaceChanged = renderedSurfaceIdRef.current !== surfaceId;
    lastBuiltSizeTickRef.current = sizeTick;

    if (sizeChanged || surfaceChanged) {
      rebuildAllCommittedLayers();
      return;
    }

    const prev = renderedStrokesRef.current;
    const curr = strokes;

    // 1. Exact match (already stamped synchronously on pointerup!) -> 0.00ms!
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

    // 2. Pure append fast path -> stamp ONLY the newly added stroke(s) in O(1)!
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
          stampCommittedStroke(curr[i], false);
        }
        renderedStrokesRef.current = curr.slice();
        return;
      }
    }

    // 3. Undo / Redo / Erase / Clear -> full rebuild
    rebuildAllCommittedLayers();
  }, [strokes, sizeTick, surfaceId, rebuildAllCommittedLayers, stampCommittedStroke]);

  // Pure cached-rect coordinate mapping — ZERO getBoundingClientRect() during pointermove!
  const mapClientToSurface = useCallback(
    (clientX: number, clientY: number): { norm: AnnotationPoint; screenX: number; screenY: number } | null => {
      const rect = rectRef.current || refreshCachedRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      const sx = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const sy = Math.max(0, Math.min(rect.height, clientY - rect.top));
      return {
        norm: {
          x: (sx / rect.width) * 1000,
          y: (sy / rect.height) * 1000,
          pressure: 0.5,
          t: performance.now(),
        },
        screenX: sx,
        screenY: sy,
      };
    },
    [refreshCachedRect]
  );

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const armHoldSnapTimer = useCallback(
    (screenX: number, screenY: number) => {
      const draft = draftRef.current;
      if (!draft) return;
      if (draft.kind === 'pen' && !penSettings.smartShapes) return;
      if (draft.kind === 'highlighter' && !highlighterSettings.straightAssist) return;

      holdAnchorRef.current = { x: screenX, y: screenY };
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
          const { w, h } = sizeRef.current;
          if (w <= 0 || h <= 0) return;

          const detected = detectHoldShape(
            cur.points,
            w / 1000,
            h / 1000,
            cur.kind === 'pen'
          );
          if (detected) {
            const lastPt = cur.points[cur.points.length - 1];
            snapBaseRef.current = {
              shape: detected,
              anchorX: lastPt.x,
              anchorY: lastPt.y,
            };
            cur.shape = detected;
            const anchor = holdAnchorRef.current;
            snapPulseRef.current = {
              x: anchor ? anchor.x : screenX,
              y: anchor ? anchor.y : screenY,
              color: cur.kind === 'highlighter' ? '#007AFF' : cur.color,
              startedAt: performance.now(),
            };
            scheduleLiveDraw({ draft: true, hl: cur.kind === 'highlighter' });
          }
        }, delayMs);
      };

      scheduleCheck(HOLD_SNAP_DELAY_MS);
    },
    [penSettings.smartShapes, highlighterSettings.straightAssist, scheduleLiveDraw]
  );

  const eraseAt = useCallback(
    (screenX: number, screenY: number) => {
      const tf = getTransform();
      const radiusPx = Math.max(10, eraserSettings.size * tf.unitScale * 0.55);
      const hitIds: string[] = [];
      const list = strokesRef.current;
      for (let i = 0; i < list.length; i++) {
        const st = list[i];
        if (hitTestStroke(screenX, screenY, st, radiusPx, tf)) {
          hitIds.push(st.id);
        }
      }
      if (hitIds.length > 0) {
        erasePulseRef.current = { x: screenX, y: screenY, startedAt: performance.now() };
        removeStrokes(surfaceId, hitIds);
        scheduleLiveDraw({ draft: true });
      }
    },
    [eraserSettings.size, getTransform, removeStrokes, scheduleLiveDraw, surfaceId]
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeTool === 'cursor') return;

    if (activeTool === 'laser') {
      e.preventDefault();
      return;
    }

    if (e.button !== 0 && e.pointerType === 'mouse') return;

    // Skip synchronous getBoundingClientRect() whenever cached geometry is already fresh!
    const cached = rectRef.current;
    if (
      !cached ||
      sizeRef.current.w <= 0 ||
      cached.scrollX !== window.scrollX ||
      cached.scrollY !== window.scrollY
    ) {
      if (syncCanvasSize()) {
        rebuildAllCommittedLayers();
      }
    }

    const mapped = mapClientToSurface(e.clientX, e.clientY);
    if (!mapped) return;

    if (typeof window.focus === 'function' && !document.hasFocus()) {
      window.focus();
    }

    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic/unsupported pointer capture errors
    }
    activePointerIdRef.current = e.pointerId;
    document.body.classList.add('is-annotation-drawing');

    if (activeTool === 'eraser') {
      eraseAt(mapped.screenX, mapped.screenY);
      return;
    }

    const pt: AnnotationPoint = {
      ...mapped.norm,
      pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
    };

    const isHighlighter = activeTool === 'highlighter';
    snapBaseRef.current = null;
    draftRef.current = {
      id: `st_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind: isHighlighter ? 'highlighter' : 'pen',
      color: isHighlighter ? highlighterSettings.color : penSettings.color,
      size: isHighlighter ? highlighterSettings.size : penSettings.size,
      opacity: isHighlighter ? highlighterSettings.opacity : penSettings.opacity,
      smoothing: isHighlighter ? highlighterSettings.smoothing : penSettings.smoothing,
      points: [pt],
      shape: e.shiftKey
        ? { type: 'line', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y }
        : undefined,
    };

    if (draftCanvasRef.current) {
      draftCanvasRef.current.style.opacity =
        !isHighlighter && penSettings.opacity < 0.999 ? String(penSettings.opacity) : '';
    }

    armHoldSnapTimer(mapped.screenX, mapped.screenY);
    dirtyLiveRef.current = { draft: !isHighlighter, hl: isHighlighter };
    lastLivePaintTsRef.current = performance.now();
    renderLiveDraftFrame();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeTool === 'cursor' || activeTool === 'laser') return;

    if (activeTool === 'eraser') {
      if (activePointerIdRef.current === e.pointerId) {
        const mapped = mapClientToSurface(e.clientX, e.clientY);
        if (mapped) eraseAt(mapped.screenX, mapped.screenY);
      }
      return;
    }

    if (activePointerIdRef.current !== e.pointerId || !draftRef.current) return;

    const rect = rectRef.current || refreshCachedRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;

    const draft = draftRef.current;
    const invW = 1000 / rect.width;
    const invH = 1000 / rect.height;
    const mainSx = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const mainSy = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const nowTs = performance.now();

    if (draft.shape) {
      const { w, h } = sizeRef.current;
      if (w > 0 && h > 0) {
        const rawPt: AnnotationPoint = {
          x: mainSx * invW,
          y: mainSy * invH,
          pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
          t: nowTs,
        };
        draft.shape = adjustSnappedShapeOnDrag(
          draft.shape,
          rawPt,
          w / 1000,
          h / 1000,
          snapBaseRef.current
        );
        paintLiveNow(draft.kind === 'highlighter' ? { hl: true, draft: true } : { draft: true });
      }
      return;
    }

    const samples =
      typeof e.nativeEvent.getCoalescedEvents === 'function'
        ? e.nativeEvent.getCoalescedEvents()
        : null;
    const sampleCount = samples && samples.length > 0 ? samples.length : 0;
    const { w, h } = sizeRef.current;
    const scaleX = w / 1000;
    const scaleY = h / 1000;
    const smoothThresh = penSettings.smoothing > 0.1 ? 2.4 : 1.3;
    let didAppend = false;

    const loopLen = sampleCount > 0 ? sampleCount : 1;
    for (let i = 0; i < loopLen; i++) {
      const ev = sampleCount > 0 ? samples![i] : e.nativeEvent;
      const sx = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
      const sy = Math.max(0, Math.min(rect.height, ev.clientY - rect.top));
      const nx = sx * invW;
      const ny = sy * invH;

      const prev = draft.points[draft.points.length - 1];
      const dxPx = (nx - prev.x) * scaleX;
      const dyPx = (ny - prev.y) * scaleY;
      const distSq = dxPx * dxPx + dyPx * dyPx;

      const minStepPx =
        draft.kind === 'highlighter'
          ? 3.0
          : ev.pointerType === 'pen'
          ? 1.6
          : smoothThresh;
      if (distSq < minStepPx * minStepPx) continue;

      let finalY = ny;
      if (draft.kind === 'highlighter' && highlighterSettings.straightAssist && draft.points.length >= 2) {
        const origin = draft.points[0];
        const totalDxPx = Math.abs((nx - origin.x) * scaleX);
        const totalDyPx = Math.abs((ny - origin.y) * scaleY);
        if (totalDxPx > 14 && totalDyPx < Math.max(12, totalDxPx * 0.14)) {
          finalY = prev.y * 0.72 + origin.y * 0.16 + ny * 0.12;
        }
      }

      draft.points.push({
        x: nx,
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
      (mainSx - anchor.x) * (mainSx - anchor.x) +
        (mainSy - anchor.y) * (mainSy - anchor.y) >
        HOLD_MOVE_THRESHOLD_PX * HOLD_MOVE_THRESHOLD_PX
    ) {
      armHoldSnapTimer(mainSx, mainSy);
    }

    paintLiveNow(draft.kind === 'highlighter' ? { hl: true } : { draft: true });
  };

  const commitPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    activePointerIdRef.current = null;
    document.body.classList.remove('is-annotation-drawing');
    clearHoldTimer();

    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore capture release errors
    }

    if (activeTool === 'eraser') {
      return;
    }

    const draft = draftRef.current;
    draftRef.current = null;
    snapBaseRef.current = null;
    if (draft && (draft.points.length > 0 || draft.shape)) {
      // Synchronously stamp ONLY this single finished stroke onto the permanent canvas (O(1), zero blink!)
      if (draft.kind === 'pen') {
        stampCommittedStroke(draft, false);
        clearDraftOverlay();
      } else {
        stampCommittedStroke(draft, true);
        clearDraftOverlay();
      }
      renderedStrokesRef.current = [...renderedStrokesRef.current, draft];
      addStroke(surfaceId, draft);
    } else {
      clearDraftOverlay();
      restoreHlDraftArea();
    }
  };

  const isDrawingActive = activeTool !== 'cursor';

  return (
    <div
      ref={containerRef}
      data-annotation-bounded="true"
      data-surface-id={surfaceId}
      className={`annotation-surface is-tool-${activeTool} ${isDrawingActive ? 'is-interactive' : ''} ${className}`}
      aria-hidden={!isDrawingActive}
    >
      <canvas
        ref={hlCanvasRef}
        className="annotation-canvas is-highlighter-layer"
        style={{ display: 'none' }}
        aria-hidden="true"
      />
      <canvas
        ref={penCanvasRef}
        tabIndex={-1}
        aria-label={ariaLabel}
        className="annotation-canvas is-ink-layer"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={commitPointer}
        onPointerCancel={commitPointer}
      />
      <canvas
        ref={draftCanvasRef}
        className="annotation-canvas is-draft-layer"
        style={{ display: 'none' }}
        aria-hidden="true"
      />
    </div>
  );
};
