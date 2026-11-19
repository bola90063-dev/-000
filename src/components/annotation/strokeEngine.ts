import type { AnnotationPoint, AnnotationShape, AnnotationStroke } from './types';

export interface RenderTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  unitScale: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  pressure: number;
  t: number;
}

export interface CssBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Pt2D {
  x: number;
  y: number;
}

export function cssBoundsToPixelRect(
  bounds: CssBounds | null,
  dprX: number,
  dprY: number,
  maxW: number,
  maxH: number
): PixelRect | null {
  if (!bounds || maxW <= 0 || maxH <= 0) return null;
  const x1 = Math.max(0, Math.floor(bounds.minX * dprX) - 2);
  const y1 = Math.max(0, Math.floor(bounds.minY * dprY) - 2);
  const x2 = Math.min(maxW, Math.ceil(bounds.maxX * dprX) + 2);
  const y2 = Math.min(maxH, Math.ceil(bounds.maxY * dprY) + 2);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return null;
  return { x: x1, y: y1, w, h };
}

export function unionPixelRects(a: PixelRect | null, b: PixelRect | null): PixelRect | null {
  if (!a) return b;
  if (!b) return a;
  const x1 = a.x < b.x ? a.x : b.x;
  const y1 = a.y < b.y ? a.y : b.y;
  const x2 = a.x + a.w > b.x + b.w ? a.x + a.w : b.x + b.w;
  const y2 = a.y + a.h > b.y + b.h ? a.y + a.h : b.y + b.h;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// Reusable module-level typed arrays for ZERO-allocation pen rendering on the 60fps hot path
let penKnotCap = 0;
let knotRawX = new Float32Array(0);
let knotRawY = new Float32Array(0);
let knotRawP = new Float32Array(0);
let knotRawT = new Float64Array(0);
let knotFiltX = new Float32Array(0);
let knotFiltY = new Float32Array(0);
let knotFiltP = new Float32Array(0);
let knotFiltT = new Float64Array(0);
let knotSmAX = new Float32Array(0);
let knotSmAY = new Float32Array(0);
let knotSmBX = new Float32Array(0);
let knotSmBY = new Float32Array(0);

function ensurePenKnotCapacity(needed: number): void {
  if (needed <= penKnotCap) return;
  const next = Math.max(256, needed * 2);
  penKnotCap = next;
  knotRawX = new Float32Array(next);
  knotRawY = new Float32Array(next);
  knotRawP = new Float32Array(next);
  knotRawT = new Float64Array(next);
  knotFiltX = new Float32Array(next);
  knotFiltY = new Float32Array(next);
  knotFiltP = new Float32Array(next);
  knotFiltT = new Float64Array(next);
  knotSmAX = new Float32Array(next);
  knotSmAY = new Float32Array(next);
  knotSmBX = new Float32Array(next);
  knotSmBY = new Float32Array(next);
}

let penDenseCap = 0;
let denseX = new Float32Array(0);
let denseY = new Float32Array(0);
let denseP = new Float32Array(0);
let denseT = new Float64Array(0);
let ribbonDists = new Float32Array(0);
let ribbonRadii = new Float32Array(0);
let ribbonLeftX = new Float32Array(0);
let ribbonLeftY = new Float32Array(0);
let ribbonRightX = new Float32Array(0);
let ribbonRightY = new Float32Array(0);

function ensurePenDenseCapacity(needed: number): void {
  if (needed <= penDenseCap) return;
  const next = Math.max(1024, needed * 2);
  const oldX = denseX;
  const oldY = denseY;
  const oldP = denseP;
  const oldT = denseT;
  penDenseCap = next;
  denseX = new Float32Array(next);
  denseY = new Float32Array(next);
  denseP = new Float32Array(next);
  denseT = new Float64Array(next);
  if (oldX.length > 0) {
    denseX.set(oldX);
    denseY.set(oldY);
    denseP.set(oldP);
    denseT.set(oldT);
  }
  ribbonDists = new Float32Array(next);
  ribbonRadii = new Float32Array(next);
  ribbonLeftX = new Float32Array(next);
  ribbonLeftY = new Float32Array(next);
  ribbonRightX = new Float32Array(next);
  ribbonRightY = new Float32Array(next);
}

function toScreenPoints(points: AnnotationPoint[], tf: RenderTransform): ScreenPoint[] {
  const len = points.length;
  const out: ScreenPoint[] = new Array(len);
  const sx = tf.scaleX;
  const sy = tf.scaleY;
  const ox = tf.offsetX;
  const oy = tf.offsetY;
  for (let i = 0; i < len; i++) {
    const p = points[i];
    out[i] = {
      x: p.x * sx + ox,
      y: p.y * sy + oy,
      pressure: p.pressure,
      t: p.t,
    };
  }
  return out;
}

/**
 * Removes noisy sub-2.5px pixel-staircase micro-jitter knots from mouse/trackpad input
 * while ALWAYS pinning the first point, live tip point, and sharp intentional corners.
 */
function filterMicroJitterKnots(pts: ScreenPoint[], minDistPx: number): ScreenPoint[] {
  const len = pts.length;
  if (len <= 3 || minDistPx <= 0.1) return pts;
  const minDistSq = minDistPx * minDistPx;
  const out: ScreenPoint[] = [pts[0]];
  let lastKept = pts[0];

  for (let i = 1; i < len - 1; i++) {
    const curr = pts[i];
    const dx = curr.x - lastKept.x;
    const dy = curr.y - lastKept.y;
    if (dx * dx + dy * dy >= minDistSq) {
      out.push(curr);
      lastKept = curr;
      continue;
    }

    // Preserve sharp intentional cusps/corners (e.g. Arabic letter teeth & hooks) even at short spacing
    const next = pts[i + 1];
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const l1Sq = dx * dx + dy * dy;
    const l2Sq = v2x * v2x + v2y * v2y;
    if (l1Sq > 0.64 && l2Sq > 0.64) {
      const dot = (dx * v2x + dy * v2y) / Math.sqrt(l1Sq * l2Sq);
      if (dot < 0.25) {
        out.push(curr);
        lastKept = curr;
      }
    }
  }

  out.push(pts[len - 1]);
  return out;
}

/**
 * Apple PencilKit-inspired corner-preserving zero-phase Gaussian smoothing.
 * - First point and live pen tip (last point) stay 100% pinned (0.0px lag/offset).
 * - Smooth curves and straight sweeps are ironed into fluid calligraphy with zero tremor.
 * - Intentional sharp bends (Arabic corners/hooks) automatically damp smoothing to stay crisp.
 */
function smoothControlPolygon(
  pts: ScreenPoint[],
  smoothingAmount: number,
  maxPasses = 4
): ScreenPoint[] {
  const n = pts.length;
  if (n < 3 || smoothingAmount <= 0.02) return pts;

  const clamped = Math.max(0, Math.min(1, smoothingAmount));
  const rawPasses = clamped >= 0.72 ? 4 : clamped >= 0.4 ? 3 : 2;
  const passes = rawPasses < maxPasses ? rawPasses : maxPasses;
  const strength = 0.28 + clamped * 0.44; // 0.28 .. 0.72 per pass

  let curr = pts;
  for (let pass = 0; pass < passes; pass++) {
    const next: ScreenPoint[] = new Array(n);
    next[0] = curr[0];
    next[n - 1] = curr[n - 1];

    for (let i = 1; i < n - 1; i++) {
      const pPrev = curr[i - 1];
      const pCur = curr[i];
      const pNext = curr[i + 1];

      // Angle-aware corner preservation
      const v1x = pCur.x - pPrev.x;
      const v1y = pCur.y - pPrev.y;
      const v2x = pNext.x - pCur.x;
      const v2y = pNext.y - pCur.y;
      const l1Sq = v1x * v1x + v1y * v1y;
      const l2Sq = v2x * v2x + v2y * v2y;

      let cornerFactor = 1.0;
      if (l1Sq > 0.000001 && l2Sq > 0.000001) {
        const dot = (v1x * v2x + v1y * v2y) / Math.sqrt(l1Sq * l2Sq);
        const cf = (dot + 0.15) / 0.85;
        cornerFactor = cf < 0.08 ? 0.08 : cf > 1.0 ? 1.0 : cf;
      }

      // 5-point Gaussian kernel on interior nodes, 3-point near endpoints
      let targetX: number;
      let targetY: number;
      if (i >= 2 && i <= n - 3) {
        const pPrev2 = curr[i - 2];
        const pNext2 = curr[i + 2];
        targetX =
          0.08 * pPrev2.x +
          0.22 * pPrev.x +
          0.4 * pCur.x +
          0.22 * pNext.x +
          0.08 * pNext2.x;
        targetY =
          0.08 * pPrev2.y +
          0.22 * pPrev.y +
          0.4 * pCur.y +
          0.22 * pNext.y +
          0.08 * pNext2.y;
      } else {
        targetX = 0.25 * pPrev.x + 0.5 * pCur.x + 0.25 * pNext.x;
        targetY = 0.25 * pPrev.y + 0.5 * pCur.y + 0.25 * pNext.y;
      }

      const alpha = strength * cornerFactor;
      next[i] = {
        x: pCur.x + (targetX - pCur.x) * alpha,
        y: pCur.y + (targetY - pCur.y) * alpha,
        pressure: pCur.pressure,
        t: pCur.t,
      };
    }

    curr = next;
  }

  return curr;
}

/**
 * Smooth quadratic midpoint subdivision for glass-smooth Apple PencilKit splines.
 */
function subdivideSpline(pts: ScreenPoint[], maxStepPx = 2.0): ScreenPoint[] {
  const len = pts.length;
  if (len <= 1) return pts;
  if (len === 2) {
    const a = pts[0];
    const b = pts[1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(dist / maxStepPx));
    const res: ScreenPoint[] = new Array(steps + 1);
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      res[s] = {
        x: a.x + dx * u,
        y: a.y + dy * u,
        pressure: a.pressure + (b.pressure - a.pressure) * u,
        t: a.t + (b.t - a.t) * u,
      };
    }
    return res;
  }

  const out: ScreenPoint[] = [pts[0]];
  let prevMidX = pts[0].x;
  let prevMidY = pts[0].y;
  let prevMidP = pts[0].pressure;
  let prevMidT = pts[0].t;

  for (let i = 1; i < len; i++) {
    const ctrl = pts[i - 1];
    const curr = pts[i];
    const isLast = i === len - 1;
    const endX = isLast ? curr.x : (ctrl.x + curr.x) * 0.5;
    const endY = isLast ? curr.y : (ctrl.y + curr.y) * 0.5;
    const endP = isLast ? curr.pressure : (ctrl.pressure + curr.pressure) * 0.5;
    const endT = isLast ? curr.t : (ctrl.t + curr.t) * 0.5;

    const dx1 = ctrl.x - prevMidX;
    const dy1 = ctrl.y - prevMidY;
    const dx2 = endX - ctrl.x;
    const dy2 = endY - ctrl.y;
    const approxLen = Math.sqrt(dx1 * dx1 + dy1 * dy1) + Math.sqrt(dx2 * dx2 + dy2 * dy2);
    const steps = Math.max(1, Math.ceil(approxLen / maxStepPx));

    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      const inv = 1 - u;
      const x = inv * inv * prevMidX + 2 * inv * u * ctrl.x + u * u * endX;
      const y = inv * inv * prevMidY + 2 * inv * u * ctrl.y + u * u * endY;
      const pressure = inv * prevMidP + u * endP;
      const t = inv * prevMidT + u * endT;
      out.push({ x, y, pressure, t });
    }

    prevMidX = endX;
    prevMidY = endY;
    prevMidP = endP;
    prevMidT = endT;
  }

  return out;
}

/**
 * Resolves visual screen radii for an ellipse (respecting isotropic scaling when rotated).
 */
function resolveEllipseScreenRadii(
  rx: number,
  ry: number,
  rotation: number | undefined,
  tf: RenderTransform
): { rxPx: number; ryPx: number } {
  if (rotation && Math.abs(rotation) > 0.001) {
    const avgScale = (tf.scaleX + tf.scaleY) * 0.5;
    return {
      rxPx: Math.max(1, rx * avgScale),
      ryPx: Math.max(1, ry * avgScale),
    };
  }
  return {
    rxPx: Math.max(1, rx * tf.scaleX),
    ryPx: Math.max(1, ry * tf.scaleY),
  };
}

/**
 * Traces any snapped AnnotationShape cleanly onto a 2D canvas context.
 * Shared across Apple Pen rendering and Pro-Grade Optical Laser snapping.
 */
export function traceShapePath(
  ctx: CanvasRenderingContext2D,
  shape: AnnotationShape,
  tf: RenderTransform
): void {
  ctx.beginPath();

  if (shape.type === 'line') {
    ctx.moveTo(shape.x1 * tf.scaleX + tf.offsetX, shape.y1 * tf.scaleY + tf.offsetY);
    ctx.lineTo(shape.x2 * tf.scaleX + tf.offsetX, shape.y2 * tf.scaleY + tf.offsetY);
    return;
  }

  if (shape.type === 'arc') {
    ctx.moveTo(shape.x1 * tf.scaleX + tf.offsetX, shape.y1 * tf.scaleY + tf.offsetY);
    ctx.quadraticCurveTo(
      shape.cx * tf.scaleX + tf.offsetX,
      shape.cy * tf.scaleY + tf.offsetY,
      shape.x2 * tf.scaleX + tf.offsetX,
      shape.y2 * tf.scaleY + tf.offsetY
    );
    return;
  }

  if (shape.type === 'ellipse') {
    const cx = shape.cx * tf.scaleX + tf.offsetX;
    const cy = shape.cy * tf.scaleY + tf.offsetY;
    const { rxPx, ryPx } = resolveEllipseScreenRadii(shape.rx, shape.ry, shape.rotation, tf);
    ctx.ellipse(cx, cy, rxPx, ryPx, shape.rotation ?? 0, 0, Math.PI * 2);
    return;
  }

  if (shape.type === 'polygon') {
    const pts = shape.points;
    if (pts.length < 2) return;
    ctx.moveTo(pts[0].x * tf.scaleX + tf.offsetX, pts[0].y * tf.scaleY + tf.offsetY);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * tf.scaleX + tf.offsetX, pts[i].y * tf.scaleY + tf.offsetY);
    }
    if (shape.closed) {
      ctx.closePath();
    }
    return;
  }

  if (shape.type === 'arrow') {
    const x1 = shape.x1 * tf.scaleX + tf.offsetX;
    const y1 = shape.y1 * tf.scaleY + tf.offsetY;
    const x2 = shape.x2 * tf.scaleX + tf.offsetX;
    const y2 = shape.y2 * tf.scaleY + tf.offsetY;
    ctx.moveTo(x1, y1);
    if (shape.cx !== undefined && shape.cy !== undefined) {
      ctx.quadraticCurveTo(
        shape.cx * tf.scaleX + tf.offsetX,
        shape.cy * tf.scaleY + tf.offsetY,
        x2,
        y2
      );
    } else {
      ctx.lineTo(x2, y2);
    }
    const lx = shape.leftX * tf.scaleX + tf.offsetX;
    const ly = shape.leftY * tf.scaleY + tf.offsetY;
    const rx = shape.rightX * tf.scaleX + tf.offsetX;
    const ry = shape.rightY * tf.scaleY + tf.offsetY;
    ctx.moveTo(lx, ly);
    ctx.lineTo(x2, y2);
    ctx.lineTo(rx, ry);
    return;
  }

  if (shape.type === 'curve') {
    const pts = shape.points;
    if (pts.length < 2) return;
    const sx = (p: Pt2D) => p.x * tf.scaleX + tf.offsetX;
    const sy = (p: Pt2D) => p.y * tf.scaleY + tf.offsetY;
    ctx.moveTo(sx(pts[0]), sy(pts[0]));
    if (pts.length === 2) {
      ctx.lineTo(sx(pts[1]), sy(pts[1]));
      return;
    }
    for (let i = 1; i < pts.length - 1; i++) {
      const midX = (sx(pts[i]) + sx(pts[i + 1])) * 0.5;
      const midY = (sy(pts[i]) + sy(pts[i + 1])) * 0.5;
      ctx.quadraticCurveTo(sx(pts[i]), sy(pts[i]), midX, midY);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(sx(last), sy(last));
  }
}

/**
 * Samples any snapped AnnotationShape into dense screen-space polyline(s).
 * Enables authentic angled chisel-tip highlighter sweeps and exact hit-testing on EVERY shape.
 */
