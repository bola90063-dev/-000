import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_ERASER_SETTINGS,
  DEFAULT_HIGHLIGHTER_SETTINGS,
  DEFAULT_LASER_SETTINGS,
  DEFAULT_PEN_SETTINGS,
  SIZE_DIAL_STEP,
  pxToSizeLevel,
  sizeLevelToPx,
  snapSizeLevel,
  type AnnotationStroke,
  type AnnotationTool,
  type EraserSettings,
  type HighlighterSettings,
  type LaserSettings,
  type PenSettings,
} from './types';
import { toArabicDigits } from '../../utils/mushafData';

interface SurfaceHistory {
  strokes: AnnotationStroke[];
  past: AnnotationStroke[][];
  future: AnnotationStroke[][];
}

export interface ShortcutFeedback {
  label: string;
  keycap: string;
  seq: number;
}

const EMPTY_STROKES: AnnotationStroke[] = [];
const MAX_HISTORY_STEPS = 45;

function isTextTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target.isContentEditable) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    const inputType = (target.type || 'text').toLowerCase();
    return !['range', 'button', 'checkbox', 'radio', 'submit', 'reset', 'color', 'file'].includes(
      inputType
    );
  }
  return false;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (isTextTypingTarget(target)) return true;
  return target instanceof HTMLSelectElement;
}

function releaseTrappedFormFocus(): void {
  if (typeof window.focus === 'function' && !document.hasFocus()) {
    window.focus();
  }
  const activeEl = document.activeElement;
  if (
    activeEl instanceof HTMLElement &&
    (isEditableKeyboardTarget(activeEl) || activeEl instanceof HTMLSelectElement)
  ) {
    activeEl.blur();
  }
}

