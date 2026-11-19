export type AnnotationTool = 'cursor' | 'pen' | 'highlighter' | 'laser' | 'eraser';

export interface AnnotationPoint {
  x: number;
  y: number;
  pressure: number;
  t: number;
}

export type AnnotationShape =
  | {
      type: 'line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      /** Smooth quadratic Bezier curved line / arch / curved underline */
      type: 'arc';
      x1: number;
      y1: number;
      cx: number;
      cy: number;
      x2: number;
      y2: number;
    }
  | {
      /** Circle or optionally rotated ellipse */
      type: 'ellipse';
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      rotation?: number;
    }
  | {
      /** Triangles, rectangles, squares, diamonds, general polygons, or crisp open polylines */
      type: 'polygon';
      points: Array<{ x: number; y: number }>;
      closed: boolean;
    }
  | {
      /** Geometric pointer arrow with either a straight or smoothly curved shaft */
      type: 'arrow';
      x1: number;
      y1: number;
      cx?: number;
      cy?: number;
      x2: number;
      y2: number;
      leftX: number;
      leftY: number;
      rightX: number;
      rightY: number;
    }
  | {
      /** Ultra-smooth idealized freeform curve (e.g. S-curve, wave, tilde, bracket flourish) */
      type: 'curve';
      points: Array<{ x: number; y: number }>;
    };

export interface AnnotationStroke {
  id: string;
  kind: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  smoothing?: number;
  points: AnnotationPoint[];
  shape?: AnnotationShape;
}

export interface PenSettings {
  color: string;
  size: number;
  opacity: number;
  smoothing: number;
  smartShapes: boolean;
}

export interface HighlighterSettings {
  color: string;
  size: number;
  opacity: number;
  smoothing: number;
  straightAssist: boolean;
}

export interface LaserSettings {
  color: string;
  mode: 'trail' | 'dot';
  size: number;
  smoothing: number;
}

export interface EraserSettings {
  size: number;
}

export type SizableAnnotationTool = 'pen' | 'highlighter' | 'laser' | 'eraser';

export const SIZE_DIAL_MIN = 5;
export const SIZE_DIAL_MAX = 100;
export const SIZE_DIAL_STEP = 5;

/** Snaps any raw thickness percentage to a clean 5% detent within 5%..100%. */
export function snapSizeLevel(level: number): number {
  const snapped = Math.round(level / SIZE_DIAL_STEP) * SIZE_DIAL_STEP;
  return Math.max(SIZE_DIAL_MIN, Math.min(SIZE_DIAL_MAX, snapped));
}

/**
 * Converts a unified 5..100 thickness dial percentage (in 5% steps) into calibrated canvas pixels per tool.
 * Pen uses a gentle power curve so 5%..35% gives crisp Mushaf precision while 100% reaches bold marker width.
 */
export function sizeLevelToPx(tool: SizableAnnotationTool, level: number): number {
  const clamped = Math.max(SIZE_DIAL_MIN, Math.min(SIZE_DIAL_MAX, Math.round(level)));
  const t = (clamped - SIZE_DIAL_MIN) / (SIZE_DIAL_MAX - SIZE_DIAL_MIN);
  if (tool === 'pen') {
    return Math.round((1.3 + Math.pow(t, 1.32) * 16.7) * 100) / 100;
  }
  if (tool === 'highlighter') {
    return Math.round((10 + t * 46) * 10) / 10;
  }
  if (tool === 'laser') {
    return Math.round((2.2 + t * 8.8) * 100) / 100;
  }
  return Math.round((12 + t * 52) * 10) / 10;
}

/**
 * Inverse mapping from canvas pixels back to the nearest 5% dial detent (5..100).
 */