export function sampleShapeToPolylines(
  shape: AnnotationShape,
  tf: RenderTransform,
  stepPx = 2.6
): ScreenPoint[][] {
  const mkPt = (x: number, y: number, idx = 0): ScreenPoint => ({
    x,
    y,
    pressure: 0.5,
    t: idx,
  });

  if (shape.type === 'line') {
    const x1 = shape.x1 * tf.scaleX + tf.offsetX;
    const y1 = shape.y1 * tf.scaleY + tf.offsetY;
    const x2 = shape.x2 * tf.scaleX + tf.offsetX;
    const y2 = shape.y2 * tf.scaleY + tf.offsetY;
    return [[mkPt(x1, y1, 0), mkPt(x2, y2, 1)]];
  }

  if (shape.type === 'arc') {
    const x1 = shape.x1 * tf.scaleX + tf.offsetX;
    const y1 = shape.y1 * tf.scaleY + tf.offsetY;
    const cx = shape.cx * tf.scaleX + tf.offsetX;
    const cy = shape.cy * tf.scaleY + tf.offsetY;
    const x2 = shape.x2 * tf.scaleX + tf.offsetX;
    const y2 = shape.y2 * tf.scaleY + tf.offsetY;
    const approxLen = Math.hypot(cx - x1, cy - y1) + Math.hypot(x2 - cx, y2 - cy);
    const steps = Math.max(12, Math.min(120, Math.ceil(approxLen / stepPx)));
    const out: ScreenPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const inv = 1 - u;
      out.push(
        mkPt(
          inv * inv * x1 + 2 * inv * u * cx + u * u * x2,
          inv * inv * y1 + 2 * inv * u * cy + u * u * y2,
          i
        )
      );
    }
    return [out];
  }

  if (shape.type === 'ellipse') {
    const cx = shape.cx * tf.scaleX + tf.offsetX;
    const cy = shape.cy * tf.scaleY + tf.offsetY;
    const { rxPx, ryPx } = resolveEllipseScreenRadii(shape.rx, shape.ry, shape.rotation, tf);
    const rot = shape.rotation ?? 0;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const perim = Math.PI * (3 * (rxPx + ryPx) - Math.sqrt((3 * rxPx + ryPx) * (rxPx + 3 * ryPx)));
    const steps = Math.max(24, Math.min(140, Math.ceil(perim / stepPx)));
    const out: ScreenPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const ang = (i / steps) * Math.PI * 2;
      const lx = Math.cos(ang) * rxPx;
      const ly = Math.sin(ang) * ryPx;
      out.push(mkPt(cx + lx * cosR - ly * sinR, cy + lx * sinR + ly * cosR, i));
    }
    return [out];
  }

  if (shape.type === 'polygon') {
    const pts = shape.points.map((p, idx) =>
      mkPt(p.x * tf.scaleX + tf.offsetX, p.y * tf.scaleY + tf.offsetY, idx)
    );
    if (pts.length < 2) return [pts];
    if (shape.closed) {
      pts.push(mkPt(pts[0].x, pts[0].y, pts.length));
    }
    return [pts];
  }

  if (shape.type === 'arrow') {
    const x1 = shape.x1 * tf.scaleX + tf.offsetX;
    const y1 = shape.y1 * tf.scaleY + tf.offsetY;
    const x2 = shape.x2 * tf.scaleX + tf.offsetX;
    const y2 = shape.y2 * tf.scaleY + tf.offsetY;
    let shaft: ScreenPoint[];
    if (shape.cx !== undefined && shape.cy !== undefined) {
      const cx = shape.cx * tf.scaleX + tf.offsetX;
      const cy = shape.cy * tf.scaleY + tf.offsetY;
      const approxLen = Math.hypot(cx - x1, cy - y1) + Math.hypot(x2 - cx, y2 - cy);
      const steps = Math.max(10, Math.min(96, Math.ceil(approxLen / stepPx)));
      shaft = [];
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const inv = 1 - u;
        shaft.push(
          mkPt(
            inv * inv * x1 + 2 * inv * u * cx + u * u * x2,
            inv * inv * y1 + 2 * inv * u * cy + u * u * y2,
            i
          )
        );
      }
    } else {
      shaft = [mkPt(x1, y1, 0), mkPt(x2, y2, 1)];
    }
    const head: ScreenPoint[] = [
      mkPt(shape.leftX * tf.scaleX + tf.offsetX, shape.leftY * tf.scaleY + tf.offsetY, 0),
      mkPt(x2, y2, 1),
      mkPt(shape.rightX * tf.scaleX + tf.offsetX, shape.rightY * tf.scaleY + tf.offsetY, 2),
    ];
    return [shaft, head];
  }

  if (shape.type === 'curve') {
    const screenKnots = shape.points.map((p, idx) =>
      mkPt(p.x * tf.scaleX + tf.offsetX, p.y * tf.scaleY + tf.offsetY, idx)
    );
    return [subdivideSpline(screenKnots, stepPx)];
  }

  return [];
}

function computeShapeCssBounds(
  shape: AnnotationShape,
  tf: RenderTransform,
  pad: number
): CssBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  const sx = tf.scaleX;
  const sy = tf.scaleY;
  const ox = tf.offsetX;
  const oy = tf.offsetY;

  if (shape.type === 'line') {
    include(shape.x1 * sx + ox, shape.y1 * sy + oy);
    include(shape.x2 * sx + ox, shape.y2 * sy + oy);
  } else if (shape.type === 'arc') {
    include(shape.x1 * sx + ox, shape.y1 * sy + oy);
    include(shape.cx * sx + ox, shape.cy * sy + oy);
    include(shape.x2 * sx + ox, shape.y2 * sy + oy);
  } else if (shape.type === 'ellipse') {
    const cx = shape.cx * sx + ox;
    const cy = shape.cy * sy + oy;
    const { rxPx, ryPx } = resolveEllipseScreenRadii(shape.rx, shape.ry, shape.rotation, tf);
    const rot = shape.rotation ?? 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const ex = Math.sqrt(rxPx * rxPx * cos * cos + ryPx * ryPx * sin * sin);
    const ey = Math.sqrt(rxPx * rxPx * sin * sin + ryPx * ryPx * cos * cos);
    minX = cx - ex;
    maxX = cx + ex;
    minY = cy - ey;
    maxY = cy + ey;
  } else if (shape.type === 'polygon' || shape.type === 'curve') {
    const pts = shape.points;
    for (let i = 0; i < pts.length; i++) {
      include(pts[i].x * sx + ox, pts[i].y * sy + oy);
    }
  } else if (shape.type === 'arrow') {
    include(shape.x1 * sx + ox, shape.y1 * sy + oy);
    include(shape.x2 * sx + ox, shape.y2 * sy + oy);
    include(shape.leftX * sx + ox, shape.leftY * sy + oy);
    include(shape.rightX * sx + ox, shape.rightY * sy + oy);
    if (shape.cx !== undefined && shape.cy !== undefined) {
      include(shape.cx * sx + ox, shape.cy * sy + oy);
    }
  }

  if (!Number.isFinite(minX)) return null;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/**
 * Apple PencilKit-inspired variable-width calligraphic ink pen renderer.
 *
 * Ultra-low-latency hot-path design:
 * - Zero JS object or TypedArray allocations per frame (reusable flat Float32Array scratch buffers).
 * - Single Skia hardware-antialiased `ctx.fill()` pass (zero expensive multi-thousand-vertex round-join `ctx.stroke()`).
 * - Returns the tight CSS-space bounding box so live draft canvases clear ONLY the dirty region.
 */
export function drawApplePenStroke(
  ctx: CanvasRenderingContext2D,
  stroke: AnnotationStroke,
  tf: RenderTransform,
  isLiveDraft = false,
  overrideOpacity?: number
): CssBounds | null {
  const baseWidth = Math.max(1.2, stroke.size * tf.unitScale);
  ctx.save();
  ctx.globalAlpha = overrideOpacity ?? stroke.opacity;
  ctx.fillStyle = stroke.color;
  ctx.strokeStyle = stroke.color;

  // Snapped crisp Universal Apple Smart Shape (line, curved arc, ellipse, triangle/rect/polygon, arrow, smooth curve)
  if (stroke.shape) {
    traceShapePath(ctx, stroke.shape, tf);
    ctx.lineWidth = baseWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
    return computeShapeCssBounds(stroke.shape, tf, baseWidth * 0.75 + 4);
  }

  const pts = stroke.points;
  const rawLen = pts.length;
  if (rawLen === 0) {
    ctx.restore();
    return null;
  }

  const sx = tf.scaleX;
  const sy = tf.scaleY;
  const ox = tf.offsetX;
  const oy = tf.offsetY;

  // Single tap / dot -> clean ink dot
  if (rawLen === 1) {
    const px = pts[0].x * sx + ox;
    const py = pts[0].y * sy + oy;
    const r = Math.max(1.1, baseWidth * 0.56);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const pad = r + 3;
    return { minX: px - pad, minY: py - pad, maxX: px + pad, maxY: py + pad };
  }

  ensurePenKnotCapacity(rawLen);

  let hasStylusPressure = false;
  for (let i = 0; i < rawLen; i++) {
    const p = pts[i];
    knotRawX[i] = p.x * sx + ox;
    knotRawY[i] = p.y * sy + oy;
    const pr = p.pressure;
    knotRawP[i] = pr;
    knotRawT[i] = p.t;
    if (!hasStylusPressure && pr > 0.01 && Math.abs(pr - 0.5) > 0.04) {
      hasStylusPressure = true;
    }
  }

  // 1. Corner-preserving micro-jitter filter into knotFilt*
  const smoothLevel = stroke.smoothing ?? 0.78;
  const minDistPx = smoothLevel > 0.05 ? 1.4 + smoothLevel * 1.8 : 0;
  let filtLen = 0;

  if (rawLen <= 3 || minDistPx <= 0.1) {
    filtLen = rawLen;
    for (let i = 0; i < rawLen; i++) {
      knotFiltX[i] = knotRawX[i];
      knotFiltY[i] = knotRawY[i];
      knotFiltP[i] = knotRawP[i];
      knotFiltT[i] = knotRawT[i];
    }
  } else {
    const minDistSq = minDistPx * minDistPx;
    knotFiltX[0] = knotRawX[0];
    knotFiltY[0] = knotRawY[0];
    knotFiltP[0] = knotRawP[0];
    knotFiltT[0] = knotRawT[0];
    filtLen = 1;
    let lastX = knotRawX[0];
    let lastY = knotRawY[0];

    for (let i = 1; i < rawLen - 1; i++) {
      const cx = knotRawX[i];
      const cy = knotRawY[i];
      const dx = cx - lastX;
      const dy = cy - lastY;
      const l1Sq = dx * dx + dy * dy;
      if (l1Sq >= minDistSq) {
        knotFiltX[filtLen] = cx;
        knotFiltY[filtLen] = cy;
        knotFiltP[filtLen] = knotRawP[i];
        knotFiltT[filtLen] = knotRawT[i];
        filtLen++;
        lastX = cx;
        lastY = cy;
        continue;
      }

      if (l1Sq > 0.64) {
        const v2x = knotRawX[i + 1] - cx;
        const v2y = knotRawY[i + 1] - cy;
        const l2Sq = v2x * v2x + v2y * v2y;
        if (l2Sq > 0.64 && (dx * v2x + dy * v2y) / Math.sqrt(l1Sq * l2Sq) < 0.25) {
          knotFiltX[filtLen] = cx;
          knotFiltY[filtLen] = cy;
          knotFiltP[filtLen] = knotRawP[i];
          knotFiltT[filtLen] = knotRawT[i];
          filtLen++;
          lastX = cx;
          lastY = cy;
        }
      }
    }

    knotFiltX[filtLen] = knotRawX[rawLen - 1];
    knotFiltY[filtLen] = knotRawY[rawLen - 1];
    knotFiltP[filtLen] = knotRawP[rawLen - 1];
    knotFiltT[filtLen] = knotRawT[rawLen - 1];
    filtLen++;
  }

  // 2. Zero-phase corner-preserving Gaussian smoothing (zero heap allocations via ping-pong buffers)
  let srcX = knotFiltX;
  let srcY = knotFiltY;
  if (filtLen >= 3 && smoothLevel > 0.02) {
    const clamped = smoothLevel < 0 ? 0 : smoothLevel > 1 ? 1 : smoothLevel;
    const passes = isLiveDraft
      ? 2
      : clamped >= 0.72
      ? 4
      : clamped >= 0.4
      ? 3
      : 2;
    const strength = 0.28 + clamped * 0.44;

    let dstX = knotSmAX;
    let dstY = knotSmAY;
    for (let pass = 0; pass < passes; pass++) {
      dstX[0] = srcX[0];
      dstY[0] = srcY[0];
      dstX[filtLen - 1] = srcX[filtLen - 1];
      dstY[filtLen - 1] = srcY[filtLen - 1];

      for (let i = 1; i < filtLen - 1; i++) {
        const prevX = srcX[i - 1];
        const prevY = srcY[i - 1];
        const curX = srcX[i];
        const curY = srcY[i];
        const nextX = srcX[i + 1];
        const nextY = srcY[i + 1];

        const v1x = curX - prevX;
        const v1y = curY - prevY;
        const v2x = nextX - curX;
        const v2y = nextY - curY;
        const l1Sq = v1x * v1x + v1y * v1y;
        const l2Sq = v2x * v2x + v2y * v2y;

        let cornerFactor = 1.0;
        if (l1Sq > 0.000001 && l2Sq > 0.000001) {
          const dot = (v1x * v2x + v1y * v2y) / Math.sqrt(l1Sq * l2Sq);
          const cf = (dot + 0.15) / 0.85;
          cornerFactor = cf < 0.08 ? 0.08 : cf > 1.0 ? 1.0 : cf;
        }

        let targetX: number;
        let targetY: number;
        if (i >= 2 && i <= filtLen - 3) {
          targetX =
            0.08 * srcX[i - 2] +
            0.22 * prevX +
            0.4 * curX +
            0.22 * nextX +
            0.08 * srcX[i + 2];
          targetY =
            0.08 * srcY[i - 2] +
            0.22 * prevY +
            0.4 * curY +
            0.22 * nextY +
            0.08 * srcY[i + 2];
        } else {
          targetX = 0.25 * prevX + 0.5 * curX + 0.25 * nextX;
          targetY = 0.25 * prevY + 0.5 * curY + 0.25 * nextY;
        }

        const alpha = strength * cornerFactor;
        dstX[i] = curX + (targetX - curX) * alpha;
        dstY[i] = curY + (targetY - curY) * alpha;
      }

      srcX = dstX;
      srcY = dstY;
      dstX = srcX === knotSmAX ? knotSmBX : knotSmAX;
      dstY = srcY === knotSmAY ? knotSmBY : knotSmAY;
    }
  }

  // 3. Quadratic midpoint spline subdivision directly into dense* Float32Arrays
  const maxStepPx = isLiveDraft ? 3.8 : 2.2;
  let n = 0;

  if (filtLen === 2) {
    const ax = srcX[0];
    const ay = srcY[0];
    const bx = srcX[1];
    const by = srcY[1];
    const dx = bx - ax;
    const dy = by - ay;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(dist / maxStepPx));
    ensurePenDenseCapacity(steps + 2);
    const ap = knotFiltP[0];
    const dp = knotFiltP[1] - ap;
    const at = knotFiltT[0];
    const dt = knotFiltT[1] - at;
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      denseX[s] = ax + dx * u;
      denseY[s] = ay + dy * u;
      denseP[s] = ap + dp * u;
      denseT[s] = at + dt * u;
    }
    n = steps + 1;
  } else {
    ensurePenDenseCapacity(filtLen * 4 + 16);
    denseX[0] = srcX[0];
    denseY[0] = srcY[0];
    denseP[0] = knotFiltP[0];
    denseT[0] = knotFiltT[0];
    n = 1;

    let prevMidX = srcX[0];
    let prevMidY = srcY[0];
    let prevMidP = knotFiltP[0];
    let prevMidT = knotFiltT[0];

    for (let i = 1; i < filtLen; i++) {
      const ctrlX = srcX[i - 1];
      const ctrlY = srcY[i - 1];
      const ctrlP = knotFiltP[i - 1];
      const ctrlT = knotFiltT[i - 1];
      const curX = srcX[i];
      const curY = srcY[i];
      const curP = knotFiltP[i];
      const curT = knotFiltT[i];
      const isLast = i === filtLen - 1;
      const endX = isLast ? curX : (ctrlX + curX) * 0.5;
      const endY = isLast ? curY : (ctrlY + curY) * 0.5;
      const endP = isLast ? curP : (ctrlP + curP) * 0.5;
      const endT = isLast ? curT : (ctrlT + curT) * 0.5;

      const d1x = ctrlX - prevMidX;
      const d1y = ctrlY - prevMidY;
      const d2x = endX - ctrlX;
      const d2y = endY - ctrlY;
      const approxLen = Math.sqrt(d1x * d1x + d1y * d1y) + Math.sqrt(d2x * d2x + d2y * d2y);
      const steps = Math.max(1, Math.ceil(approxLen / maxStepPx));

      if (n + steps + 2 > penDenseCap) {
        ensurePenDenseCapacity(n + steps + 64);
      }

      for (let s = 1; s <= steps; s++) {
        const u = s / steps;
        const inv = 1 - u;
        denseX[n] = inv * inv * prevMidX + 2 * inv * u * ctrlX + u * u * endX;
        denseY[n] = inv * inv * prevMidY + 2 * inv * u * ctrlY + u * u * endY;
        denseP[n] = inv * prevMidP + u * endP;
        denseT[n] = inv * prevMidT + u * endT;
        n++;
      }

      prevMidX = endX;
      prevMidY = endY;
      prevMidP = endP;
      prevMidT = endT;
    }
  }

  if (n < 2) {
    ctx.restore();
    return null;
  }

  // 4. Compute cumulative arc length & velocity/pressure calligraphy radii
  ribbonDists[0] = 0;
  let totalLen = 0;
  for (let i = 1; i < n; i++) {
    const dx = denseX[i] - denseX[i - 1];
    const dy = denseY[i] - denseY[i - 1];
    totalLen += Math.sqrt(dx * dx + dy * dy);
    ribbonDists[i] = totalLen;
  }

  if (totalLen < 0.8) {
    const px = denseX[0];
    const py = denseY[0];
    const r = Math.max(1.1, baseWidth * 0.56);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const pad = r + 3;
    return { minX: px - pad, minY: py - pad, maxX: px + pad, maxY: py + pad };
  }

  // +0.18px compensates exactly for replacing the costly 0.4px round-join outline stroke with pure Skia AA fill
  const halfW = baseWidth * 0.5 + 0.18;
  const startTaperLen = Math.min(12 * tf.unitScale, totalLen * 0.2);
  const endTaperLen = Math.min(16 * tf.unitScale, totalLen * 0.25);
  let smoothedFactor = 1.0;

  for (let i = 0; i < n; i++) {
    let targetFactor = 1.0;
    if (hasStylusPressure) {
      const p = denseP[i] < 0.08 ? 0.08 : denseP[i] > 1 ? 1 : denseP[i];
      targetFactor = 0.42 + p * 0.86;
    } else {
      const prevIdx = i > 3 ? i - 3 : 0;
      const nextIdx = i + 3 < n ? i + 3 : n - 1;
      const segDist = ribbonDists[nextIdx] - ribbonDists[prevIdx];
      const dt = denseT[nextIdx] - denseT[prevIdx];
      const velocity = segDist / (dt > 1 ? dt : 1);
      const speedNorm = velocity > 2.05 ? 1 : velocity / 2.05;
      targetFactor = 1.07 - speedNorm * 0.3;
    }

    smoothedFactor = smoothedFactor * 0.84 + targetFactor * 0.16;

    let taper = 1.0;
    const dist = ribbonDists[i];
    if (startTaperLen > 0 && dist < startTaperLen) {
      const u = dist / startTaperLen;
      taper *= 0.62 + 0.38 * Math.sin(u * 1.5707963);
    }
    const rem = totalLen - dist;
    if (endTaperLen > 0 && rem < endTaperLen) {
      const u = rem / endTaperLen;
      taper *= 0.48 + 0.52 * Math.sin(u * 1.5707963);
    }

    const r = halfW * smoothedFactor * taper;
    ribbonRadii[i] = r > 0.6 ? r : 0.6;
  }

  // Two-pass symmetric radius blur eliminates any micro-pinch kinks along tight loops
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < n - 1; i++) {
      ribbonRadii[i] = 0.25 * ribbonRadii[i - 1] + 0.5 * ribbonRadii[i] + 0.25 * ribbonRadii[i + 1];
    }
  }

  // 5. Build left & right envelope edges + tight CSS bounds in one single pass
  let lastNx = 0;
  let lastNy = -1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxR = 0;

  for (let i = 0; i < n; i++) {
    const prevIdx = i > 2 ? i - 2 : 0;
    const nextIdx = i + 2 < n ? i + 2 : n - 1;
    const dx = denseX[nextIdx] - denseX[prevIdx];
    const dy = denseY[nextIdx] - denseY[prevIdx];
    const lenSq = dx * dx + dy * dy;
    if (lenSq > 0.000001) {
      const invLen = 1 / Math.sqrt(lenSq);
      lastNx = -dy * invLen;
      lastNy = dx * invLen;
    }
    const cx = denseX[i];
    const cy = denseY[i];
    const r = ribbonRadii[i];
    if (r > maxR) maxR = r;
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
    ribbonLeftX[i] = cx + lastNx * r;
    ribbonLeftY[i] = cy + lastNy * r;
    ribbonRightX[i] = cx - lastNx * r;
    ribbonRightY[i] = cy - lastNy * r;
  }

  // Single continuous hardware-antialiased filled polygon ribbon + rounded caps
  ctx.beginPath();
  ctx.moveTo(ribbonLeftX[0], ribbonLeftY[0]);
  for (let i = 1; i < n; i++) {
    ctx.lineTo(ribbonLeftX[i], ribbonLeftY[i]);
  }

  const endAngle = Math.atan2(ribbonLeftY[n - 1] - denseY[n - 1], ribbonLeftX[n - 1] - denseX[n - 1]);
  ctx.arc(denseX[n - 1], denseY[n - 1], ribbonRadii[n - 1], endAngle, endAngle + Math.PI, false);

  for (let i = n - 1; i >= 0; i--) {
    ctx.lineTo(ribbonRightX[i], ribbonRightY[i]);
  }

  const startAngle = Math.atan2(ribbonRightY[0] - denseY[0], ribbonRightX[0] - denseX[0]);
  ctx.arc(denseX[0], denseY[0], ribbonRadii[0], startAngle, startAngle + Math.PI, false);

  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const pad = maxR + 3;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export interface LivePenDraftSession {
  frozenCanvas: HTMLCanvasElement;
  frozenCtx: CanvasRenderingContext2D | null;
  strokeId: string;
  color: string;
  size: number;
  smoothing: number;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  unitScale: number;
  pw: number;
  ph: number;
  hasPressure: boolean;
  rawProcessed: number;
  filtLen: number;
  filtCap: number;
  filtX: Float32Array;
  filtY: Float32Array;
  filtP: Float32Array;
  filtT: Float64Array;
  frozenFiltEnd: number;
  frozenBounds: PixelRect | null;
  prevTailRect: PixelRect | null;
  lastFullRect: PixelRect | null;
}