interface AnnotationContextValue {
  activeTool: AnnotationTool;
  setActiveTool: (tool: AnnotationTool) => void;
  isPaletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePaletteOpen: () => void;
  penSettings: PenSettings;
  updatePenSettings: (patch: Partial<PenSettings>) => void;
  highlighterSettings: HighlighterSettings;
  updateHighlighterSettings: (patch: Partial<HighlighterSettings>) => void;
  laserSettings: LaserSettings;
  updateLaserSettings: (patch: Partial<LaserSettings>) => void;
  eraserSettings: EraserSettings;
  updateEraserSettings: (patch: Partial<EraserSettings>) => void;
  activeSurfaceId: string;
  hasBoundedSurface: boolean;
  setFallbackSurfaceId: (surfaceId: string) => void;
  registerBoundedSurface: (surfaceId: string) => void;
  unregisterBoundedSurface: (surfaceId: string) => void;
  getStrokes: (surfaceId: string) => AnnotationStroke[];
  addStroke: (surfaceId: string, stroke: AnnotationStroke) => void;
  removeStrokes: (surfaceId: string, strokeIds: string[]) => void;
  undo: (surfaceId?: string) => void;
  redo: (surfaceId?: string) => void;
  clearSurface: (surfaceId?: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  activeStrokeCount: number;
  shortcutFeedback: ShortcutFeedback | null;
}

export interface AnnotationActionsValue {
  setActiveTool: (tool: AnnotationTool) => void;
  setPaletteOpen: (open: boolean) => void;
  togglePaletteOpen: () => void;
  updatePenSettings: (patch: Partial<PenSettings>) => void;
  updateHighlighterSettings: (patch: Partial<HighlighterSettings>) => void;
  updateLaserSettings: (patch: Partial<LaserSettings>) => void;
  updateEraserSettings: (patch: Partial<EraserSettings>) => void;
  setFallbackSurfaceId: (surfaceId: string) => void;
  registerBoundedSurface: (surfaceId: string) => void;
  unregisterBoundedSurface: (surfaceId: string) => void;
  addStroke: (surfaceId: string, stroke: AnnotationStroke) => void;
  removeStrokes: (surfaceId: string, strokeIds: string[]) => void;
  undo: (surfaceId?: string) => void;
  redo: (surfaceId?: string) => void;
  clearSurface: (surfaceId?: string) => void;
}

export interface AnnotationToolStateValue {
  activeTool: AnnotationTool;
  isPaletteOpen: boolean;
  penSettings: PenSettings;
  highlighterSettings: HighlighterSettings;
  laserSettings: LaserSettings;
  eraserSettings: EraserSettings;
  hasBoundedSurface: boolean;
  shortcutFeedback: ShortcutFeedback | null;
}

export interface AnnotationDockStateValue {
  canUndo: boolean;
  canRedo: boolean;
  hasActiveStrokes: boolean;
}

const AnnotationContext = createContext<AnnotationContextValue | null>(null);
const AnnotationActionsContext = createContext<AnnotationActionsValue | null>(null);
const AnnotationToolStateContext = createContext<AnnotationToolStateValue | null>(null);
const AnnotationDockStateContext = createContext<AnnotationDockStateValue | null>(null);

interface AnnotationProviderProps {
  children: React.ReactNode;
  defaultOpen?: boolean;
}

export const AnnotationProvider: React.FC<AnnotationProviderProps> = ({
  children,
  defaultOpen = false,
}) => {
  const [activeTool, setActiveToolState] = useState<AnnotationTool>('cursor');
  const [isPaletteOpen, setIsPaletteOpenState] = useState<boolean>(defaultOpen);
  const [penSettings, setPenSettings] = useState<PenSettings>(DEFAULT_PEN_SETTINGS);
  const [highlighterSettings, setHighlighterSettings] = useState<HighlighterSettings>(
    DEFAULT_HIGHLIGHTER_SETTINGS
  );
  const [laserSettings, setLaserSettings] = useState<LaserSettings>(DEFAULT_LASER_SETTINGS);
  const [eraserSettings, setEraserSettings] = useState<EraserSettings>(DEFAULT_ERASER_SETTINGS);
  const [shortcutFeedback, setShortcutFeedback] = useState<ShortcutFeedback | null>(null);

  const [fallbackSurfaceId, setFallbackSurfaceId] = useState<string>('global:home');
  const [boundedSurfaces, setBoundedSurfaces] = useState<string[]>([]);
  const [lastTouchedSurfaceId, setLastTouchedSurfaceId] = useState<string | null>(null);
  const [surfaces, setSurfaces] = useState<Record<string, SurfaceHistory>>({});

  const feedbackTimerRef = useRef<number | null>(null);
  const feedbackSeqRef = useRef<number>(0);

  const emitShortcutFeedback = useCallback((label: string, keycap: string) => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackSeqRef.current += 1;
    setShortcutFeedback({ label, keycap, seq: feedbackSeqRef.current });
    feedbackTimerRef.current = window.setTimeout(() => {
      setShortcutFeedback(null);
      feedbackTimerRef.current = null;
    }, 1250);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const setActiveTool = useCallback((tool: AnnotationTool) => {
    setActiveToolState(tool);
    if (tool !== 'cursor') {
      releaseTrappedFormFocus();
    }
  }, []);

  const setPaletteOpen = useCallback((open: boolean) => {
    setIsPaletteOpenState(open);
  }, []);

  const togglePaletteOpen = useCallback(() => {
    setIsPaletteOpenState((prev) => !prev);
  }, []);

  const updatePenSettings = useCallback((patch: Partial<PenSettings>) => {
    setPenSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateHighlighterSettings = useCallback((patch: Partial<HighlighterSettings>) => {
    setHighlighterSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateLaserSettings = useCallback((patch: Partial<LaserSettings>) => {
    setLaserSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateEraserSettings = useCallback((patch: Partial<EraserSettings>) => {
    setEraserSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const registerBoundedSurface = useCallback((surfaceId: string) => {
    setBoundedSurfaces((prev) => (prev.includes(surfaceId) ? prev : [...prev, surfaceId]));
  }, []);

  const unregisterBoundedSurface = useCallback((surfaceId: string) => {
    setBoundedSurfaces((prev) => prev.filter((id) => id !== surfaceId));
  }, []);

  const hasBoundedSurface = boundedSurfaces.length > 0;

  const activeSurfaceId = useMemo(() => {
    if (boundedSurfaces.length > 0) {
      if (lastTouchedSurfaceId && boundedSurfaces.includes(lastTouchedSurfaceId)) {
        return lastTouchedSurfaceId;
      }
      return boundedSurfaces[boundedSurfaces.length - 1];
    }
    return fallbackSurfaceId;
  }, [boundedSurfaces, lastTouchedSurfaceId, fallbackSurfaceId]);

  const activeSurfaceRef = useRef(activeSurfaceId);
  activeSurfaceRef.current = activeSurfaceId;

  const boundedSurfacesRef = useRef(boundedSurfaces);
  boundedSurfacesRef.current = boundedSurfaces;

  const getStrokes = useCallback(
    (surfaceId: string): AnnotationStroke[] => {
      return surfaces[surfaceId]?.strokes ?? EMPTY_STROKES;
    },
    [surfaces]
  );

  const addStroke = useCallback((surfaceId: string, stroke: AnnotationStroke) => {
    setLastTouchedSurfaceId(surfaceId);
    setSurfaces((prev) => {
      const cur = prev[surfaceId] || { strokes: [], past: [], future: [] };
      const nextPast = [...cur.past.slice(-(MAX_HISTORY_STEPS - 1)), cur.strokes];
      return {
        ...prev,
        [surfaceId]: {
          strokes: [...cur.strokes, stroke],
          past: nextPast,
          future: [],
        },
      };
    });
  }, []);

  const removeStrokes = useCallback((surfaceId: string, strokeIds: string[]) => {
    if (strokeIds.length === 0) return;
    setLastTouchedSurfaceId(surfaceId);
    const idSet = new Set(strokeIds);
    setSurfaces((prev) => {
      const cur = prev[surfaceId];
      if (!cur || !cur.strokes.some((s) => idSet.has(s.id))) return prev;
      const nextPast = [...cur.past.slice(-(MAX_HISTORY_STEPS - 1)), cur.strokes];
      return {
        ...prev,
        [surfaceId]: {
          strokes: cur.strokes.filter((s) => !idSet.has(s.id)),
          past: nextPast,
          future: [],
        },
      };
    });
  }, []);

  const resolveHistoryTarget = useCallback(
    (
      prev: Record<string, SurfaceHistory>,
      kind: 'past' | 'future',
      explicitSurfaceId?: string
    ): string | null => {
      const primaryId = explicitSurfaceId ?? activeSurfaceRef.current;
      const primary = prev[primaryId];
      if (primary && primary[kind].length > 0) return primaryId;
      if (explicitSurfaceId) return null;

      // In double-page Mushaf spreads, seamlessly fall back to the other visible page
      const mounted = boundedSurfacesRef.current;
      for (let i = mounted.length - 1; i >= 0; i--) {
        const id = mounted[i];
        if (id !== primaryId && prev[id] && prev[id][kind].length > 0) {
          return id;
        }
      }
      return null;
    },
    []
  );

  const undo = useCallback(
    (surfaceId?: string) => {
      setSurfaces((prev) => {
        const targetId = resolveHistoryTarget(prev, 'past', surfaceId);
        if (!targetId) return prev;
        const cur = prev[targetId];
        const previous = cur.past[cur.past.length - 1];
        return {
          ...prev,
          [targetId]: {
            strokes: previous,
            past: cur.past.slice(0, -1),
            future: [cur.strokes, ...cur.future.slice(0, MAX_HISTORY_STEPS - 1)],
          },
        };
      });
    },
    [resolveHistoryTarget]
  );

  const redo = useCallback(
    (surfaceId?: string) => {
      setSurfaces((prev) => {
        const targetId = resolveHistoryTarget(prev, 'future', surfaceId);
        if (!targetId) return prev;
        const cur = prev[targetId];
        const next = cur.future[0];
        return {
          ...prev,
          [targetId]: {
            strokes: next,
            past: [...cur.past.slice(-(MAX_HISTORY_STEPS - 1)), cur.strokes],
            future: cur.future.slice(1),
          },
        };
      });
    },
    [resolveHistoryTarget]
  );

  const clearSurface = useCallback((surfaceId?: string) => {
    const targetId = surfaceId ?? activeSurfaceRef.current;
    setSurfaces((prev) => {
      const cur = prev[targetId];
      if (!cur || cur.strokes.length === 0) return prev;
      const nextPast = [...cur.past.slice(-(MAX_HISTORY_STEPS - 1)), cur.strokes];
      return {
        ...prev,
        [targetId]: {
          strokes: [],
          past: nextPast,
          future: [],
        },
      };
    });
  }, []);

  const visibleSurfaceIds = boundedSurfaces.length > 0 ? boundedSurfaces : [activeSurfaceId];
  const canUndo = visibleSurfaceIds.some((id) => (surfaces[id]?.past.length ?? 0) > 0);
  const canRedo = visibleSurfaceIds.some((id) => (surfaces[id]?.future.length ?? 0) > 0);
  const activeStrokeCount = surfaces[activeSurfaceId]?.strokes.length ?? 0;

  // Live refs for the capture-phase keyboard listener (avoids listener churn)
  const liveStateRef = useRef({
    activeTool,
    isPaletteOpen,
    canUndo,
    canRedo,
    activeStrokeCount,
    penSettings,
    highlighterSettings,
    laserSettings,
    eraserSettings,
  });
  liveStateRef.current = {
    activeTool,
    isPaletteOpen,
    canUndo,
    canRedo,
    activeStrokeCount,
    penSettings,
    highlighterSettings,
    laserSettings,
    eraserSettings,
  };

  const stepActiveToolSize = useCallback(
    (delta: -1 | 1) => {
      const state = liveStateRef.current;
      const keycap = delta > 0 ? ']' : '[';
      const step = delta * SIZE_DIAL_STEP;
      if (state.activeTool === 'pen') {
        const curLevel = pxToSizeLevel('pen', state.penSettings.size);
        const nextLevel = snapSizeLevel(curLevel + step);
        updatePenSettings({ size: sizeLevelToPx('pen', nextLevel) });
        emitShortcutFeedback(`سُمك القلم: ${toArabicDigits(nextLevel)}٪`, keycap);
        return true;
      }
      if (state.activeTool === 'highlighter') {
        const curLevel = pxToSizeLevel('highlighter', state.highlighterSettings.size);
        const nextLevel = snapSizeLevel(curLevel + step);
        updateHighlighterSettings({ size: sizeLevelToPx('highlighter', nextLevel) });
        emitShortcutFeedback(`عرض التظليل: ${toArabicDigits(nextLevel)}٪`, keycap);
        return true;
      }
      if (state.activeTool === 'eraser') {
        const curLevel = pxToSizeLevel('eraser', state.eraserSettings.size);
        const nextLevel = snapSizeLevel(curLevel + step);
        updateEraserSettings({ size: sizeLevelToPx('eraser', nextLevel) });
        emitShortcutFeedback(`حجم الممحاة: ${toArabicDigits(nextLevel)}٪`, keycap);
        return true;
      }
      if (state.activeTool === 'laser') {
        const curLevel = pxToSizeLevel('laser', state.laserSettings.size);
        const nextLevel = snapSizeLevel(curLevel + step);
        updateLaserSettings({ size: sizeLevelToPx('laser', nextLevel) });
        emitShortcutFeedback(`سُمك الليزر: ${toArabicDigits(nextLevel)}٪`, keycap);
        return true;
      }
      return false;
    },
    [
      updatePenSettings,
      updateHighlighterSettings,
      updateEraserSettings,
      updateLaserSettings,
      emitShortcutFeedback,
    ]
  );

  // Release trapped <select>/<input> focus & keep iframe keyboard focus whenever user clicks/draws outside editable inputs
  useEffect(() => {
    const onPointerDownFocus = (e: PointerEvent) => {
      if (!isEditableKeyboardTarget(e.target)) {
        releaseTrappedFormFocus();
      }
    };
    window.addEventListener('pointerdown', onPointerDownFocus, { capture: true, passive: true });
    return () => window.removeEventListener('pointerdown', onPointerDownFocus, { capture: true });
  }, []);

  // Global layout-independent keyboard shortcuts (Arabic + English keyboard layouts)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = liveStateRef.current;
      const code = e.code || '';
      const key = (e.key || '').toLowerCase();
      const keyCode = e.keyCode || e.which || 0;
      const isMod = e.metaKey || e.ctrlKey;

      // 1) Undo / Redo / Clear (Ctrl or Cmd modifiers) — only skip inside active text-typing fields (never block on <select> or sliders)
      if (isMod && !e.altKey) {
        if (isTextTypingTarget(e.target)) return;

        const isZ =
          code === 'KeyZ' ||
          keyCode === 90 ||
          key === 'z' ||
          key === 'ئ' ||
          key === 'ظ' ||
          key === 'ز';
        const isY = code === 'KeyY' || keyCode === 89 || key === 'y' || key === 'غ';

        if (isZ) {
          if (e.shiftKey) {
            if (state.canRedo) {
              e.preventDefault();
              e.stopPropagation();
              redo();
              emitShortcutFeedback('إعادة خطوة', 'Ctrl+Shift+Z');
            } else if (state.activeTool !== 'cursor' || state.isPaletteOpen) {
              e.preventDefault();
            }
          } else {
            if (state.canUndo) {
              e.preventDefault();
              e.stopPropagation();
              undo();
              emitShortcutFeedback('تراجع خطوة', 'Ctrl+Z');
            } else if (state.activeTool !== 'cursor' || state.isPaletteOpen) {
              e.preventDefault();
            }
          }
          return;
        }

        if (isY && !e.shiftKey) {
          if (state.canRedo) {
            e.preventDefault();
            e.stopPropagation();
            redo();
            emitShortcutFeedback('إعادة خطوة', 'Ctrl+Y');
          } else if (state.activeTool !== 'cursor' || state.isPaletteOpen) {
            e.preventDefault();
          }
          return;
        }

        if (
          e.shiftKey &&
          !e.repeat &&
          (code === 'Delete' ||
            code === 'Backspace' ||
            keyCode === 46 ||
            keyCode === 8 ||
            key === 'delete' ||
            key === 'backspace')
        ) {
          if (state.activeStrokeCount > 0) {
            e.preventDefault();
            e.stopPropagation();
            clearSurface();
            emitShortcutFeedback('مسح رسومات الصفحة', 'Ctrl+Shift+Del');
          }
          return;
        }
        return;
      }

      // 2) Single-key tool & brush shortcuts (skip inside text inputs / selects / IME composition)
      if (e.altKey || e.isComposing || isEditableKeyboardTarget(e.target)) return;

      if (code === 'Escape' || keyCode === 27 || key === 'escape') {
        if (state.activeTool !== 'cursor') {
          e.preventDefault();
          setActiveToolState('cursor');
          emitShortcutFeedback('وضع التصفح', 'Esc');
        }
        return;
      }

      if (e.shiftKey) return;

      // Brush / Nib size steppers: [ and ] (Arabic ج and د)
      if (code === 'BracketRight' || keyCode === 221 || key === ']' || key === 'د') {
        if (stepActiveToolSize(1)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (code === 'BracketLeft' || keyCode === 219 || key === '[' || key === 'ج') {
        if (stepActiveToolSize(-1)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      if (e.repeat) return;

      if (code === 'KeyP' || keyCode === 80 || key === 'p' || key === 'ح') {
        e.preventDefault();
        e.stopPropagation();
        setActiveToolState('pen');
        emitShortcutFeedback('قلم أبل', 'P');
      } else if (code === 'KeyH' || keyCode === 72 || key === 'h' || key === 'ا') {
        e.preventDefault();
        e.stopPropagation();
        setActiveToolState('highlighter');
        emitShortcutFeedback('تظليل أبل', 'H');
      } else if (code === 'KeyL' || keyCode === 76 || key === 'l' || key === 'م') {
        e.preventDefault();
        e.stopPropagation();
        setActiveToolState('laser');
        emitShortcutFeedback('ليزر ضوئي', 'L');
      } else if (code === 'KeyE' || keyCode === 69 || key === 'e' || key === 'ث') {
        e.preventDefault();
        e.stopPropagation();
        setActiveToolState('eraser');
        emitShortcutFeedback('ممحاة ذكية', 'E');
      } else if (code === 'KeyV' || keyCode === 86 || key === 'v' || key === 'ر') {
        if (state.activeTool !== 'cursor') {
          e.preventDefault();
          e.stopPropagation();
          setActiveToolState('cursor');
          emitShortcutFeedback('وضع التصفح', 'V');
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [undo, redo, clearSurface, stepActiveToolSize, emitShortcutFeedback]);

  const value = useMemo<AnnotationContextValue>(
    () => ({
      activeTool,
      setActiveTool,
      isPaletteOpen,
      setPaletteOpen,
      togglePaletteOpen,
      penSettings,
      updatePenSettings,
      highlighterSettings,
      updateHighlighterSettings,
      laserSettings,
      updateLaserSettings,
      eraserSettings,
      updateEraserSettings,
      activeSurfaceId,
      hasBoundedSurface,
      setFallbackSurfaceId,
      registerBoundedSurface,
      unregisterBoundedSurface,
      getStrokes,
      addStroke,
      removeStrokes,
      undo,
      redo,
      clearSurface,
      canUndo,
      canRedo,
      activeStrokeCount,
      shortcutFeedback,
    }),
    [
      activeTool,
      setActiveTool,
      isPaletteOpen,
      setPaletteOpen,
      togglePaletteOpen,
      penSettings,
      updatePenSettings,
      highlighterSettings,
      updateHighlighterSettings,
      laserSettings,
      updateLaserSettings,
      eraserSettings,
      updateEraserSettings,
      activeSurfaceId,
      hasBoundedSurface,
      registerBoundedSurface,
      unregisterBoundedSurface,
      getStrokes,
      addStroke,
      removeStrokes,
      undo,
      redo,
      clearSurface,
      canUndo,
      canRedo,
      activeStrokeCount,
      shortcutFeedback,
    ]
  );

  const actionsValue = useMemo<AnnotationActionsValue>(
    () => ({
      setActiveTool,
      setPaletteOpen,
      togglePaletteOpen,
      updatePenSettings,
      updateHighlighterSettings,
      updateLaserSettings,
      updateEraserSettings,
      setFallbackSurfaceId,
      registerBoundedSurface,
      unregisterBoundedSurface,
      addStroke,
      removeStrokes,
      undo,
      redo,
      clearSurface,
    }),
    [
      setActiveTool,
      setPaletteOpen,
      togglePaletteOpen,
      updatePenSettings,
      updateHighlighterSettings,
      updateLaserSettings,
      updateEraserSettings,
      registerBoundedSurface,
      unregisterBoundedSurface,
      addStroke,
      removeStrokes,
      undo,
      redo,
      clearSurface,
    ]
  );

  const hasActiveStrokes = activeStrokeCount > 0;

  const toolStateValue = useMemo<AnnotationToolStateValue>(
    () => ({
      activeTool,
      isPaletteOpen,
      penSettings,
      highlighterSettings,
      laserSettings,
      eraserSettings,
      hasBoundedSurface,
      shortcutFeedback,
    }),
    [
      activeTool,
      isPaletteOpen,
      penSettings,
      highlighterSettings,
      laserSettings,
      eraserSettings,
      hasBoundedSurface,
      shortcutFeedback,
    ]
  );

  const dockStateValue = useMemo<AnnotationDockStateValue>(
    () => ({
      canUndo,
      canRedo,
      hasActiveStrokes,
    }),
    [canUndo, canRedo, hasActiveStrokes]
  );

  return (
    <AnnotationActionsContext.Provider value={actionsValue}>
      <AnnotationToolStateContext.Provider value={toolStateValue}>
        <AnnotationDockStateContext.Provider value={dockStateValue}>
          <AnnotationContext.Provider value={value}>{children}</AnnotationContext.Provider>
        </AnnotationDockStateContext.Provider>
      </AnnotationToolStateContext.Provider>
    </AnnotationActionsContext.Provider>
  );
};

export function useAnnotation(): AnnotationContextValue {
  const ctx = useContext(AnnotationContext);
  if (!ctx) {
    throw new Error('useAnnotation must be used within an AnnotationProvider');
  }
  return ctx;
}

export function useAnnotationActions(): AnnotationActionsValue {
  const ctx = useContext(AnnotationActionsContext);
  if (!ctx) {
    throw new Error('useAnnotationActions must be used within an AnnotationProvider');
  }
  return ctx;
}

export function useAnnotationToolState(): AnnotationToolStateValue {
  const ctx = useContext(AnnotationToolStateContext);
  if (!ctx) {
    throw new Error('useAnnotationToolState must be used within an AnnotationProvider');
  }
  return ctx;
}

export function useAnnotationDockState(): AnnotationDockStateValue {
  const ctx = useContext(AnnotationDockStateContext);
  if (!ctx) {
    throw new Error('useAnnotationDockState must be used within an AnnotationProvider');
  }
  return ctx;
}