export function pxToSizeLevel(tool: SizableAnnotationTool, px: number): number {
  let t = 0;
  if (tool === 'pen') {
    const norm = Math.max(0, Math.min(1, (px - 1.3) / 16.7));
    t = Math.pow(norm, 1 / 1.32);
  } else if (tool === 'highlighter') {
    t = Math.max(0, Math.min(1, (px - 10) / 46));
  } else if (tool === 'laser') {
    t = Math.max(0, Math.min(1, (px - 2.2) / 8.8));
  } else {
    t = Math.max(0, Math.min(1, (px - 12) / 52));
  }
  return snapSizeLevel(SIZE_DIAL_MIN + t * (SIZE_DIAL_MAX - SIZE_DIAL_MIN));
}

export interface ColorSwatch {
  id: string;
  hex: string;
  label: string;
}

export const APPLE_PEN_COLORS: readonly ColorSwatch[] = [
  { id: 'crimson', hex: '#FF3B30', label: 'أحمر أبل للتنبيه' },
  { id: 'royal', hex: '#007AFF', label: 'أزرق أبل للشرح' },
  { id: 'ink', hex: '#1C1C1E', label: 'حبر أسود داكن' },
  { id: 'emerald', hex: '#28B84D', label: 'أخضر للإجادة' },
  { id: 'amber', hex: '#FF9500', label: 'برتقالي دافئ' },
  { id: 'plum', hex: '#AF52DE', label: 'بنفسجي هادئ' },
];

export const APPLE_HIGHLIGHTER_COLORS: readonly ColorSwatch[] = [
  { id: 'sunbeam', hex: '#FFE84D', label: 'أصفر أبل المشرق' },
  { id: 'mint', hex: '#6CE89B', label: 'أخضر نعناعي' },
  { id: 'sky', hex: '#6AD0FF', label: 'أزرق سماوي' },
  { id: 'rose', hex: '#FF85B8', label: 'وردي ناعم' },
  { id: 'peach', hex: '#FFBA5C', label: 'مشمشي دافئ' },
  { id: 'lilac', hex: '#C89BFF', label: 'بنفسجي فاتح' },
];

export const APPLE_LASER_COLORS: readonly ColorSwatch[] = [
  { id: 'ruby', hex: '#FF2D55', label: 'ليزر ياقوتي' },
  { id: 'cyan', hex: '#00B8FF', label: 'ليزر أزرق ضوئي' },
  { id: 'emerald', hex: '#10D978', label: 'ليزر زمردي' },
  { id: 'solar', hex: '#FF9F0A', label: 'ليزر ذهبي' },
];

export const PEN_SIZE_PRESETS = [
  { value: 2.2, label: 'دقيق' },
  { value: 3.6, label: 'متوسط' },
  { value: 5.5, label: 'عريض' },
  { value: 8.2, label: 'سميك' },
] as const;

export const HIGHLIGHTER_SIZE_PRESETS = [
  { value: 16, label: 'رفيع' },
  { value: 24, label: 'متوسط' },
  { value: 32, label: 'عريض' },
  { value: 42, label: 'عريض جداً' },
] as const;

export const ERASER_SIZE_PRESETS = [
  { value: 16, label: 'دقيقة' },
  { value: 26, label: 'متوسطة' },
  { value: 40, label: 'واسعة' },
] as const;

export const DEFAULT_PEN_SETTINGS: PenSettings = {
  color: '#FF3B30',
  size: sizeLevelToPx('pen', 25),
  opacity: 0.96,
  smoothing: 0.78,
  smartShapes: true,
};

export const DEFAULT_HIGHLIGHTER_SETTINGS: HighlighterSettings = {
  color: '#FFE84D',
  size: sizeLevelToPx('highlighter', 35),
  opacity: 0.56,
  smoothing: 0.76,
  straightAssist: true,
};

export const DEFAULT_LASER_SETTINGS: LaserSettings = {
  color: '#FF2D55',
  mode: 'trail',
  size: sizeLevelToPx('laser', 25),
  smoothing: 0.75,
};

export const DEFAULT_ERASER_SETTINGS: EraserSettings = {
  size: sizeLevelToPx('eraser', 30),
};