export function createLivePenDraftSession(): LivePenDraftSession {
  const frozenCanvas = document.createElement('canvas');
  const cap = 512;
  return {
    frozenCanvas,
    frozenCtx: frozenCanvas.getContext('2d'),
    strokeId: '',
    color: '',
    size: 0,
    smoothing: 0,
    scaleX: 0,
    scaleY: 0,
    offsetX: 0,
    offsetY: 0,
    unitScale: 1,
    pw: 0,
    ph: 0,
    hasPressure: false,
    rawProcessed: 0,
    filtLen: 0,
    filtCap: cap,
    filtX: new Float32Array(cap),
    filtY: new Float32Array(cap),
    filtP: new Float32Array(cap),
    filtT: new Float64Array(cap),
    frozenFiltEnd: 0,
    frozenBounds: null,
    prevTailRect: null,
    lastFullRect: null,
  };
}

function ensureSessionFiltCapacity(session: LivePenDraftSession, needed: number): void {
  if (needed <= session.filtCap) return;
  const next = Math.max(512, needed * 2);
  const nextX = new Float32Array(next);
  const nextY = new Float32Array(next);
  const nextP = new Float32Array(next);
  const nextT = new Float64Array(next);
  nextX.set(session.filtX.subarray(0, session.filtLen));
  nextY.set(session.filtY.subarray(0, session.filtLen));
  nextP.set(session.filtP.subarray(0, session.filtLen));
  nextT.set(session.filtT.subarray(0, session.filtLen));
  session.filtX = nextX;
  session.filtY = nextY;
  session.filtP = nextP;
  session.filtT = nextT;
  session.filtCap = next;
}

export function resetLivePenDraftSession(session: LivePenDraftSession): void {
  if (session.frozenCtx && session.pw > 0 && session.ph > 0) {
    const fb = session.frozenBounds;
    session.frozenCtx.save();
    session.frozenCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (fb) {
      session.frozenCtx.clearRect(fb.x, fb.y, fb.w, fb.h);
    } else {
      session.frozenCtx.clearRect(0, 0, session.pw, session.ph);
    }
    session.frozenCtx.restore();
  }
  session.strokeId = '';
  session.rawProcessed = 0;
  session.filtLen = 0;
  session.frozenFiltEnd = 0;
  session.frozenBounds = null;
  session.prevTailRect = null;
  session.lastFullRect = null;
  session.hasPressure = false;
}

function renderPenWindowSlice(
  ctx: CanvasRenderingContext2D,
  filtX: Float32Array,
  filtY: Float32Array,
  filtP: Float32Array,
  filtT: Float64Array,
  totalFiltLen: number,
  smoothLevel: number,
  baseWidth: number,
  unitScale: number,
  hasStylusPressure: boolean,
  color: string,
  emitStartFilt: number,
  emitEndFilt: number,
  includeStartCap: boolean,
  includeEndCap: boolean,
  applyStartTaper: boolean,
  applyEndTaper: boolean
): CssBounds | null {
  const winStart = emitStartFilt > 14 ? emitStartFilt - 14 : 0;
  const winEnd = emitEndFilt + 12 < totalFiltLen ? emitEndFilt + 12 : totalFiltLen - 1;
  const winLen = winEnd - winStart + 1;
  if (winLen < 2) return null;

  ensurePenKnotCapacity(winLen);
  for (let i = 0; i < winLen; i++) {
    knotRawX[i] = filtX[winStart + i];
    knotRawY[i] = filtY[winStart + i];
    knotRawP[i] = filtP[winStart + i];
    knotRawT[i] = filtT[winStart + i];
  }

  let srcX = knotRawX;
  let srcY = knotRawY;
  if (winLen >= 3 && smoothLevel > 0.02) {
    const clamped = smoothLevel < 0 ? 0 : smoothLevel > 1 ? 1 : smoothLevel;
    const passes = 2;
    const strength = 0.28 + clamped * 0.44;
    let dstX = knotSmAX;
    let dstY = knotSmAY;

    for (let pass = 0; pass < passes; pass++) {
      dstX[0] = srcX[0];
      dstY[0] = srcY[0];
      dstX[winLen - 1] = srcX[winLen - 1];
      dstY[winLen - 1] = srcY[winLen - 1];

      for (let i = 1; i < winLen - 1; i++) {
        const prevX = srcX[i - 1];
        const prevY = srcY[i - 1];
        const curX = srcX[i];
        const curY = srcY[i];
        const nextX = srcX[i + 1];
        const nextY = srcY[i + 1];

        const v1x = curX - prevX;
        const v1y = curY - prevY;
        const v2x = nextX - curX;
        const v2y = nextY - curY;
        const l1Sq = v1x * v1x + v1y * v1y;
        const l2Sq = v2x * v2x + v2y * v2y;

        let cornerFactor = 1.0;
        if (l1Sq > 0.000001 && l2Sq > 0.000001) {
          const dot = (v1x * v2x + v1y * v2y) / Math.sqrt(l1Sq * l2Sq);
          const cf = (dot + 0.15) / 0.85;
          cornerFactor = cf < 0.08 ? 0.08 : cf > 1.0 ? 1.0 : cf;
        }

        let targetX: number;
        let targetY: number;
        if (i >= 2 && i <= winLen - 3) {
          targetX =
            0.08 * srcX[i - 2] +
            0.22 * prevX +
            0.4 * curX +
            0.22 * nextX +
            0.08 * srcX[i + 2];
          targetY =
            0.08 * srcY[i - 2] +
            0.22 * prevY +
            0.4 * curY +
            0.22 * nextY +
            0.08 * srcY[i + 2];
        } else {
          targetX = 0.25 * prevX + 0.5 * curX + 0.25 * nextX;
          targetY = 0.25 * prevY + 0.5 * curY + 0.25 * nextY;
        }

        const alpha = strength * cornerFactor;
        dstX[i] = curX + (targetX - curX) * alpha;
        dstY[i] = curY + (targetY - curY) * alpha;
      }

      srcX = dstX;
      srcY = dstY;
      dstX = srcX === knotSmAX ? knotSmBX : knotSmAX;
      dstY = srcY === knotSmAY ? knotSmBY : knotSmAY;
    }
  }

  const maxStepPx = 3.8;
  ensurePenDenseCapacity(winLen * 4 + 16);
  denseX[0] = srcX[0];
  denseY[0] = srcY[0];
  denseP[0] = knotRawP[0];
  denseT[0] = knotRawT[0];
  let n = 1;

  let prevMidX = srcX[0];
  let prevMidY = srcY[0];
  let prevMidP = knotRawP[0];
  let prevMidT = knotRawT[0];

  const relEmitStart = emitStartFilt - winStart;
  const relEmitEnd = emitEndFilt - winStart;
  let splitStartDense = relEmitStart <= 0 ? 0 : -1;
  let splitEndDense = -1;

  for (let i = 1; i < winLen; i++) {
    const ctrlX = srcX[i - 1];
    const ctrlY = srcY[i - 1];
    const ctrlP = knotRawP[i - 1];
    const ctrlT = knotRawT[i - 1];
    const curX = srcX[i];
    const curY = srcY[i];
    const curP = knotRawP[i];
    const curT = knotRawT[i];
    const isGlobalLast = winStart + i === totalFiltLen - 1;
    const endX = isGlobalLast ? curX : (ctrlX + curX) * 0.5;
    const endY = isGlobalLast ? curY : (ctrlY + curY) * 0.5;
    const endP = isGlobalLast ? curP : (ctrlP + curP) * 0.5;
    const endT = isGlobalLast ? curT : (ctrlT + curT) * 0.5;

    const d1x = ctrlX - prevMidX;
    const d1y = ctrlY - prevMidY;
    const d2x = endX - ctrlX;
    const d2y = endY - ctrlY;
    const approxLen = Math.sqrt(d1x * d1x + d1y * d1y) + Math.sqrt(d2x * d2x + d2y * d2y);
    const steps = Math.max(1, Math.ceil(approxLen / maxStepPx));

    if (n + steps + 2 > penDenseCap) {
      ensurePenDenseCapacity(n + steps + 64);
    }

    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      const inv = 1 - u;
      denseX[n] = inv * inv * prevMidX + 2 * inv * u * ctrlX + u * u * endX;
      denseY[n] = inv * inv * prevMidY + 2 * inv * u * ctrlY + u * u * endY;
      denseP[n] = inv * prevMidP + u * endP;
      denseT[n] = inv * prevMidT + u * endT;
      n++;
    }

    if (i === relEmitStart) {
      splitStartDense = n - 1;
    }
    if (i === relEmitEnd) {
      splitEndDense = n - 1;
    }

    prevMidX = endX;
    prevMidY = endY;
    prevMidP = endP;
    prevMidT = endT;
  }

  if (splitStartDense < 0) splitStartDense = 0;
  if (splitEndDense < 0) splitEndDense = n - 1;
  if (splitEndDense <= splitStartDense || n < 2) return null;

  ribbonDists[0] = 0;
  let totalLen = 0;
  for (let i = 1; i < n; i++) {
    const dx = denseX[i] - denseX[i - 1];
    const dy = denseY[i] - denseY[i - 1];
    totalLen += Math.sqrt(dx * dx + dy * dy);
    ribbonDists[i] = totalLen;
  }

  const endDist = ribbonDists[splitEndDense];
  const halfW = baseWidth * 0.5 + 0.18;
  const startTaperLen = applyStartTaper ? Math.min(12 * unitScale, endDist * 0.2) : 0;
  const endTaperLen = applyEndTaper ? Math.min(16 * unitScale, endDist * 0.25) : 0;
  let smoothedFactor = 1.0;

  for (let i = 0; i < n; i++) {
    let targetFactor = 1.0;
    if (hasStylusPressure) {
      const p = denseP[i] < 0.08 ? 0.08 : denseP[i] > 1 ? 1 : denseP[i];
      targetFactor = 0.42 + p * 0.86;
    } else {
      const prevIdx = i > 3 ? i - 3 : 0;
      const nextIdx = i + 3 < n ? i + 3 : n - 1;
      const segDist = ribbonDists[nextIdx] - ribbonDists[prevIdx];
      const dt = denseT[nextIdx] - denseT[prevIdx];
      const velocity = segDist / (dt > 1 ? dt : 1);
      const speedNorm = velocity > 2.05 ? 1 : velocity / 2.05;
      targetFactor = 1.07 - speedNorm * 0.3;
    }

    smoothedFactor = smoothedFactor * 0.84 + targetFactor * 0.16;

    let taper = 1.0;
    const dist = ribbonDists[i];
    if (startTaperLen > 0 && dist < startTaperLen) {
      const u = dist / startTaperLen;
      taper *= 0.62 + 0.38 * Math.sin(u * 1.5707963);
    }
    if (endTaperLen > 0) {
      const rem = endDist - dist;
      if (rem >= 0 && rem < endTaperLen) {
        const u = rem / endTaperLen;
        taper *= 0.48 + 0.52 * Math.sin(u * 1.5707963);
      }
    }

    const r = halfW * smoothedFactor * taper;
    ribbonRadii[i] = r > 0.6 ? r : 0.6;
  }

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < n - 1; i++) {
      ribbonRadii[i] = 0.25 * ribbonRadii[i - 1] + 0.5 * ribbonRadii[i] + 0.25 * ribbonRadii[i + 1];
    }
  }

  const drawStart = emitStartFilt > 0 && splitStartDense > 0 ? splitStartDense - 1 : splitStartDense;
  const drawEnd = splitEndDense;

  let lastNx = 0;
  let lastNy = -1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxR = 0;

  for (let i = drawStart; i <= drawEnd; i++) {
    const prevIdx = i > 2 ? i - 2 : 0;
    const nextIdx = i + 2 < n ? i + 2 : n - 1;
    const dx = denseX[nextIdx] - denseX[prevIdx];
    const dy = denseY[nextIdx] - denseY[prevIdx];
    const lenSq = dx * dx + dy * dy;
    if (lenSq > 0.000001) {
      const invLen = 1 / Math.sqrt(lenSq);
      lastNx = -dy * invLen;
      lastNy = dx * invLen;
    }
    const cx = denseX[i];
    const cy = denseY[i];
    const r = ribbonRadii[i];
    if (r > maxR) maxR = r;
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
    ribbonLeftX[i] = cx + lastNx * r;
    ribbonLeftY[i] = cy + lastNy * r;
    ribbonRightX[i] = cx - lastNx * r;
    ribbonRightY[i] = cy - lastNy * r;
  }

  ctx.save();
  ctx.globalAlpha = 1.0;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(ribbonLeftX[drawStart], ribbonLeftY[drawStart]);
  for (let i = drawStart + 1; i <= drawEnd; i++) {
    ctx.lineTo(ribbonLeftX[i], ribbonLeftY[i]);
  }

  if (includeEndCap) {
    const endAngle = Math.atan2(
      ribbonLeftY[drawEnd] - denseY[drawEnd],
      ribbonLeftX[drawEnd] - denseX[drawEnd]
    );
    ctx.arc(denseX[drawEnd], denseY[drawEnd], ribbonRadii[drawEnd], endAngle, endAngle + Math.PI, false);
  } else {
    ctx.lineTo(ribbonRightX[drawEnd], ribbonRightY[drawEnd]);
  }

  for (let i = drawEnd; i >= drawStart; i--) {
    ctx.lineTo(ribbonRightX[i], ribbonRightY[i]);
  }

  if (includeStartCap) {
    const startAngle = Math.atan2(
      ribbonRightY[drawStart] - denseY[drawStart],
      ribbonRightX[drawStart] - denseX[drawStart]
    );
    ctx.arc(
      denseX[drawStart],
      denseY[drawStart],
      ribbonRadii[drawStart],
      startAngle,
      startAngle + Math.PI,
      false
    );
  }

  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const pad = maxR + 3;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/**
 * O(1) constant-time live Apple Pen renderer with offscreen prefix baking:
 * - Short/snapped strokes (< 38 pts or snapped shapes) render directly in < 0.2ms.
 * - Longer strokes freeze settled chunks onto an offscreen canvas and only clear/fill the ~16-knot tip tail.
 * - Uses CSS opacity on `draftCanvas` during chunked live drag so overlapping alpha=1 fills have zero seam darkening.
 */
export function renderLivePenDraftWithSession(
  dCtx: CanvasRenderingContext2D,
  draftCanvas: HTMLCanvasElement,
  session: LivePenDraftSession,
  stroke: AnnotationStroke,
  tf: RenderTransform,
  dprX: number,
  dprY: number,
  pw: number,
  ph: number,
  prevOtherRect: PixelRect | null
): PixelRect | null {
  const clearFullRect = (rect: PixelRect | null) => {
    if (!rect) return;
    dCtx.save();
    dCtx.setTransform(1, 0, 0, 1, 0, 0);
    dCtx.clearRect(rect.x, rect.y, rect.w, rect.h);
    dCtx.restore();
  };

  const targetCssOpacity = stroke.opacity < 0.999 ? String(stroke.opacity) : '';
  const hasCssOpacity = targetCssOpacity !== '';

  // 1. Snapped Smart Shapes or short strokes -> fast direct path (CSS opacity already applied on pointerdown)
  if (stroke.shape || stroke.points.length < 22) {
    if (draftCanvas.style.opacity !== targetCssOpacity) {
      draftCanvas.style.opacity = targetCssOpacity;
    }
    if (session.frozenFiltEnd > 0 || session.frozenBounds || session.strokeId) {
      clearFullRect(unionPixelRects(session.lastFullRect, prevOtherRect));
      resetLivePenDraftSession(session);
    } else {
      clearFullRect(prevOtherRect);
    }
    dCtx.save();
    dCtx.setTransform(dprX, 0, 0, dprY, 0, 0);
    const bounds = drawApplePenStroke(dCtx, stroke, tf, true, hasCssOpacity ? 1.0 : stroke.opacity);
    dCtx.restore();
    const pxRect = cssBoundsToPixelRect(bounds, dprX, dprY, pw, ph);
    session.lastFullRect = pxRect;
    return pxRect;
  }

  const pts = stroke.points;
  const rawLen = pts.length;
  const sx = tf.scaleX;
  const sy = tf.scaleY;
  const ox = tf.offsetX;
  const oy = tf.offsetY;
  const smoothLevel = stroke.smoothing ?? 0.78;
  const baseWidth = Math.max(1.2, stroke.size * tf.unitScale);

  if (draftCanvas.style.opacity !== targetCssOpacity) {
    draftCanvas.style.opacity = targetCssOpacity;
  }

  // Sync offscreen frozen canvas dimensions if needed
  if (session.frozenCanvas.width !== pw || session.frozenCanvas.height !== ph) {
    session.frozenCanvas.width = pw;
    session.frozenCanvas.height = ph;
    session.frozenCtx = session.frozenCanvas.getContext('2d');
    session.pw = pw;
    session.ph = ph;
    session.frozenFiltEnd = 0;
    session.frozenBounds = null;
    session.prevTailRect = null;
  }

  // Detect any stroke/transform/style reset
  const needsReset =
    session.strokeId !== stroke.id ||
    session.color !== stroke.color ||
    session.size !== stroke.size ||
    session.smoothing !== smoothLevel ||
    session.scaleX !== sx ||
    session.scaleY !== sy ||
    session.offsetX !== ox ||
    session.offsetY !== oy;

  if (needsReset) {
    if (prevOtherRect || session.lastFullRect) {
      clearFullRect(unionPixelRects(prevOtherRect, session.lastFullRect));
    }
    resetLivePenDraftSession(session);
    session.strokeId = stroke.id;
    session.color = stroke.color;
    session.size = stroke.size;
    session.smoothing = smoothLevel;
    session.scaleX = sx;
    session.scaleY = sy;
    session.offsetX = ox;
    session.offsetY = oy;
    session.unitScale = tf.unitScale;
    session.pw = pw;
    session.ph = ph;
  }

  // Incrementally update filtered knot array (O(new points))
  const minDistPx = smoothLevel > 0.05 ? 1.4 + smoothLevel * 1.8 : 0;
  const minDistSq = minDistPx * minDistPx;

  if (session.rawProcessed === 0 && rawLen > 0) {
    ensureSessionFiltCapacity(session, rawLen + 4);
    const p0 = pts[0];
    session.filtX[0] = p0.x * sx + ox;
    session.filtY[0] = p0.y * sy + oy;
    session.filtP[0] = p0.pressure;
    session.filtT[0] = p0.t;
    if (!session.hasPressure && p0.pressure > 0.01 && Math.abs(p0.pressure - 0.5) > 0.04) {
      session.hasPressure = true;
    }
    session.filtLen = 1;
    session.rawProcessed = 1;
  }

  while (session.rawProcessed < rawLen - 1) {
    const i = session.rawProcessed;
    const p = pts[i];
    const cx = p.x * sx + ox;
    const cy = p.y * sy + oy;
    const pr = p.pressure;
    if (!session.hasPressure && pr > 0.01 && Math.abs(pr - 0.5) > 0.04) {
      session.hasPressure = true;
    }

    let keep = false;
    if (minDistPx <= 0.1) {
      keep = true;
    } else {
      const lastX = session.filtX[session.filtLen - 1];
      const lastY = session.filtY[session.filtLen - 1];
      const dx = cx - lastX;
      const dy = cy - lastY;
      const l1Sq = dx * dx + dy * dy;
      if (l1Sq >= minDistSq) {
        keep = true;
      } else if (l1Sq > 0.64) {
        const np = pts[i + 1];
        const v2x = np.x * sx + ox - cx;
        const v2y = np.y * sy + oy - cy;
        const l2Sq = v2x * v2x + v2y * v2y;
        if (l2Sq > 0.64 && (dx * v2x + dy * v2y) / Math.sqrt(l1Sq * l2Sq) < 0.25) {
          keep = true;
        }
      }
    }

    if (keep) {
      ensureSessionFiltCapacity(session, session.filtLen + 4);
      session.filtX[session.filtLen] = cx;
      session.filtY[session.filtLen] = cy;
      session.filtP[session.filtLen] = pr;
      session.filtT[session.filtLen] = p.t;
      session.filtLen++;
    }
    session.rawProcessed = i + 1;
  }

  // Temporarily append current live tip at filt[filtLen]
  const tip = pts[rawLen - 1];
  if (!session.hasPressure && tip.pressure > 0.01 && Math.abs(tip.pressure - 0.5) > 0.04) {
    session.hasPressure = true;
  }
  ensureSessionFiltCapacity(session, session.filtLen + 2);
  session.filtX[session.filtLen] = tip.x * sx + ox;
  session.filtY[session.filtLen] = tip.y * sy + oy;
  session.filtP[session.filtLen] = tip.pressure;
  session.filtT[session.filtLen] = tip.t;
  const totalFiltLen = session.filtLen + 1;

  // If stroke has very few filtered knots (tight scribble), use fast direct draw
  if (totalFiltLen < 20 || !session.frozenCtx) {
    clearFullRect(prevOtherRect);
    dCtx.save();
    dCtx.setTransform(dprX, 0, 0, dprY, 0, 0);
    const bounds = drawApplePenStroke(dCtx, stroke, tf, true, hasCssOpacity ? 1.0 : stroke.opacity);
    dCtx.restore();
    const pxRect = cssBoundsToPixelRect(bounds, dprX, dprY, pw, ph);
    session.lastFullRect = pxRect;
    return pxRect;
  }

  if (session.frozenFiltEnd === 0) {
    clearFullRect(unionPixelRects(prevOtherRect, session.lastFullRect));
  }

  // Check if we can freeze a new settled prefix chunk safely away from start/end tapers
  const targetFreezeEnd = totalFiltLen - 10;
  if (
    targetFreezeEnd > session.frozenFiltEnd &&
    (session.frozenFiltEnd === 0 || targetFreezeEnd - session.frozenFiltEnd >= 10)
  ) {
    // Verify start & tail margins so tapers stay strictly away from split points
    let tailChord = 0;
    for (let k = targetFreezeEnd + 1; k < totalFiltLen; k++) {
      const dx = session.filtX[k] - session.filtX[k - 1];
      const dy = session.filtY[k] - session.filtY[k - 1];
      tailChord += Math.hypot(dx, dy);
      if (tailChord >= 22 * tf.unitScale) break;
    }

    let headOk = session.frozenFiltEnd > 0;
    if (!headOk) {
      let headChord = 0;
      for (let k = 1; k <= targetFreezeEnd; k++) {
        const dx = session.filtX[k] - session.filtX[k - 1];
        const dy = session.filtY[k] - session.filtY[k - 1];
        headChord += Math.hypot(dx, dy);
        if (headChord >= 18 * tf.unitScale) {
          headOk = true;
          break;
        }
      }
    }

    if (headOk && tailChord >= 22 * tf.unitScale) {
      const fCtx = session.frozenCtx;
      fCtx.save();
      fCtx.setTransform(dprX, 0, 0, dprY, 0, 0);
      const chunkBounds = renderPenWindowSlice(
        fCtx,
        session.filtX,
        session.filtY,
        session.filtP,
        session.filtT,
        totalFiltLen,
        smoothLevel,
        baseWidth,
        tf.unitScale,
        session.hasPressure,
        stroke.color,
        session.frozenFiltEnd,
        targetFreezeEnd,
        session.frozenFiltEnd === 0,
        false,
        session.frozenFiltEnd === 0,
        false
      );
      fCtx.restore();

      const chunkRect = cssBoundsToPixelRect(chunkBounds, dprX, dprY, pw, ph);
      if (chunkRect) {
        session.frozenBounds = unionPixelRects(session.frozenBounds, chunkRect);
        dCtx.save();
        dCtx.setTransform(1, 0, 0, 1, 0, 0);
        dCtx.clearRect(chunkRect.x, chunkRect.y, chunkRect.w, chunkRect.h);
        dCtx.drawImage(
          session.frozenCanvas,
          chunkRect.x,
          chunkRect.y,
          chunkRect.w,
          chunkRect.h,
          chunkRect.x,
          chunkRect.y,
          chunkRect.w,
          chunkRect.h
        );
        dCtx.restore();
      }
      session.frozenFiltEnd = targetFreezeEnd;
    }
  }

  // If chunking couldn't start yet (tight cluster), fall back to direct draw at CSS opacity
  if (session.frozenFiltEnd === 0) {
    clearFullRect(prevOtherRect);
    dCtx.save();
    dCtx.setTransform(dprX, 0, 0, dprY, 0, 0);
    const bounds = drawApplePenStroke(dCtx, stroke, tf, true, hasCssOpacity ? 1.0 : stroke.opacity);
    dCtx.restore();
    const pxRect = cssBoundsToPixelRect(bounds, dprX, dprY, pw, ph);
    session.lastFullRect = pxRect;
    return pxRect;
  }

  // Draw ONLY the active ~16-knot tail over a dirty-rect restore from frozenCanvas
  dCtx.save();
  dCtx.setTransform(dprX, 0, 0, dprY, 0, 0);
  // First clear previous tail region & restore settled prefix pixels from frozenCanvas
  const prevTail = session.prevTailRect;
  if (prevTail) {
    dCtx.save();
    dCtx.setTransform(1, 0, 0, 1, 0, 0);
    dCtx.clearRect(prevTail.x, prevTail.y, prevTail.w, prevTail.h);
    dCtx.drawImage(
      session.frozenCanvas,
      prevTail.x,
      prevTail.y,
      prevTail.w,
      prevTail.h,
      prevTail.x,
      prevTail.y,
      prevTail.w,
      prevTail.h
    );
    dCtx.restore();
  }

  const tailBounds = renderPenWindowSlice(
    dCtx,
    session.filtX,
    session.filtY,
    session.filtP,
    session.filtT,
    totalFiltLen,
    smoothLevel,
    baseWidth,
    tf.unitScale,
    session.hasPressure,
    stroke.color,
    session.frozenFiltEnd,
    totalFiltLen - 1,
    false,
    true,
    false,
    true
  );
  dCtx.restore();

  const nextTailRect = cssBoundsToPixelRect(tailBounds, dprX, dprY, pw, ph);
  session.prevTailRect = nextTailRect;
  const fullRect = unionPixelRects(session.frozenBounds, nextTailRect);
  session.lastFullRect = fullRect;
  return fullRect;
}

/**
 * Draws a single angled Apple chisel-tip nib polygon at (x, y).
 * Tilted at -22 deg with crisp softened corners, just like Apple PencilKit's Highlighter.
 */
const CHISEL_ANGLE = (-22 * Math.PI) / 180;
const CHISEL_COS = Math.cos(CHISEL_ANGLE);
const CHISEL_SIN = Math.sin(CHISEL_ANGLE);

function drawChiselNib(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  halfThick: number,
  halfHeight: number
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(CHISEL_ANGLE);
  const w = halfThick * 2;
  const h = halfHeight * 2;
  const r = Math.min(halfThick * 0.9, 2.6);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(-halfThick, -halfHeight, w, h, r);
  } else {
    ctx.rect(-halfThick, -halfHeight, w, h);
  }
  ctx.fill();
  ctx.restore();
}

function sweepChiselPolyline(
  sCtx: CanvasRenderingContext2D,
  dense: ScreenPoint[],
  halfThick: number,
  halfHeight: number,
  stampVertices = false
): void {
  const len = dense.length;
  if (len === 0) return;

  if (len === 1) {
    drawChiselNib(sCtx, dense[0].x, dense[0].y, halfThick, halfHeight);
    return;
  }

  const ux = -CHISEL_SIN * halfHeight;
  const uy = CHISEL_COS * halfHeight;

  // Draw crisp angled chisel start & end caps
  drawChiselNib(sCtx, dense[0].x, dense[0].y, halfThick, halfHeight);
  drawChiselNib(sCtx, dense[len - 1].x, dense[len - 1].y, halfThick, halfHeight);

  // Batch ALL chisel quads into a single GPU fill call instead of hundreds of separate beginPath/fill passes
  sCtx.beginPath();
  let hasVerticalSegments = false;
  for (let i = 0; i < len - 1; i++) {
    const a = dense[i];
    const b = dense[i + 1];

    sCtx.moveTo(a.x + ux, a.y + uy);
    sCtx.lineTo(b.x + ux, b.y + uy);
    sCtx.lineTo(b.x - ux, b.y - uy);
    sCtx.lineTo(a.x - ux, a.y - uy);
    sCtx.closePath();

    if (!hasVerticalSegments) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLenSq = dx * dx + dy * dy;
      if (segLenSq > 0.0001) {
        const cross = Math.abs(dx * uy - dy * ux) / (Math.sqrt(segLenSq) * halfHeight);
        if (cross < 0.38) hasVerticalSegments = true;
      }
    }
  }
  sCtx.fill();

  if (stampVertices) {
    for (let i = 1; i < len - 1; i++) {
      drawChiselNib(sCtx, dense[i].x, dense[i].y, halfThick, halfHeight);
    }
  }

  // Batch vertical sweeps where movement aligns with the chisel edge into one stroke call
  if (hasVerticalSegments) {
    sCtx.beginPath();
    for (let i = 0; i < len - 1; i++) {
      const a = dense[i];
      const b = dense[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLenSq = dx * dx + dy * dy;
      if (segLenSq > 0.0001) {
        const cross = Math.abs(dx * uy - dy * ux) / (Math.sqrt(segLenSq) * halfHeight);
        if (cross < 0.38) {
          sCtx.moveTo(a.x, a.y);
          sCtx.lineTo(b.x, b.y);
        }
      }
    }
    sCtx.lineWidth = halfThick * 2.3;
    sCtx.lineCap = 'round';
    sCtx.stroke();
  }
}

/**
 * Renders a single chisel-tip highlighter stroke into `scratchCanvas` strictly within its
 * tight device-pixel bounding box and returns that `PixelRect` for dirty-rect compositing.
 */
export function renderHighlighterToScratch(
  scratchCanvas: HTMLCanvasElement,
  stroke: AnnotationStroke,
  tf: RenderTransform,
  dprX: number,
  dprY: number,
  wPx: number,
  hPx: number,
  isLiveDraft = false
): PixelRect | null {
  if (wPx <= 0 || hPx <= 0) return null;
  if (scratchCanvas.width !== wPx || scratchCanvas.height !== hPx) {
    scratchCanvas.width = wPx;
    scratchCanvas.height = hPx;
  }
  const sCtx = scratchCanvas.getContext('2d');
  if (!sCtx) return null;

  const nibHeight = Math.max(8, stroke.size * tf.unitScale);
  const halfHeight = nibHeight * 0.5;
  const halfThick = Math.max(1.8, nibHeight * 0.13);

  let polylines: ScreenPoint[][];
  let stampVertices = false;

  if (stroke.shape) {
    polylines = sampleShapeToPolylines(stroke.shape, tf, isLiveDraft ? 5.0 : 3.0);
    stampVertices = stroke.shape.type === 'polygon' || stroke.shape.type === 'arrow';
  } else {
    const rawScreen = toScreenPoints(stroke.points, tf);
    if (rawScreen.length === 0) return null;
    if (rawScreen.length === 1) {
      polylines = [rawScreen];
    } else {
      const smoothLevel = stroke.smoothing ?? 0.76;
      const filteredHl = filterMicroJitterKnots(
        rawScreen,
        smoothLevel > 0.05 ? 1.5 + smoothLevel * 2.2 : 0
      );
      const smoothedHl = smoothControlPolygon(filteredHl, smoothLevel, isLiveDraft ? 2 : 4);
      polylines = [subdivideSpline(smoothedHl, isLiveDraft ? 5.2 : 3.0)];
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let pIdx = 0; pIdx < polylines.length; pIdx++) {
    const poly = polylines[pIdx];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return null;

  const padCss = halfHeight + halfThick + 4;
  const bx = Math.max(0, Math.floor((minX - padCss) * dprX));
  const by = Math.max(0, Math.floor((minY - padCss) * dprY));
  const bx2 = Math.min(wPx, Math.ceil((maxX + padCss) * dprX));
  const by2 = Math.min(hPx, Math.ceil((maxY + padCss) * dprY));
  const bw = bx2 - bx;
  const bh = by2 - by;
  if (bw <= 0 || bh <= 0) return null;

  sCtx.save();
  sCtx.setTransform(1, 0, 0, 1, 0, 0);
  sCtx.clearRect(bx, by, bw, bh);
  sCtx.scale(dprX, dprY);
  sCtx.fillStyle = stroke.color;
  sCtx.strokeStyle = stroke.color;
  sCtx.globalAlpha = 1;

  for (let pIdx = 0; pIdx < polylines.length; pIdx++) {
    sweepChiselPolyline(sCtx, polylines[pIdx], halfThick, halfHeight, stampVertices);
  }

  // Authentic real-marker ink meniscus on final commit (skipped during live drag for 2x GPU speed)
  if (!isLiveDraft && nibHeight >= 13) {
    const innerHalfHeight = halfHeight * 0.62;
    const innerUx = -CHISEL_SIN * innerHalfHeight;
    const innerUy = CHISEL_COS * innerHalfHeight;
    sCtx.save();
    sCtx.globalCompositeOperation = 'destination-out';
    sCtx.globalAlpha = 0.1;
    sCtx.fillStyle = '#000000';
    sCtx.beginPath();
    let hasInner = false;
    for (let pIdx = 0; pIdx < polylines.length; pIdx++) {
      const poly = polylines[pIdx];
      if (poly.length < 2) continue;
      hasInner = true;
      for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i];
        const b = poly[i + 1];
        sCtx.moveTo(a.x + innerUx, a.y + innerUy);
        sCtx.lineTo(b.x + innerUx, b.y + innerUy);
        sCtx.lineTo(b.x - innerUx, b.y - innerUy);
        sCtx.lineTo(a.x - innerUx, a.y - innerUy);
        sCtx.closePath();
      }
    }
    if (hasInner) {
      sCtx.fill();
    }
    sCtx.restore();
  }

  sCtx.restore();
  return { x: bx, y: by, w: bw, h: bh };
}

/**
 * O(1) constant-time incremental live Highlighter renderer reusing the session's offscreen
 * prefix canvas (`alpha = 1.0` opaque chunks -> `scratchCanvas` -> tight `dirty` multiply composite).
 */
export function renderLiveHighlighterWithSession(
  scratchCanvas: HTMLCanvasElement,
  session: LivePenDraftSession,
  stroke: AnnotationStroke,
  tf: RenderTransform,
  dprX: number,
  dprY: number,
  pw: number,
  ph: number
): PixelRect | null {
  if (pw <= 0 || ph <= 0) return null;

  // Short strokes or smart shapes -> fast direct scratch path (zero destination-out during drag)
  if (stroke.shape || stroke.points.length < 20) {
    if (session.strokeId) {
      resetLivePenDraftSession(session);
    }
    return renderHighlighterToScratch(scratchCanvas, stroke, tf, dprX, dprY, pw, ph, true);
  }

  if (scratchCanvas.width !== pw || scratchCanvas.height !== ph) {
    scratchCanvas.width = pw;
    scratchCanvas.height = ph;
  }
  const sCtx = scratchCanvas.getContext('2d');
  if (!sCtx) return null;

  if (session.frozenCanvas.width !== pw || session.frozenCanvas.height !== ph) {
    session.frozenCanvas.width = pw;
    session.frozenCanvas.height = ph;
    session.frozenCtx = session.frozenCanvas.getContext('2d');
    session.pw = pw;
    session.ph = ph;
    session.frozenFiltEnd = 0;
    session.frozenBounds = null;
    session.prevTailRect = null;
  }

  const pts = stroke.points;
  const rawLen = pts.length;
  const sx = tf.scaleX;
  const sy = tf.scaleY;
  const ox = tf.offsetX;
  const oy = tf.offsetY;
  const smoothLevel = stroke.smoothing ?? 0.76;
  const nibHeight = Math.max(8, stroke.size * tf.unitScale);
  const halfHeight = nibHeight * 0.5;
  const halfThick = Math.max(1.8, nibHeight * 0.13);
  const ux = -CHISEL_SIN * halfHeight;
  const uy = CHISEL_COS * halfHeight;
  const padCss = halfHeight + halfThick + 4;

  const needsReset =
    session.strokeId !== stroke.id ||
    session.color !== stroke.color ||
    session.size !== stroke.size ||
    session.smoothing !== smoothLevel ||
    session.scaleX !== sx ||
    session.scaleY !== sy ||
    session.offsetX !== ox ||
    session.offsetY !== oy;

  if (needsReset) {
    resetLivePenDraftSession(session);
    session.strokeId = stroke.id;
    session.color = stroke.color;
    session.size = stroke.size;
    session.smoothing = smoothLevel;
    session.scaleX = sx;
    session.scaleY = sy;
    session.offsetX = ox;
    session.offsetY = oy;
    session.unitScale = tf.unitScale;
    session.pw = pw;
    session.ph = ph;
    sCtx.save();
    sCtx.setTransform(1, 0, 0, 1, 0, 0);
    sCtx.clearRect(0, 0, pw, ph);
    sCtx.restore();
  }

  const minDistPx = smoothLevel > 0.05 ? 1.5 + smoothLevel * 2.2 : 0;
  const minDistSq = minDistPx * minDistPx;

  if (session.rawProcessed === 0 && rawLen > 0) {
    ensureSessionFiltCapacity(session, rawLen + 4);
    const p0 = pts[0];
    session.filtX[0] = p0.x * sx + ox;
    session.filtY[0] = p0.y * sy + oy;
    session.filtLen = 1;
    session.rawProcessed = 1;
  }

  while (session.rawProcessed < rawLen - 1) {
    const i = session.rawProcessed;
    const p = pts[i];
    const cx = p.x * sx + ox;
    const cy = p.y * sy + oy;
    let keep = false;
    if (minDistPx <= 0.1) {
      keep = true;
    } else {
      const lastX = session.filtX[session.filtLen - 1];
      const lastY = session.filtY[session.filtLen - 1];
      const dx = cx - lastX;
      const dy = cy - lastY;
      const l1Sq = dx * dx + dy * dy;
      if (l1Sq >= minDistSq) {
        keep = true;
      } else if (l1Sq > 0.64) {
        const np = pts[i + 1];
        const v2x = np.x * sx + ox - cx;
        const v2y = np.y * sy + oy - cy;
        const l2Sq = v2x * v2x + v2y * v2y;
        if (l2Sq > 0.64 && (dx * v2x + dy * v2y) / Math.sqrt(l1Sq * l2Sq) < 0.25) {
          keep = true;
        }
      }
    }
    if (keep) {
      ensureSessionFiltCapacity(session, session.filtLen + 4);
      session.filtX[session.filtLen] = cx;
      session.filtY[session.filtLen] = cy;
      session.filtLen++;
    }
    session.rawProcessed = i + 1;
  }

  const tip = pts[rawLen - 1];
  ensureSessionFiltCapacity(session, session.filtLen + 2);
  session.filtX[session.filtLen] = tip.x * sx + ox;
  session.filtY[session.filtLen] = tip.y * sy + oy;
  const totalFiltLen = session.filtLen + 1;

  if (totalFiltLen < 18 || !session.frozenCtx) {
    return renderHighlighterToScratch(scratchCanvas, stroke, tf, dprX, dprY, pw, ph, true);
  }

  const renderChiselSlice = (
    destCtx: CanvasRenderingContext2D,
    emitStartFilt: number,
    emitEndFilt: number,
    includeEndCaps: boolean
  ): PixelRect | null => {
    const winStart = emitStartFilt > 10 ? emitStartFilt - 10 : 0;
    const winEnd = emitEndFilt + 8 < totalFiltLen ? emitEndFilt + 8 : totalFiltLen - 1;
    const winLen = winEnd - winStart + 1;
    if (winLen < 2) return null;

    ensurePenKnotCapacity(winLen);
    for (let i = 0; i < winLen; i++) {
      knotRawX[i] = session.filtX[winStart + i];
      knotRawY[i] = session.filtY[winStart + i];
    }

    let srcX = knotRawX;
    let srcY = knotRawY;
    if (winLen >= 3 && smoothLevel > 0.02) {
      const clamped = smoothLevel < 0 ? 0 : smoothLevel > 1 ? 1 : smoothLevel;
      const strength = 0.28 + clamped * 0.44;
      let dstX = knotSmAX;
      let dstY = knotSmAY;
      for (let pass = 0; pass < 2; pass++) {
        dstX[0] = srcX[0];
        dstY[0] = srcY[0];
        dstX[winLen - 1] = srcX[winLen - 1];
        dstY[winLen - 1] = srcY[winLen - 1];
        for (let i = 1; i < winLen - 1; i++) {
          const prevX = srcX[i - 1];
          const prevY = srcY[i - 1];
          const curX = srcX[i];
          const curY = srcY[i];
          const nextX = srcX[i + 1];
          const nextY = srcY[i + 1];
          const v1x = curX - prevX;
          const v1y = curY - prevY;
          const v2x = nextX - curX;
          const v2y = nextY - curY;
          const l1Sq = v1x * v1x + v1y * v1y;
          const l2Sq = v2x * v2x + v2y * v2y;
          let cf = 1.0;
          if (l1Sq > 0.000001 && l2Sq > 0.000001) {
            const dot = (v1x * v2x + v1y * v2y) / Math.sqrt(l1Sq * l2Sq);
            cf = Math.max(0.08, Math.min(1.0, (dot + 0.15) / 0.85));
          }
          const tx = 0.25 * prevX + 0.5 * curX + 0.25 * nextX;
          const ty = 0.25 * prevY + 0.5 * curY + 0.25 * nextY;
          const alpha = strength * cf;
          dstX[i] = curX + (tx - curX) * alpha;
          dstY[i] = curY + (ty - curY) * alpha;
        }
        srcX = dstX;
        srcY = dstY;
        dstX = srcX === knotSmAX ? knotSmBX : knotSmAX;
        dstY = srcY === knotSmAY ? knotSmBY : knotSmAY;
      }
    }

    ensurePenDenseCapacity(winLen * 3 + 16);
    denseX[0] = srcX[0];
    denseY[0] = srcY[0];
    let n = 1;
    let prevMidX = srcX[0];
    let prevMidY = srcY[0];
    const relEmitStart = emitStartFilt - winStart;
    const relEmitEnd = emitEndFilt - winStart;
    let splitStart = relEmitStart <= 0 ? 0 : -1;
    let splitEnd = -1;

    for (let i = 1; i < winLen; i++) {
      const ctrlX = srcX[i - 1];
      const ctrlY = srcY[i - 1];
      const curX = srcX[i];
      const curY = srcY[i];
      const isGlobalLast = winStart + i === totalFiltLen - 1;
      const endX = isGlobalLast ? curX : (ctrlX + curX) * 0.5;
      const endY = isGlobalLast ? curY : (ctrlY + curY) * 0.5;
      const approxLen =
        Math.hypot(ctrlX - prevMidX, ctrlY - prevMidY) + Math.hypot(endX - ctrlX, endY - ctrlY);
      const steps = Math.max(1, Math.ceil(approxLen / 5.2));
      if (n + steps + 2 > penDenseCap) {
        ensurePenDenseCapacity(n + steps + 64);
      }
      for (let s = 1; s <= steps; s++) {
        const u = s / steps;
        const inv = 1 - u;
        denseX[n] = inv * inv * prevMidX + 2 * inv * u * ctrlX + u * u * endX;
        denseY[n] = inv * inv * prevMidY + 2 * inv * u * ctrlY + u * u * endY;
        n++;
      }
      if (i === relEmitStart) splitStart = n - 1;
      if (i === relEmitEnd) splitEnd = n - 1;
      prevMidX = endX;
      prevMidY = endY;
    }

    if (splitStart < 0) splitStart = 0;
    if (splitEnd < 0) splitEnd = n - 1;
    if (splitEnd <= splitStart || n < 2) return null;

    const drawStart = emitStartFilt > 0 && splitStart > 0 ? splitStart - 1 : splitStart;
    const drawEnd = splitEnd;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    destCtx.save();
    destCtx.setTransform(dprX, 0, 0, dprY, 0, 0);
    destCtx.fillStyle = stroke.color;
    destCtx.strokeStyle = stroke.color;
    destCtx.globalAlpha = 1;

    if (emitStartFilt === 0) {
      drawChiselNib(destCtx, denseX[drawStart], denseY[drawStart], halfThick, halfHeight);
    }
    if (includeEndCaps) {
      drawChiselNib(destCtx, denseX[drawEnd], denseY[drawEnd], halfThick, halfHeight);
    }

    destCtx.beginPath();
    let hasVert = false;
    for (let i = drawStart; i < drawEnd; i++) {
      const ax = denseX[i];
      const ay = denseY[i];
      const bx = denseX[i + 1];
      const by = denseY[i + 1];
      if (ax < minX) minX = ax;
      if (ax > maxX) maxX = ax;
      if (ay < minY) minY = ay;
      if (ay > maxY) maxY = ay;
      if (bx < minX) minX = bx;
      if (bx > maxX) maxX = bx;
      if (by < minY) minY = by;
      if (by > maxY) maxY = by;

      destCtx.moveTo(ax + ux, ay + uy);
      destCtx.lineTo(bx + ux, by + uy);
      destCtx.lineTo(bx - ux, by - uy);
      destCtx.lineTo(ax - ux, ay - uy);
      destCtx.closePath();

      if (!hasVert) {
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq > 0.0001 && Math.abs(dx * uy - dy * ux) / (Math.sqrt(lenSq) * halfHeight) < 0.38) {
          hasVert = true;
        }
      }
    }
    destCtx.fill();

    if (hasVert) {
      destCtx.beginPath();
      for (let i = drawStart; i < drawEnd; i++) {
        const ax = denseX[i];
        const ay = denseY[i];
        const bx = denseX[i + 1];
        const by = denseY[i + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq > 0.0001 && Math.abs(dx * uy - dy * ux) / (Math.sqrt(lenSq) * halfHeight) < 0.38) {
          destCtx.moveTo(ax, ay);
          destCtx.lineTo(bx, by);
        }
      }
      destCtx.lineWidth = halfThick * 2.3;
      destCtx.lineCap = 'round';
      destCtx.stroke();
    }
    destCtx.restore();

    if (!Number.isFinite(minX)) return null;
    return cssBoundsToPixelRect(
      { minX: minX - padCss, minY: minY - padCss, maxX: maxX + padCss, maxY: maxY + padCss },
      dprX,
      dprY,
      pw,
      ph
    );
  };

  // Freeze new settled prefix chunks incrementally
  const targetFreezeEnd = totalFiltLen - 9;
  if (
    targetFreezeEnd > session.frozenFiltEnd &&
    (session.frozenFiltEnd === 0 || targetFreezeEnd - session.frozenFiltEnd >= 9)
  ) {
    if (session.frozenFiltEnd === 0) {
      sCtx.save();
      sCtx.setTransform(1, 0, 0, 1, 0, 0);
      sCtx.clearRect(0, 0, pw, ph);
      sCtx.restore();
    }
    const chunkRect = renderChiselSlice(session.frozenCtx, session.frozenFiltEnd, targetFreezeEnd, false);
    if (chunkRect) {
      session.frozenBounds = unionPixelRects(session.frozenBounds, chunkRect);
      sCtx.save();
      sCtx.setTransform(1, 0, 0, 1, 0, 0);
      sCtx.clearRect(chunkRect.x, chunkRect.y, chunkRect.w, chunkRect.h);
      sCtx.drawImage(
        session.frozenCanvas,
        chunkRect.x,
        chunkRect.y,
        chunkRect.w,
        chunkRect.h,
        chunkRect.x,
        chunkRect.y,
        chunkRect.w,
        chunkRect.h
      );
      sCtx.restore();
    }
    session.frozenFiltEnd = targetFreezeEnd;
  }

  if (session.frozenFiltEnd === 0) {
    return renderHighlighterToScratch(scratchCanvas, stroke, tf, dprX, dprY, pw, ph, true);
  }

  // Restore ONLY prevTailRect from frozenCanvas onto scratchCanvas and paint ~9-knot tail
  const prevTail = session.prevTailRect;
  if (prevTail) {
    sCtx.save();
    sCtx.setTransform(1, 0, 0, 1, 0, 0);
    sCtx.clearRect(prevTail.x, prevTail.y, prevTail.w, prevTail.h);
    sCtx.drawImage(
      session.frozenCanvas,
      prevTail.x,
      prevTail.y,
      prevTail.w,
      prevTail.h,
      prevTail.x,
      prevTail.y,
      prevTail.w,
      prevTail.h
    );
    sCtx.restore();
  }

  const nextTailRect = renderChiselSlice(sCtx, session.frozenFiltEnd, totalFiltLen - 1, true);
  session.prevTailRect = nextTailRect;
  return unionPixelRects(session.frozenBounds, nextTailRect);
}

/**
 * Apple PencilKit-inspired Chisel-Tip Highlighter Renderer (High-Performance Studio Materiality).
 * Returns the tight device-pixel `PixelRect` dirtied by this stroke.
 */
export function drawAppleHighlighterStroke(
  destCtx: CanvasRenderingContext2D,
  scratchCanvas: HTMLCanvasElement,
  stroke: AnnotationStroke,
  tf: RenderTransform,
  dprX: number,
  dprY: number = dprX,
  isLiveDraft = false
): PixelRect | null {
  const wPx = destCtx.canvas.width;
  const hPx = destCtx.canvas.height;
  const rect = renderHighlighterToScratch(
    scratchCanvas,
    stroke,
    tf,
    dprX,
    dprY,
    wPx,
    hPx,
    isLiveDraft
  );
  if (!rect) return null;

  destCtx.save();
  destCtx.setTransform(1, 0, 0, 1, 0, 0);
  destCtx.globalCompositeOperation = 'multiply';
  destCtx.globalAlpha = stroke.opacity;
  destCtx.drawImage(scratchCanvas, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
  destCtx.restore();
  return rect;
}

/* ============================================================================
 * UNIVERSAL APPLE PENCILKIT HOLD-TO-SNAP SHAPE & CURVE RECOGNITION ENGINE
 * Recognizes:
 *   1. Straight Lines (with gentle H / V / 45° lock)
 *   2. Closed Shapes: Triangles, Rectangles / Squares / Diamonds, Pentagons / Hexagons,
 *      Circles & Rotated Ellipses (with rigorous geometric error competition!)
 *   3. Pointer Arrows (straight OR smoothly curved shafts!)
 *   4. Smooth Curved Lines / Arches / Curved Underlines (exact least-squares quadratic Bezier)
 *   5. Crisp Open Polylines (L-brackets, V-chevrons, checkmarks, Z-zig-zags)
 *   6. Idealized Smooth Freeform Curves (S-curves, waves, Arabic Mad flourishes)
 * ============================================================================ */

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function polylineLength(pts: Pt2D[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return total;
}

function resamplePolyline(pts: Pt2D[], count: number): Pt2D[] {
  if (pts.length <= 1 || count <= 1) return pts.slice();
  const totalLen = polylineLength(pts);
  if (totalLen < 0.001) return [pts[0]];

  const step = totalLen / (count - 1);
  const out: Pt2D[] = [{ x: pts[0].x, y: pts[0].y }];
  let accum = 0;
  let i = 1;
  let prev = pts[0];

  while (i < pts.length && out.length < count) {
    const curr = pts[i];
    const d = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    if (accum + d >= step && d > 0.0001) {
      const ratio = (step - accum) / d;
      const nx = prev.x + (curr.x - prev.x) * ratio;
      const ny = prev.y + (curr.y - prev.y) * ratio;
      const np = { x: nx, y: ny };
      out.push(np);
      prev = np;
      accum = 0;
    } else {
      accum += d;
      prev = curr;
      i++;
    }
  }

  while (out.length < count) {
    const last = pts[pts.length - 1];
    out.push({ x: last.x, y: last.y });
  }
  return out;
}

function douglasPeucker(pts: Pt2D[], epsilon: number): Pt2D[] {
  if (pts.length <= 2) return pts.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  let maxDist = -1;
  let maxIdx = 0;

  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i].x, pts[i].y, first.x, first.y, last.x, last.y);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(pts.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(pts.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function interiorAngleDeg(prev: Pt2D, curr: Pt2D, next: Pt2D): number {
  const v1x = prev.x - curr.x;
  const v1y = prev.y - curr.y;
  const v2x = next.x - curr.x;
  const v2y = next.y - curr.y;
  const l1 = Math.hypot(v1x, v1y);
  const l2 = Math.hypot(v2x, v2y);
  if (l1 < 0.001 || l2 < 0.001) return 180;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function cleanClosedVertices(rawVerts: Pt2D[], minEdgePx: number): Pt2D[] {
  let verts = rawVerts.slice();
  if (verts.length < 3) return verts;

  // Drop duplicate closing endpoint if present
  if (Math.hypot(verts[0].x - verts[verts.length - 1].x, verts[0].y - verts[verts.length - 1].y) < minEdgePx * 0.7) {
    verts.pop();
  }

  let changed = true;
  let guard = 0;
  while (changed && verts.length > 3 && guard < 12) {
    changed = false;
    guard++;

    // Merge short stub edges
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      if (Math.hypot(b.x - a.x, b.y - a.y) < minEdgePx && verts.length > 3) {
        verts[i] = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
        verts.splice((i + 1) % verts.length, 1);
        changed = true;
        break;
      }
    }
    if (changed) continue;

    // Remove nearly collinear interior vertices (angle > 154 deg)
    for (let i = 0; i < verts.length; i++) {
      const prev = verts[(i - 1 + verts.length) % verts.length];
      const curr = verts[i];
      const next = verts[(i + 1) % verts.length];
      if (interiorAngleDeg(prev, curr, next) > 154 && verts.length > 3) {
        verts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }

  return verts;
}

function measurePolylineFitError(
  samples: Pt2D[],
  vertices: Pt2D[],
  closed: boolean
): { mean: number; max: number } {
  let sum = 0;
  let max = 0;
  const segCount = closed ? vertices.length : vertices.length - 1;
  if (segCount <= 0) return { mean: Infinity, max: Infinity };

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    let best = Infinity;
    for (let j = 0; j < segCount; j++) {
      const a = vertices[j];
      const b = vertices[(j + 1) % vertices.length];
      const d = distToSegment(s.x, s.y, a.x, a.y, b.x, b.y);
      if (d < best) best = d;
    }
    sum += best;
    if (best > max) max = best;
  }
  return { mean: sum / samples.length, max };
}

/**
 * Fits an exact closed-form least-squares quadratic Bezier B(t) = (1-t)^2 P0 + 2(1-t)t C + t^2 P2
 * with endpoints pinned at first & last points.
 */
function fitQuadraticArc(samples: Pt2D[]): {
  p0: Pt2D;
  ctrl: Pt2D;
  p2: Pt2D;
  meanErr: number;
  maxErr: number;
  bow: number;
} {
  const n = samples.length;
  const p0 = samples[0];
  const p2 = samples[n - 1];

  const cumLen = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cumLen[i] = cumLen[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
  }
  const totalLen = Math.max(0.001, cumLen[n - 1]);

  let sumW2 = 0;
  let sumWX = 0;
  let sumWY = 0;

  for (let i = 1; i < n - 1; i++) {
    const t = cumLen[i] / totalLen;
    const inv = 1 - t;
    const w = 2 * inv * t;
    const rx = samples[i].x - inv * inv * p0.x - t * t * p2.x;
    const ry = samples[i].y - inv * inv * p0.y - t * t * p2.y;
    sumW2 += w * w;
    sumWX += w * rx;
    sumWY += w * ry;
  }

  const ctrl: Pt2D =
    sumW2 > 0.0001
      ? { x: sumWX / sumW2, y: sumWY / sumW2 }
      : { x: (p0.x + p2.x) * 0.5, y: (p0.y + p2.y) * 0.5 };

  // Sample fitted curve densely to evaluate true geometric distance error
  const curvePts: Pt2D[] = [];
  const curveSteps = 44;
  for (let i = 0; i <= curveSteps; i++) {
    const t = i / curveSteps;
    const inv = 1 - t;
    curvePts.push({
      x: inv * inv * p0.x + 2 * inv * t * ctrl.x + t * t * p2.x,
      y: inv * inv * p0.y + 2 * inv * t * ctrl.y + t * t * p2.y,
    });
  }

  let errSum = 0;
  let errMax = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    let best = Infinity;
    for (let j = 0; j < curvePts.length - 1; j++) {
      const d = distToSegment(s.x, s.y, curvePts[j].x, curvePts[j].y, curvePts[j + 1].x, curvePts[j + 1].y);
      if (d < best) best = d;
    }
    errSum += best;
    if (best > errMax) errMax = best;
  }

  // Midpoint bow perpendicular to chord P0 -> P2
  const midX = 0.25 * p0.x + 0.5 * ctrl.x + 0.25 * p2.x;
  const midY = 0.25 * p0.y + 0.5 * ctrl.y + 0.25 * p2.y;
  const bow = distToSegment(midX, midY, p0.x, p0.y, p2.x, p2.y);

  return {
    p0,
    ctrl,
    p2,
    meanErr: errSum / n,
    maxErr: errMax,
    bow,
  };
}

/**
 * Regularizes a 4-vertex closed polygon into a razor-sharp Rectangle / Square or Diamond
 * whenever the user's hand-drawn angles clearly intend one.
 */
function regularizeQuad(verts: Pt2D[], samples: Pt2D[]): Pt2D[] {
  const angles = [0, 1, 2, 3].map((i) =>
    interiorAngleDeg(verts[(i + 3) % 4], verts[i], verts[(i + 1) % 4])
  );
  const allNearRight = angles.every((a) => Math.abs(a - 90) <= 26);

  if (allNearRight) {
    // Dominant orientation of the longest edge
    let bestAngle = 0;
    let bestLen = -1;
    for (let i = 0; i < 4; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > bestLen) {
        bestLen = len;
        bestAngle = Math.atan2(b.y - a.y, b.x - a.x);
      }
    }

    // Normalize orientation modulo 90° and snap gently to pure H/V (within 11°) or 45° (within 8°)
    let deg = ((bestAngle * 180) / Math.PI) % 90;
    if (deg < -45) deg += 90;
    if (deg > 45) deg -= 90;
    if (Math.abs(deg) <= 11) {
      deg = 0;
    } else if (Math.abs(Math.abs(deg) - 45) <= 8) {
      deg = deg > 0 ? 45 : -45;
    }
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of samples) {
      const u = p.x * cos + p.y * sin;
      const v = -p.x * sin + p.y * cos;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    let w = maxU - minU;
    let h = maxV - minV;
    const cu = (minU + maxU) * 0.5;
    const cv = (minV + maxV) * 0.5;

    // Snap near-squares to exact visual square
    if (Math.abs(w - h) / Math.max(w, h) < 0.14) {
      const side = (w + h) * 0.5;
      w = side;
      h = side;
    }

    const hw = w * 0.5;
    const hh = h * 0.5;
    const localCorners: Pt2D[] = [
      { x: cu - hw, y: cv - hh },
      { x: cu + hw, y: cv - hh },
      { x: cu + hw, y: cv + hh },
      { x: cu - hw, y: cv + hh },
    ];
    return localCorners.map((c) => ({
      x: c.x * cos - c.y * sin,
      y: c.x * sin + c.y * cos,
    }));
  }

  // Check for clean Diamond / Rhombus (nearly perpendicular diagonals aligned H/V)
  const d1x = verts[2].x - verts[0].x;
  const d1y = verts[2].y - verts[0].y;
  const d2x = verts[3].x - verts[1].x;
  const d2y = verts[3].y - verts[1].y;
  const l1 = Math.hypot(d1x, d1y);
  const l2 = Math.hypot(d2x, d2y);
  if (l1 > 12 && l2 > 12) {
    const diagDot = Math.abs((d1x * d2x + d1y * d2y) / (l1 * l2));
    if (diagDot < 0.24) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of samples) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const cx = (minX + maxX) * 0.5;
      const cy = (minY + maxY) * 0.5;
      const cand: Pt2D[] = [
        { x: cx, y: minY },
        { x: maxX, y: cy },
        { x: cx, y: maxY },
        { x: minX, y: cy },
      ];
      const rawErr = measurePolylineFitError(samples, verts, true).mean;
      const diaErr = measurePolylineFitError(samples, cand, true).mean;
      if (diaErr <= rawErr * 1.25) {
        return cand;
      }
    }
  }

  return verts;
}

/**
 * Gently levels near-horizontal or near-vertical edges on a triangle while keeping its visual shape.
 */
function regularizeTriangle(verts: Pt2D[]): Pt2D[] {
  const out = verts.map((v) => ({ ...v }));
  for (let i = 0; i < 3; i++) {
    const a = out[i];
    const b = out[(i + 1) % 3];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 10) continue;
    const deg = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
    if (deg <= 6.5 || Math.abs(deg - 180) <= 6.5) {
      const avgY = (a.y + b.y) * 0.5;
      a.y = avgY;
      b.y = avgY;
      break;
    }
    if (Math.abs(deg - 90) <= 6.5) {
      const avgX = (a.x + b.x) * 0.5;
      a.x = avgX;
      b.x = avgX;
      break;
    }
  }
  return out;
}

function buildArrowWings(
  tip: Pt2D,
  inTangentX: number,
  inTangentY: number,
  headLen: number
): { left: Pt2D; right: Pt2D } {
  const len = Math.hypot(inTangentX, inTangentY) || 1;
  const ux = inTangentX / len;
  const uy = inTangentY / len;
  const wingAngle = (27 * Math.PI) / 180;
  const cos = Math.cos(wingAngle);
  const sin = Math.sin(wingAngle);
  // Reverse direction pointing backward along incoming shaft
  const rx = -ux;
  const ry = -uy;
  return {
    left: {
      x: tip.x + (rx * cos - ry * sin) * headLen,
      y: tip.y + (rx * sin + ry * cos) * headLen,
    },
    right: {
      x: tip.x + (rx * cos + ry * sin) * headLen,
      y: tip.y + (-rx * sin + ry * cos) * headLen,
    },
  };
}

/**
 * Universal Apple PencilKit "Hold to Snap" recognizer.
 * Reacts intelligently to ANY drawn gesture when the user pauses briefly at stroke end:
 * - Straight lines (with clean H/V/45° lock)
 * - Smooth curved lines & arches ("سطر منحني")
 * - Triangles, Rectangles, Squares, Diamonds, Pentagons & Hexagons
 * - Circles & rotated Ellipses
 * - Straight or curved pointer Arrows
 * - Crisp open Polylines (L/V/U brackets, checkmarks)
 * - Idealized smooth freeform curves (S-curves / waves / calligraphic flourishes)
 */
export function detectHoldShape(
  points: AnnotationPoint[],
  scaleX: number,
  scaleY: number,
  allowComplexShapes: boolean
): AnnotationShape | null {
  if (points.length < 4 || scaleX <= 0 || scaleY <= 0) return null;

  const rawPts: Pt2D[] = points.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));
  const first = rawPts[0];
  const last = rawPts[rawPts.length - 1];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < rawPts.length; i++) {
    const p = rawPts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const pathLen = polylineLength(rawPts);
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const diag = Math.hypot(bboxW, bboxH);
  const directDist = Math.hypot(last.x - first.x, last.y - first.y);

  if (pathLen < 24 || diag < 14) return null;

  const toNorm = (p: Pt2D): Pt2D => ({ x: p.x / scaleX, y: p.y / scaleY });

  // -------------------------------------------------------------------------
  // 1. STRAIGHT LINE (strict enough that intentional gentle curves become arcs!)
  // -------------------------------------------------------------------------
  if (directDist >= 22 && pathLen <= directDist * 1.15) {
    let maxDev = 0;
    for (let i = 1; i < rawPts.length - 1; i++) {
      const dev = distToSegment(rawPts[i].x, rawPts[i].y, first.x, first.y, last.x, last.y);
      if (dev > maxDev) maxDev = dev;
    }

    const allowedLineDev = Math.max(7.2, directDist * 0.055);
    if (maxDev <= allowedLineDev) {
      let x2Px = last.x;
      let y2Px = last.y;
      const angleDeg = Math.abs((Math.atan2(last.y - first.y, last.x - first.x) * 180) / Math.PI);
      if (angleDeg <= 4.5 || Math.abs(angleDeg - 180) <= 4.5) {
        y2Px = first.y;
      } else if (Math.abs(angleDeg - 90) <= 4.5) {
        x2Px = first.x;
      } else if (Math.abs(angleDeg - 45) <= 2.8 || Math.abs(angleDeg - 135) <= 2.8) {
        const signX = last.x >= first.x ? 1 : -1;
        const signY = last.y >= first.y ? 1 : -1;
        const proj = (Math.abs(last.x - first.x) + Math.abs(last.y - first.y)) * 0.5;
        x2Px = first.x + signX * proj;
        y2Px = first.y + signY * proj;
      }
      return {
        type: 'line',
        x1: first.x / scaleX,
        y1: first.y / scaleY,
        x2: x2Px / scaleX,
        y2: y2Px / scaleY,
      };
    }
  }

  const uniform = resamplePolyline(rawPts, 72);

  // -------------------------------------------------------------------------
  // 2. CLOSED SHAPES COMPETITION: Triangle / Rectangle / Square / Diamond /
  //    Pentagon / Hexagon  vs  Circle / Rotated Ellipse
  // -------------------------------------------------------------------------
  let closedContour: Pt2D[] | null = null;
  if (bboxW >= 16 && bboxH >= 16) {
    const closeThreshold = Math.max(36, Math.min(diag * 0.44, pathLen * 0.25));
    if (directDist <= closeThreshold && pathLen >= diag * 2.15) {
      closedContour = uniform;
    } else if (pathLen >= diag * 2.4) {
      // Handle natural slight overlap past the start point on hand-drawn circles/triangles
      const startSliceEnd = Math.floor(uniform.length * 0.22);
      const endSliceStart = Math.floor(uniform.length * 0.78);
      let bestGap = Infinity;
      let bestStart = 0;
      let bestEnd = uniform.length - 1;
      for (let i = 0; i <= startSliceEnd; i++) {
        for (let j = endSliceStart; j < uniform.length; j++) {
          const g = Math.hypot(uniform[j].x - uniform[i].x, uniform[j].y - uniform[i].y);
          if (g < bestGap) {
            bestGap = g;
            bestStart = i;
            bestEnd = j;
          }
        }
      }
      if (bestGap <= Math.max(22, diag * 0.19) && bestEnd - bestStart >= uniform.length * 0.65) {
        closedContour = resamplePolyline(uniform.slice(bestStart, bestEnd + 1), 72);
      }
    }
  }

  if (closedContour) {
    const avgRadius = Math.max(12, (bboxW + bboxH) * 0.25);

    // ---- Candidate A: Circle / Rotated Ellipse ----
    let meanX = 0;
    let meanY = 0;
    for (const p of closedContour) {
      meanX += p.x;
      meanY += p.y;
    }
    meanX /= closedContour.length;
    meanY /= closedContour.length;

    let cxx = 0;
    let cyy = 0;
    let cxy = 0;
    for (const p of closedContour) {
      const dx = p.x - meanX;
      const dy = p.y - meanY;
      cxx += dx * dx;
      cyy += dy * dy;
      cxy += dx * dy;
    }
    let theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const thetaDeg = ((theta * 180) / Math.PI + 180) % 90;
    if (thetaDeg <= 14 || thetaDeg >= 76) {
      theta = 0;
    }
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of closedContour) {
      const dx = p.x - meanX;
      const dy = p.y - meanY;
      const u = dx * cosT + dy * sinT;
      const v = -dx * sinT + dy * cosT;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    let rxPx = (maxU - minU) * 0.5;
    let ryPx = (maxV - minV) * 0.5;
    const shiftU = (minU + maxU) * 0.5;
    const shiftV = (minV + maxV) * 0.5;
    const cxPx = meanX + shiftU * cosT - shiftV * sinT;
    const cyPx = meanY + shiftU * sinT + shiftV * cosT;

    if (rxPx >= 10 && ryPx >= 10 && Math.abs(rxPx - ryPx) / Math.max(rxPx, ryPx) < 0.16) {
      const avg = (rxPx + ryPx) * 0.5;
      rxPx = avg;
      ryPx = avg;
      theta = 0;
    }

    let ellipseValid = false;
    let ellipseScore = Infinity;
    if (rxPx >= 10 && ryPx >= 10) {
      const cosE = Math.cos(theta);
      const sinE = Math.sin(theta);
      let errSum = 0;
      let errMax = 0;
      for (const p of closedContour) {
        const dx = p.x - cxPx;
        const dy = p.y - cyPx;
        const lx = dx * cosE + dy * sinE;
        const ly = -dx * sinE + dy * cosE;
        const ang = Math.atan2(ly / ryPx, lx / rxPx);
        const ex = Math.cos(ang) * rxPx;
        const ey = Math.sin(ang) * ryPx;
        const d = Math.hypot(lx - ex, ly - ey) / avgRadius;
        errSum += d;
        if (d > errMax) errMax = d;
      }
      const meanErr = errSum / closedContour.length;
      if (meanErr <= 0.175 && errMax <= 0.38) {
        ellipseValid = true;
        ellipseScore = meanErr + 0.35 * errMax;
      }
    }

    // ---- Candidate B: Closed Polygon (Triangle 3, Rect/Square/Diamond 4, Pentagon 5, Hexagon 6) ----
    let polyValid = false;
    let polyScore = Infinity;
    let polyVerts: Pt2D[] = [];

    // Find a true extreme corner via 2-pass farthest-point anchor so DP never splits an edge at the seam
    let idxA = 0;
    let bestDA = -1;
    for (let i = 0; i < closedContour.length; i++) {
      const d = Math.hypot(closedContour[i].x - meanX, closedContour[i].y - meanY);
      if (d > bestDA) {
        bestDA = d;
        idxA = i;
      }
    }
    let idxB = idxA;
    let bestDB = -1;
    for (let i = 0; i < closedContour.length; i++) {
      const d = Math.hypot(closedContour[i].x - closedContour[idxA].x, closedContour[i].y - closedContour[idxA].y);
      if (d > bestDB) {
        bestDB = d;
        idxB = i;
      }
    }

    // Split loop cleanly into two halves (idxA -> idxB and idxB -> idxA) and simplify each half
    const rotated = closedContour.slice(idxA).concat(closedContour.slice(0, idxA));
    const splitPos = (idxB - idxA + closedContour.length) % closedContour.length;
    const half1 = rotated.slice(0, splitPos + 1);
    const half2 = rotated.slice(splitPos).concat([rotated[0]]);

    const epsMultipliers = [0.068, 0.09, 0.115];
    for (const mult of epsMultipliers) {
      const eps = Math.max(7.5, diag * mult);
      const v1 = douglasPeucker(half1, eps);
      const v2 = douglasPeucker(half2, eps);
      const merged = v1.slice(0, -1).concat(v2.slice(0, -1));
      const cleaned = cleanClosedVertices(merged, Math.max(13, diag * 0.13));

      if (cleaned.length >= 3 && cleaned.length <= 6) {
        let candidateVerts = cleaned;
        if (cleaned.length === 3) {
          candidateVerts = regularizeTriangle(cleaned);
        } else if (cleaned.length === 4) {
          candidateVerts = regularizeQuad(cleaned, closedContour);
        }

        const fit = measurePolylineFitError(closedContour, candidateVerts, true);
        const normMean = fit.mean / avgRadius;
        const normMax = fit.max / avgRadius;
        const score = normMean + 0.35 * normMax;

        if (normMean <= 0.16 && normMax <= 0.35 && score < polyScore) {
          polyValid = true;
          polyScore = score;
          polyVerts = candidateVerts;
        }
      }
    }

    // Decide cleanly between Polygon & Ellipse
    const choosePolygon =
      polyValid &&
      (polyVerts.length <= 4
        ? !ellipseValid || polyScore <= ellipseScore * 1.15
        : !ellipseValid || polyScore < ellipseScore * 0.76);

    if (choosePolygon) {
      return {
        type: 'polygon',
        points: polyVerts.map(toNorm),
        closed: true,
      };
    }

    if (ellipseValid) {
      const isRotated = Math.abs(theta) > 0.001;
      const avgScale = (scaleX + scaleY) * 0.5;
      return {
        type: 'ellipse',
        cx: cxPx / scaleX,
        cy: cyPx / scaleY,
        rx: isRotated ? rxPx / avgScale : rxPx / scaleX,
        ry: isRotated ? ryPx / avgScale : ryPx / scaleY,
        rotation: isRotated ? theta : undefined,
      };
    }
  }

  // -------------------------------------------------------------------------
  // 3. POINTER ARROW (straight OR smoothly curved shaft + crisp arrowhead hook)
  // -------------------------------------------------------------------------
  if (allowComplexShapes && pathLen >= 42) {
    const n = uniform.length;
    const minTipIdx = Math.floor(n * 0.56);
    const maxTipIdx = Math.floor(n * 0.91);
    let sharpTipIdx = -1;
    let sharpestAngle = 82; // interior angle <= 82° means a sharp reversal hook (>= 98° turn)

    for (let i = minTipIdx; i <= maxTipIdx; i++) {
      const prev = uniform[Math.max(0, i - 3)];
      const curr = uniform[i];
      const next = uniform[Math.min(n - 1, i + 3)];
      const ang = interiorAngleDeg(prev, curr, next);
      if (ang < sharpestAngle) {
        sharpestAngle = ang;
        sharpTipIdx = i;
      }
    }

    if (sharpTipIdx !== -1) {
      const shaftPts = uniform.slice(0, sharpTipIdx + 1);
      const hookPts = uniform.slice(sharpTipIdx);
      const shaftLen = polylineLength(shaftPts);
      const hookLen = polylineLength(hookPts);
      const tip = uniform[sharpTipIdx];

      if (
        shaftLen >= 30 &&
        hookLen >= 9 &&
        hookLen <= Math.min(62, shaftLen * 0.48)
      ) {
        // Test if shaft is a clean straight line
        const shaftDirect = Math.hypot(tip.x - first.x, tip.y - first.y);
        let shaftMaxLineDev = 0;
        for (let i = 1; i < shaftPts.length - 1; i++) {
          const d = distToSegment(shaftPts[i].x, shaftPts[i].y, first.x, first.y, tip.x, tip.y);
          if (d > shaftMaxLineDev) shaftMaxLineDev = d;
        }

        const headLen = Math.max(11, Math.min(24, hookLen * 0.85));

        if (shaftDirect >= 28 && shaftMaxLineDev <= Math.max(8, shaftDirect * 0.065)) {
          let tipX = tip.x;
          let tipY = tip.y;
          const deg = Math.abs((Math.atan2(tip.y - first.y, tip.x - first.x) * 180) / Math.PI);
          if (deg <= 4.5 || Math.abs(deg - 180) <= 4.5) tipY = first.y;
          else if (Math.abs(deg - 90) <= 4.5) tipX = first.x;
          const adjTip = { x: tipX, y: tipY };
          const wings = buildArrowWings(adjTip, tipX - first.x, tipY - first.y, headLen);
          return {
            type: 'arrow',
            x1: first.x / scaleX,
            y1: first.y / scaleY,
            x2: adjTip.x / scaleX,
            y2: adjTip.y / scaleY,
            leftX: wings.left.x / scaleX,
            leftY: wings.left.y / scaleY,
            rightX: wings.right.x / scaleX,
            rightY: wings.right.y / scaleY,
          };
        }

        // Test if shaft is a clean smooth curved arrow!
        const shaftArc = fitQuadraticArc(shaftPts);
        if (
          shaftArc.maxErr <= Math.max(13, shaftLen * 0.08) &&
          shaftArc.meanErr <= Math.max(6, shaftLen * 0.035)
        ) {
          // Incoming tangent at quadratic Bezier endpoint P2 is along (P2 - ctrl)
          const wings = buildArrowWings(
            tip,
            tip.x - shaftArc.ctrl.x,
            tip.y - shaftArc.ctrl.y,
            headLen
          );
          return {
            type: 'arrow',
            x1: first.x / scaleX,
            y1: first.y / scaleY,
            cx: shaftArc.ctrl.x / scaleX,
            cy: shaftArc.ctrl.y / scaleY,
            x2: tip.x / scaleX,
            y2: tip.y / scaleY,
            leftX: wings.left.x / scaleX,
            leftY: wings.left.y / scaleY,
            rightX: wings.right.x / scaleX,
            rightY: wings.right.y / scaleY,
          };
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. OPEN SHAPES: Smooth Curved Arc ("سطر منحني") vs Crisp Open Polyline (L / V / U)
  // -------------------------------------------------------------------------
  const arcFit = fitQuadraticArc(uniform);
  const openDp = douglasPeucker(uniform, Math.max(7.5, diag * 0.065));

  // Merge nearly collinear open vertices (> 156°)
  const openVerts: Pt2D[] = [openDp[0]];
  for (let i = 1; i < openDp.length - 1; i++) {
    const prev = openVerts[openVerts.length - 1];
    const curr = openDp[i];
    const next = openDp[i + 1];
    if (interiorAngleDeg(prev, curr, next) <= 156) {
      openVerts.push(curr);
    }
  }
  openVerts.push(openDp[openDp.length - 1]);

  let openPolyValid = false;
  let openPolyMean = Infinity;
  if (openVerts.length >= 3 && openVerts.length <= 5) {
    // Must contain at least one clearly intentional sharp corner (<= 128°)
    let minCorner = 180;
    for (let i = 1; i < openVerts.length - 1; i++) {
      const ang = interiorAngleDeg(openVerts[i - 1], openVerts[i], openVerts[i + 1]);
      if (ang < minCorner) minCorner = ang;
    }
    const fit = measurePolylineFitError(uniform, openVerts, false);
    if (
      minCorner <= 128 &&
      fit.mean <= Math.max(6, pathLen * 0.03) &&
      fit.max <= Math.max(12, pathLen * 0.068)
    ) {
      openPolyValid = true;
      openPolyMean = fit.mean;
    }
  }

  const arcValid =
    arcFit.meanErr <= Math.max(7.5, pathLen * 0.04) &&
    arcFit.maxErr <= Math.max(17, pathLen * 0.095) &&
    arcFit.bow >= Math.max(5, directDist * 0.04);

  // Sharp cornered open polyline (e.g. L-bracket, V-chevron, checkmark, square bracket) beats arc when clearly angular
  if (openPolyValid && (!arcValid || openPolyMean < arcFit.meanErr * 0.74)) {
    const leveled = openVerts.map((v) => ({ ...v }));
    for (let i = 0; i < leveled.length - 1; i++) {
      const a = leveled[i];
      const b = leveled[i + 1];
      const deg = Math.abs((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
      if (deg <= 5.5 || Math.abs(deg - 180) <= 5.5) {
        b.y = a.y;
      } else if (Math.abs(deg - 90) <= 5.5) {
        b.x = a.x;
      }
    }
    return {
      type: 'polygon',
      points: leveled.map(toNorm),
      closed: false,
    };
  }

  // Smooth Curved Arc / Arch / Curved Underline ("سطر منحني")
  if (arcValid) {
    let p0 = { ...arcFit.p0 };
    let p2 = { ...arcFit.p2 };
    let ctrl = { ...arcFit.ctrl };

    // Gently level nearly horizontal or nearly vertical curved arches for calligraphic beauty
    if (directDist >= 26) {
      const dy = Math.abs(p2.y - p0.y);
      const dx = Math.abs(p2.x - p0.x);
      if (dy <= directDist * 0.075) {
        const avgY = (p0.y + p2.y) * 0.5;
        p0.y = avgY;
        p2.y = avgY;
        const midX = (p0.x + p2.x) * 0.5;
        if (Math.abs(ctrl.x - midX) <= dx * 0.13) {
          ctrl.x = midX;
        }
      } else if (dx <= directDist * 0.075) {
        const avgX = (p0.x + p2.x) * 0.5;
        p0.x = avgX;
        p2.x = avgX;
        const midY = (p0.y + p2.y) * 0.5;
        if (Math.abs(ctrl.y - midY) <= dy * 0.13) {
          ctrl.y = midY;
        }
      }
    }

    return {
      type: 'arc',
      x1: p0.x / scaleX,
      y1: p0.y / scaleY,
      cx: ctrl.x / scaleX,
      cy: ctrl.y / scaleY,
      x2: p2.x / scaleX,
      y2: p2.y / scaleY,
    };
  }

  // -------------------------------------------------------------------------
  // 5. UNIVERSAL IDEALIZED SMOOTH CURVE (S-curves, waves, Arabic Mad '~', flourishes)
  // -------------------------------------------------------------------------
  if (pathLen >= 34) {
    let cur = resamplePolyline(rawPts, 32);
    for (let pass = 0; pass < 7; pass++) {
      const next: Pt2D[] = new Array(cur.length);
      next[0] = cur[0];
      next[cur.length - 1] = cur[cur.length - 1];
      for (let i = 1; i < cur.length - 1; i++) {
        next[i] = {
          x: 0.25 * cur[i - 1].x + 0.5 * cur[i].x + 0.25 * cur[i + 1].x,
          y: 0.25 * cur[i - 1].y + 0.5 * cur[i].y + 0.25 * cur[i + 1].y,
        };
      }
      cur = next;
    }
    const knots = douglasPeucker(cur, Math.max(3.4, pathLen * 0.017));
    if (knots.length >= 3) {
      return {
        type: 'curve',
        points: knots.map(toNorm),
      };
    }
  }

  return null;
}

export interface SnapDragBase {
  shape: AnnotationShape;
  anchorX: number;
  anchorY: number;
}

function normalizeAngleRad(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function isAxisAlignedRect(points: ReadonlyArray<{ x: number; y: number }>, scaleX: number, scaleY: number): boolean {
  if (points.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    const dx = Math.abs((b.x - a.x) * scaleX);
    const dy = Math.abs((b.y - a.y) * scaleY);
    const len = Math.hypot(dx, dy);
    if (len < 4) return false;
    const minor = Math.min(dx, dy);
    if (minor / len > 0.06) return false;
  }
  return true;
}

function applyRopeFalloffPoints(
  points: ReadonlyArray<{ x: number; y: number }>,
  anchorX: number,
  anchorY: number,
  targetX: number,
  targetY: number,
  scaleX: number,
  scaleY: number
): Array<{ x: number; y: number }> {
  const n = points.length;
  if (n < 2) return points.map((p) => ({ x: p.x, y: p.y }));

  // Compute cumulative arc length in screen pixels for smooth rope parameterization
  const cumLen = new Float64Array(n);
  let totalLen = 0;
  for (let i = 1; i < n; i++) {
    const dx = (points[i].x - points[i - 1].x) * scaleX;
    const dy = (points[i].y - points[i - 1].y) * scaleY;
    totalLen += Math.hypot(dx, dy);
    cumLen[i] = totalLen;
  }

  const p0x = points[0].x;
  const p0y = points[0].y;
  const p0PxX = p0x * scaleX;
  const p0PxY = p0y * scaleY;

  const oldDx = (anchorX - p0x) * scaleX;
  const oldDy = (anchorY - p0y) * scaleY;
  const oldChordLen = Math.hypot(oldDx, oldDy);

  const newDx = (targetX - p0x) * scaleX;
  const newDy = (targetY - p0y) * scaleY;
  const newChordLen = Math.hypot(newDx, newDy);

  // Measure compression vs chord to add natural rope slack belly when pushed inward
  let slackPxX = 0;
  let slackPxY = 0;
  if (oldChordLen >= 10 && newChordLen < oldChordLen) {
    const compression = Math.min(oldChordLen * 0.65, oldChordLen - newChordLen);
    let signedArea = 0;
    const invChord = 1 / oldChordLen;
    const ux = oldDx * invChord;
    const uy = oldDy * invChord;
    for (let i = 1; i < n - 1; i++) {
      const rx = (points[i].x - p0x) * scaleX;
      const ry = (points[i].y - p0y) * scaleY;
      signedArea += ux * ry - uy * rx;
    }
    const side = signedArea >= 0 ? 1 : -1;
    const dirLen = Math.max(4, newChordLen);
    const nx = (-newDy / dirLen) * side;
    const ny = (newDx / dirLen) * side;
    const slackMag = compression * 0.34;
    slackPxX = nx * slackMag;
    slackPxY = ny * slackMag;
  }

  const out: Array<{ x: number; y: number }> = new Array(n);
  out[0] = { x: p0x, y: p0y };

  // Progressive polar-rope bending: keeps wave/curve ripples perpendicular when swung 90°-180°
  if (oldChordLen >= 10 && newChordLen >= 4) {
    const dAngle = normalizeAngleRad(Math.atan2(newDy, newDx) - Math.atan2(oldDy, oldDx));
    const lenRatio = newChordLen / oldChordLen;

    // Account for tiny snap-anchor vs last-vertex difference so endpoint lands bit-exact on pen
    const lastPt = points[n - 1];
    const ldx = lastPt.x * scaleX - p0PxX;
    const ldy = lastPt.y * scaleY - p0PxY;
    const cosF = Math.cos(dAngle);
    const sinF = Math.sin(dAngle);
    const rotTipX = p0PxX + (ldx * cosF - ldy * sinF) * lenRatio;
    const rotTipY = p0PxY + (ldx * sinF + ldy * cosF) * lenRatio;
    const tipErrX = targetX * scaleX - rotTipX;
    const tipErrY = targetY * scaleY - rotTipY;

    for (let i = 1; i < n - 1; i++) {
      const u = totalLen > 1 ? cumLen[i] / totalLen : i / (n - 1);
      const smooth = u * u * (3 - 2 * u);
      const w = 0.25 * u + 0.75 * smooth;
      const ang = dAngle * w;
      const rScale = 1 + (lenRatio - 1) * w;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      const px = points[i].x * scaleX - p0PxX;
      const py = points[i].y * scaleY - p0PxY;
      const belly = Math.sin(Math.PI * u);

      const finalPxX = p0PxX + (px * cos - py * sin) * rScale + tipErrX * w + slackPxX * belly;
      const finalPxY = p0PxY + (px * sin + py * cos) * rScale + tipErrY * w + slackPxY * belly;
      out[i] = { x: finalPxX / scaleX, y: finalPxY / scaleY };
    }
    out[n - 1] = { x: targetX, y: targetY };
    return out;
  }

  // Fallback for looped strokes whose start & end meet near the same point
  const dispX = targetX - anchorX;
  const dispY = targetY - anchorY;
  for (let i = 1; i < n - 1; i++) {
    const u = totalLen > 1 ? cumLen[i] / totalLen : i / (n - 1);
    const smooth = u * u * (3 - 2 * u);
    const w = 0.22 * u + 0.78 * smooth;
    const belly = Math.sin(Math.PI * u);
    out[i] = {
      x: points[i].x + dispX * w + (slackPxX * belly) / scaleX,
      y: points[i].y + dispY * w + (slackPxY * belly) / scaleY,
    };
  }
  out[n - 1] = {
    x: targetX,
    y: targetY,
  };
  return out;
}

/**
 * Returns the CSS-pixel coordinates of the anchored pivot point while dragging a snapped shape,
 * so a subtle live pin indicator can show where the rope/shape is anchored.
 */
export function getSnappedShapePinPoint(
  shape: AnnotationShape,
  base: SnapDragBase | null | undefined,
  tf: RenderTransform
): { x: number; y: number } | null {
  if (shape.type === 'line' || shape.type === 'arc' || shape.type === 'arrow') {
    return { x: shape.x1 * tf.scaleX + tf.offsetX, y: shape.y1 * tf.scaleY + tf.offsetY };
  }
  if ((shape.type === 'curve' || (shape.type === 'polygon' && !shape.closed)) && shape.points.length >= 2) {
    return {
      x: shape.points[0].x * tf.scaleX + tf.offsetX,
      y: shape.points[0].y * tf.scaleY + tf.offsetY,
    };
  }
  if (shape.type === 'polygon' && shape.closed && shape.points.length >= 3) {
    const src = base?.shape.type === 'polygon' ? base.shape : shape;
    const ax = base ? base.anchorX : src.points[0].x;
    const ay = base ? base.anchorY : src.points[0].y;
    let grabIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < src.points.length; i++) {
      const d = Math.hypot((src.points[i].x - ax) * tf.scaleX, (src.points[i].y - ay) * tf.scaleY);
      if (d < bestD) {
        bestD = d;
        grabIdx = i;
      }
    }
    let oppIdx = 0;
    let maxOppD = -1;
    if (isAxisAlignedRect(src.points, tf.scaleX, tf.scaleY)) {
      oppIdx = (grabIdx + 2) % 4;
    } else {
      for (let i = 0; i < src.points.length; i++) {
        const d = Math.hypot(
          (src.points[i].x - src.points[grabIdx].x) * tf.scaleX,
          (src.points[i].y - src.points[grabIdx].y) * tf.scaleY
        );
        if (d > maxOppD) {
          maxOppD = d;
          oppIdx = i;
        }
      }
    }
    return {
      x: src.points[oppIdx].x * tf.scaleX + tf.offsetX,
      y: src.points[oppIdx].y * tf.scaleY + tf.offsetY,
    };
  }
  if (shape.type === 'ellipse' && base?.shape.type === 'ellipse') {
    const cxPx = base.shape.cx * tf.scaleX + tf.offsetX;
    const cyPx = base.shape.cy * tf.scaleY + tf.offsetY;
    const axPx = base.anchorX * tf.scaleX + tf.offsetX;
    const ayPx = base.anchorY * tf.scaleY + tf.offsetY;
    if (Math.hypot(axPx - cxPx, ayPx - cyPx) >= 6) {
      return { x: cxPx * 2 - axPx, y: cyPx * 2 - ayPx };
    }
    return { x: cxPx, y: cyPx };
  }
  return null;
}

/**
 * Live post-snap shape adjustment while the user keeps pressing & dragging after Hold-to-Snap.
 * Keeps every shape fluid and elastic ("like a loose rope / rubber band") pinned to the pen:
 * - Curves, open polylines, and curved arcs/arrows drape and bend smoothly like a rope.
 * - Circles/ellipses squash, elongate, and swing freely around the opposite pinned edge.
 * - Rectangles stretch width/height independently; triangles & polygons flex elastically from the grabbed corner.
 * - Lines swing freely 360° with minimal H/V friction.
 */
export function adjustSnappedShapeOnDrag(
  shape: AnnotationShape,
  rawPt: AnnotationPoint,
  scaleX: number,
  scaleY: number,
  base?: SnapDragBase | null
): AnnotationShape {
  if (scaleX <= 0 || scaleY <= 0) return shape;

  if (shape.type === 'line') {
    const src = base?.shape.type === 'line' ? base.shape : shape;
    let x2 = rawPt.x;
    let y2 = rawPt.y;
    const angleDeg = Math.abs(
      (Math.atan2((y2 - src.y1) * scaleY, (x2 - src.x1) * scaleX) * 180) / Math.PI
    );
    // Light 1.8 deg detent only so the line feels fluid and unrestricted like a string
    if (angleDeg < 1.8 || Math.abs(angleDeg - 180) < 1.8) {
      y2 = src.y1;
    } else if (Math.abs(angleDeg - 90) < 1.8) {
      x2 = src.x1;
    }
    return { ...src, x2, y2 };
  }

  if (shape.type === 'arc') {
    const src = base?.shape.type === 'arc' ? base.shape : shape;
    const p0x = src.x1 * scaleX;
    const p0y = src.y1 * scaleY;
    const oldEndX = src.x2 * scaleX;
    const oldEndY = src.y2 * scaleY;
    const newEndX = rawPt.x * scaleX;
    const newEndY = rawPt.y * scaleY;

    const oldDx = oldEndX - p0x;
    const oldDy = oldEndY - p0y;
    const oldLen = Math.hypot(oldDx, oldDy);
    const newDx = newEndX - p0x;
    const newDy = newEndY - p0y;
    const newLen = Math.hypot(newDx, newDy);
    if (oldLen < 2.5 || newLen < 2.5) return shape;

    // Decompose control point into chord-aligned (t) and perpendicular rope bow (bow)
    const oldMidX = (p0x + oldEndX) * 0.5;
    const oldMidY = (p0y + oldEndY) * 0.5;
    const cdx = src.cx * scaleX - oldMidX;
    const cdy = src.cy * scaleY - oldMidY;
    const oldUx = oldDx / oldLen;
    const oldUy = oldDy / oldLen;
    const parallelFrac = (cdx * oldUx + cdy * oldUy) / oldLen;
    const perpBow = -cdx * oldUy + cdy * oldUx;

    const newMidX = (p0x + newEndX) * 0.5;
    const newMidY = (p0y + newEndY) * 0.5;
    const newUx = newDx / newLen;
    const newUy = newDy / newLen;
    // Elastic bow: retains natural bend when pushed inward (slack rope) & tightens gracefully when pulled taut
    const lenRatio = Math.max(0.25, Math.min(2.6, newLen / oldLen));
    const elasticBow = perpBow * (0.65 + 0.35 * lenRatio);
    const ncx = newMidX + newUx * (parallelFrac * newLen) - newUy * elasticBow;
    const ncy = newMidY + newUy * (parallelFrac * newLen) + newUx * elasticBow;

    return {
      ...src,
      cx: ncx / scaleX,
      cy: ncy / scaleY,
      x2: rawPt.x,
      y2: rawPt.y,
    };
  }

  if (shape.type === 'ellipse') {
    const src = base?.shape.type === 'ellipse' ? base.shape : shape;
    const cxPx = src.cx * scaleX;
    const cyPx = src.cy * scaleY;
    const isRotated = Boolean(src.rotation && Math.abs(src.rotation) > 0.001);
    const avgScale = (scaleX + scaleY) * 0.5;
    const baseRxPx = isRotated ? src.rx * avgScale : src.rx * scaleX;
    const baseRyPx = isRotated ? src.ry * avgScale : src.ry * scaleY;

    const px = rawPt.x * scaleX;
    const py = rawPt.y * scaleY;

    if (base) {
      const ax = base.anchorX * scaleX - cxPx;
      const ay = base.anchorY * scaleY - cyPx;
      const r0 = Math.hypot(ax, ay);
      if (r0 >= 6) {
        // Elastic lasso: far opposite side stays pinned while your pen pulls, squashes, elongates & pivots
        const oppX = cxPx - ax;
        const oppY = cyPx - ay;
        const vx = px - oppX;
        const vy = py - oppY;
        const vLen = Math.max(10, Math.hypot(vx, vy));
        const newCxPx = oppX + vx * 0.5;
        const newCyPx = oppY + vy * 0.5;
        const stretchScale = Math.max(0.16, Math.min(6, (vLen * 0.5) / r0));
        const crossScale = Math.max(0.45, Math.min(2.2, 0.72 + 0.28 * stretchScale));

        const isCircle = Math.abs(baseRxPx - baseRyPx) <= 1.5;
        let nextRxPx: number;
        let nextRyPx: number;
        let nextRot: number | undefined;

        if (isCircle) {
          nextRxPx = Math.max(5, baseRxPx * stretchScale);
          nextRyPx = Math.max(5, baseRyPx * crossScale);
          nextRot = Math.abs(nextRxPx - nextRyPx) > 1.2 ? Math.atan2(vy, vx) : undefined;
        } else {
          const rot0 = src.rotation ?? 0;
          const cos0 = Math.cos(-rot0);
          const sin0 = Math.sin(-rot0);
          const locX = ax * cos0 - ay * sin0;
          const locY = ax * sin0 + ay * cos0;
          const pullAlongMajor = Math.abs(locX / Math.max(1, baseRxPx)) >= Math.abs(locY / Math.max(1, baseRyPx));
          nextRxPx = Math.max(5, baseRxPx * (pullAlongMajor ? stretchScale : crossScale));
          nextRyPx = Math.max(5, baseRyPx * (pullAlongMajor ? crossScale : stretchScale));
          const dAngle = normalizeAngleRad(Math.atan2(vy, vx) - Math.atan2(ay, ax));
          nextRot = rot0 + dAngle;
        }

        const nextIsRotated = Boolean(nextRot && Math.abs(nextRot) > 0.001);
        return {
          ...src,
          cx: newCxPx / scaleX,
          cy: newCyPx / scaleY,
          rx: nextIsRotated ? nextRxPx / avgScale : nextRxPx / scaleX,
          ry: nextIsRotated ? nextRyPx / avgScale : nextRyPx / scaleY,
          rotation: nextIsRotated ? nextRot : undefined,
        };
      }
    }

    // Fallback if no anchor: center-based elastic stretch
    const dx = Math.abs(px - cxPx);
    const dy = Math.abs(py - cyPx);
    const nextRxPx = Math.max(6, dx > 6 ? dx : baseRxPx);
    const nextRyPx = Math.max(6, dy > 6 ? dy : baseRyPx);
    return {
      ...src,
      rx: isRotated ? nextRxPx / avgScale : nextRxPx / scaleX,
      ry: isRotated ? nextRyPx / avgScale : nextRyPx / scaleY,
    };
  }

  if (shape.type === 'polygon' && shape.points.length >= 2) {
    const src = base?.shape.type === 'polygon' ? base.shape : shape;
    if (src.closed) {
      const n = src.points.length;
      const ax = base ? base.anchorX : src.points[0].x;
      const ay = base ? base.anchorY : src.points[0].y;

      let grabIdx = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot((src.points[i].x - ax) * scaleX, (src.points[i].y - ay) * scaleY);
        if (d < bestD) {
          bestD = d;
          grabIdx = i;
        }
      }

      if (isAxisAlignedRect(src.points, scaleX, scaleY)) {
        const oppIdx = (grabIdx + 2) % 4;
        const ox = src.points[oppIdx].x;
        const oy = src.points[oppIdx].y;
        const gx = src.points[grabIdx].x;
        const gy = src.points[grabIdx].y;
        const spanX = gx - ox;
        const spanY = gy - oy;
        const dispX = rawPt.x - ax;
        const dispY = rawPt.y - ay;

        const clampAxisScale = (val: number, spanPx: number): number => {
          const minAbs = 8 / Math.max(8, Math.abs(spanPx));
          if (Math.abs(val) < minAbs) return val >= 0 ? minAbs : -minAbs;
          return Math.max(-5, Math.min(5, val));
        };

        const sx =
          Math.abs(spanX * scaleX) >= 6
            ? clampAxisScale((gx + dispX - ox) / spanX, spanX * scaleX)
            : 1;
        const sy =
          Math.abs(spanY * scaleY) >= 6
            ? clampAxisScale((gy + dispY - oy) / spanY, spanY * scaleY)
            : 1;

        return {
          ...src,
          points: src.points.map((p) => ({
            x: ox + (p.x - ox) * sx,
            y: oy + (p.y - oy) * sy,
          })),
        };
      }

      let oppIdx = 0;
      let maxOppD = -1;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(
          (src.points[i].x - src.points[grabIdx].x) * scaleX,
          (src.points[i].y - src.points[grabIdx].y) * scaleY
        );
        if (d > maxOppD) {
          maxOppD = d;
          oppIdx = i;
        }
      }
      const ox = src.points[oppIdx].x;
      const oy = src.points[oppIdx].y;
      const maxSpan = Math.max(12, maxOppD);
      const dispX = rawPt.x - ax;
      const dispY = rawPt.y - ay;

      return {
        ...src,
        points: src.points.map((p, i) => {
          if (i === oppIdx) return { x: p.x, y: p.y };
          const d = Math.hypot((p.x - ox) * scaleX, (p.y - oy) * scaleY);
          const w = i === grabIdx ? 1 : Math.pow(Math.max(0, Math.min(1, d / maxSpan)), 1.25);
          return {
            x: p.x + dispX * w,
            y: p.y + dispY * w,
          };
        }),
      };
    }

    const lastPt = src.points[src.points.length - 1];
    const ax = base ? base.anchorX : lastPt.x;
    const ay = base ? base.anchorY : lastPt.y;
    return {
      ...src,
      points: applyRopeFalloffPoints(src.points, ax, ay, rawPt.x, rawPt.y, scaleX, scaleY),
    };
  }

  if (shape.type === 'curve' && shape.points.length >= 2) {
    const src = base?.shape.type === 'curve' ? base.shape : shape;
    const lastPt = src.points[src.points.length - 1];
    const ax = base ? base.anchorX : lastPt.x;
    const ay = base ? base.anchorY : lastPt.y;
    return {
      ...src,
      points: applyRopeFalloffPoints(src.points, ax, ay, rawPt.x, rawPt.y, scaleX, scaleY),
    };
  }

  if (shape.type === 'arrow') {
    const src = base?.shape.type === 'arrow' ? base.shape : shape;
    const p0x = src.x1 * scaleX;
    const p0y = src.y1 * scaleY;
    const oldEndX = src.x2 * scaleX;
    const oldEndY = src.y2 * scaleY;

    // Smoothly blend out initial arrowhead-hook offset over the first 28px so pixel-1 drag never jumps
    let newEndX = rawPt.x * scaleX;
    let newEndY = rawPt.y * scaleY;
    if (base) {
      const offX = oldEndX - base.anchorX * scaleX;
      const offY = oldEndY - base.anchorY * scaleY;
      const dMove = Math.hypot(newEndX - base.anchorX * scaleX, newEndY - base.anchorY * scaleY);
      const blend = Math.max(0, 1 - dMove / 28);
      newEndX += offX * blend;
      newEndY += offY * blend;
    }

    const headLen = Math.max(
      11,
      Math.min(24, Math.hypot(src.leftX * scaleX - oldEndX, src.leftY * scaleY - oldEndY))
    );

    if (src.cx !== undefined && src.cy !== undefined) {
      const oldDx = oldEndX - p0x;
      const oldDy = oldEndY - p0y;
      const oldLen = Math.hypot(oldDx, oldDy);
      const newDx = newEndX - p0x;
      const newDy = newEndY - p0y;
      const newLen = Math.hypot(newDx, newDy);
      if (oldLen < 4 || newLen < 4) return shape;

      const oldMidX = (p0x + oldEndX) * 0.5;
      const oldMidY = (p0y + oldEndY) * 0.5;
      const cdx = src.cx * scaleX - oldMidX;
      const cdy = src.cy * scaleY - oldMidY;
      const oldUx = oldDx / oldLen;
      const oldUy = oldDy / oldLen;
      const parallelFrac = (cdx * oldUx + cdy * oldUy) / oldLen;
      const perpBow = -cdx * oldUy + cdy * oldUx;

      const newMidX = (p0x + newEndX) * 0.5;
      const newMidY = (p0y + newEndY) * 0.5;
      const newUx = newDx / newLen;
      const newUy = newDy / newLen;
      const lenRatio = Math.max(0.25, Math.min(2.6, newLen / oldLen));
      const elasticBow = perpBow * (0.65 + 0.35 * lenRatio);
      const ncx = newMidX + newUx * (parallelFrac * newLen) - newUy * elasticBow;
      const ncy = newMidY + newUy * (parallelFrac * newLen) + newUx * elasticBow;

      const wings = buildArrowWings({ x: newEndX, y: newEndY }, newEndX - ncx, newEndY - ncy, headLen);
      return {
        ...src,
        cx: ncx / scaleX,
        cy: ncy / scaleY,
        x2: newEndX / scaleX,
        y2: newEndY / scaleY,
        leftX: wings.left.x / scaleX,
        leftY: wings.left.y / scaleY,
        rightX: wings.right.x / scaleX,
        rightY: wings.right.y / scaleY,
      };
    }

    const deg = Math.abs((Math.atan2(newEndY - p0y, newEndX - p0x) * 180) / Math.PI);
    if (deg < 1.8 || Math.abs(deg - 180) < 1.8) newEndY = p0y;
    else if (Math.abs(deg - 90) < 1.8) newEndX = p0x;
    if (Math.hypot(newEndX - p0x, newEndY - p0y) < 4) return shape;

    const wings = buildArrowWings({ x: newEndX, y: newEndY }, newEndX - p0x, newEndY - p0y, headLen);
    return {
      ...src,
      x2: newEndX / scaleX,
      y2: newEndY / scaleY,
      leftX: wings.left.x / scaleX,
      leftY: wings.left.y / scaleY,
      rightX: wings.right.x / scaleX,
      rightY: wings.right.y / scaleY,
    };
  }

  return shape;
}

/**
 * High-precision stroke hit test in screen pixels (supports freehand strokes AND every universal snapped shape).
 */
export function hitTestStroke(
  screenX: number,
  screenY: number,
  stroke: AnnotationStroke,
  eraserRadiusPx: number,
  tf: RenderTransform
): boolean {
  const strokePad = Math.max(2, stroke.size * tf.unitScale * 0.5);
  const threshold = eraserRadiusPx + strokePad;

  if (stroke.shape) {
    if (stroke.shape.type === 'line') {
      const x1 = stroke.shape.x1 * tf.scaleX + tf.offsetX;
      const y1 = stroke.shape.y1 * tf.scaleY + tf.offsetY;
      const x2 = stroke.shape.x2 * tf.scaleX + tf.offsetX;
      const y2 = stroke.shape.y2 * tf.scaleY + tf.offsetY;
      return distToSegment(screenX, screenY, x1, y1, x2, y2) <= threshold;
    }

    if (stroke.shape.type === 'ellipse') {
      const cx = stroke.shape.cx * tf.scaleX + tf.offsetX;
      const cy = stroke.shape.cy * tf.scaleY + tf.offsetY;
      const { rxPx, ryPx } = resolveEllipseScreenRadii(
        stroke.shape.rx,
        stroke.shape.ry,
        stroke.shape.rotation,
        tf
      );
      const rot = stroke.shape.rotation ?? 0;
      const dx = screenX - cx;
      const dy = screenY - cy;
      const cos = Math.cos(-rot);
      const sin = Math.sin(-rot);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      const angle = Math.atan2(ly / ryPx, lx / rxPx);
      const ex = Math.cos(angle) * rxPx;
      const ey = Math.sin(angle) * ryPx;
      return Math.hypot(lx - ex, ly - ey) <= threshold;
    }

    // Arc, Polygon (open or closed), Arrow, and Smooth Curve
    const polylines = sampleShapeToPolylines(stroke.shape, tf, 6);
    for (const poly of polylines) {
      for (let i = 0; i < poly.length - 1; i++) {
        if (
          distToSegment(screenX, screenY, poly[i].x, poly[i].y, poly[i + 1].x, poly[i + 1].y) <=
          threshold
        ) {
          return true;
        }
      }
    }
    return false;
  }

  const pts = stroke.points;
  if (pts.length === 0) return false;
  if (pts.length === 1) {
    const px = pts[0].x * tf.scaleX + tf.offsetX;
    const py = pts[0].y * tf.scaleY + tf.offsetY;
    return Math.hypot(screenX - px, screenY - py) <= threshold;
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x * tf.scaleX + tf.offsetX;
    const ay = pts[i].y * tf.scaleY + tf.offsetY;
    const bx = pts[i + 1].x * tf.scaleX + tf.offsetX;
    const by = pts[i + 1].y * tf.scaleY + tf.offsetY;
    if (distToSegment(screenX, screenY, ax, ay, bx, by) <= threshold) {
      return true;
    }
  }
  return false;
}
