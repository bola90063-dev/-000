import React, { useEffect } from 'react';
import { useAnnotationToolState } from './AnnotationContext';

function encodeSvgDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;
}

/**
 * 1:1 42x42 OS-hardware SVG cursor for Apple Pen.
 * Razor-sharp needle vertex & live wet-ink size dot sit at exact pixel (5, 37) -> hotspot "5 37".
 */
function buildPenHardwareCursor(color: string, tipDotPx: number): string {
  const tipR = Math.max(1.3, Math.min(4.2, tipDotPx * 0.5));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 42 42" fill="none">
    <circle cx="5" cy="37" r="${(tipR + 1.15).toFixed(2)}" fill="#FFFFFF" opacity="0.96"/>
    <circle cx="5" cy="37" r="${tipR.toFixed(2)}" fill="${color}"/>
    <path d="M12.85 23.91L30.66 6.1C32.1 4.66 34.46 4.66 35.9 6.1C37.34 7.54 37.34 9.9 35.9 11.34L18.09 29.15L12.85 23.91Z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="2.1" stroke-linejoin="round" opacity="0.92"/>
    <path d="M12.85 23.91L30.66 6.1C32.1 4.66 34.46 4.66 35.9 6.1C37.34 7.54 37.34 9.9 35.9 11.34L18.09 29.15L12.85 23.91Z" fill="#F6F9FC" stroke="rgba(15,23,42,0.28)" stroke-width="0.9" stroke-linejoin="round"/>
    <path d="M14.4 22.36L17.8 18.96L23.04 24.2L19.64 27.6L14.4 22.36Z" fill="${color}"/>
    <path d="M11.36 25.54L12.85 23.91L18.09 29.15L16.46 30.64L11.36 25.54Z" fill="#DCE3EC" stroke="rgba(15,23,42,0.22)" stroke-width="0.75" stroke-linejoin="round"/>
    <path d="M5 37L11.36 25.54L16.46 30.64L5 37Z" fill="#FFFFFF" stroke="rgba(15,23,42,0.28)" stroke-width="0.85" stroke-linejoin="round"/>
    <path d="M15.2 23.4L32.1 6.5" stroke="rgba(255,255,255,0.75)" stroke-width="1.25" stroke-linecap="round"/>
    <path d="M5 37L7.65 32.01C8.55 32.78 9.22 33.45 9.99 34.35L5 37Z" fill="${color}"/>
  </svg>`;
  return `url("${encodeSvgDataUri(svg)}") 5 37, crosshair`;
}

/**
 * 1:1 42x42 OS-hardware SVG cursor for Apple Chisel-Tip Highlighter.
 * Chisel felt midpoint & live -22deg contact bar sit at exact pixel (7, 35) -> hotspot "7 35".
 */
function buildHighlighterHardwareCursor(color: string, chiselSpanPx: number): string {
  const halfSpan = Math.max(5, Math.min(13.5, chiselSpanPx * 0.5));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 42 42" fill="none">
    <g transform="translate(7 35) rotate(-22)">
      <rect x="-2.8" y="${(-halfSpan - 1).toFixed(1)}" width="5.6" height="${(halfSpan * 2 + 2).toFixed(1)}" rx="2.6" fill="#FFFFFF" opacity="0.92"/>
      <rect x="-1.9" y="${(-halfSpan).toFixed(1)}" width="3.8" height="${(halfSpan * 2).toFixed(1)}" rx="1.9" fill="${color}" stroke="rgba(15,23,42,0.36)" stroke-width="0.9"/>
    </g>
    <path d="M12.7 22.8L28.8 6.7C30.5 5.0 33.3 5.0 35.0 6.7L35.3 7.0C37.0 8.7 37.0 11.5 35.3 13.2L19.2 29.3L12.7 22.8Z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="2.1" stroke-linejoin="round" opacity="0.9"/>
    <path d="M4.9 33.1L9.1 36.9L14.7 32.5L9.5 27.3L4.9 33.1Z" fill="${color}" opacity="0.95" stroke="rgba(15,23,42,0.28)" stroke-width="0.85" stroke-linejoin="round"/>
    <path d="M9.4 27.2L12.7 22.8L19.2 29.3L14.8 32.6L9.4 27.2Z" fill="#EEF3F8" stroke="rgba(15,23,42,0.24)" stroke-width="0.82" stroke-linejoin="round"/>
    <path d="M12.7 22.8L28.8 6.7C30.5 5.0 33.3 5.0 35.0 6.7L35.3 7.0C37.0 8.7 37.0 11.5 35.3 13.2L19.2 29.3L12.7 22.8Z" fill="#F6F9FC" stroke="rgba(15,23,42,0.26)" stroke-width="0.88" stroke-linejoin="round"/>
    <path d="M15.3 20.2L24.3 11.2L30.8 17.7L21.8 26.7L15.3 20.2Z" fill="${color}" opacity="0.88"/>
    <path d="M16.6 21.6L30.8 7.4" stroke="rgba(255,255,255,0.72)" stroke-width="1.45" stroke-linecap="round"/>
  </svg>`;
  return `url("${encodeSvgDataUri(svg)}") 7 35, crosshair`;
}

/**
 * 1:1 64x64 OS-hardware SVG cursor for Smart Eraser.
 * Dynamic frosted precision ring & mini pastel-rose badge centered at exact pixel (32, 32).
 */
function buildEraserHardwareCursor(diameterPx: number): string {
  const clampedDia = Math.max(18, Math.min(54, Math.round(diameterPx)));
  const r = clampedDia * 0.5;
  const innerR = Math.max(4, r - 1.4);
  const badgeOffset = Math.min(20, Math.round(r * 0.72 + 1));
  const bx = Math.min(45, 32 + badgeOffset - 6);
  const by = Math.max(2, 32 - badgeOffset - 12);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none">
    <circle cx="32" cy="32" r="${r.toFixed(1)}" fill="rgba(255,255,255,0.34)" stroke="rgba(15,23,42,0.68)" stroke-width="1.55"/>
    <circle cx="32" cy="32" r="${innerR.toFixed(1)}" stroke="rgba(255,255,255,0.95)" stroke-width="1.3"/>
    <circle cx="32" cy="32" r="1.5" fill="rgba(15,23,42,0.62)"/>
    <g transform="translate(${bx} ${by}) scale(0.78)">
      <path d="M4.2 14.4L12.8 5.8C14 4.6 16 4.6 17.2 5.8L18.8 7.4C20 8.6 20 10.6 18.8 11.8L11.6 19H7L4.2 16.2C3.6 15.6 3.6 15 4.2 14.4Z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="2.2" stroke-linejoin="round" opacity="0.95"/>
      <path d="M4.2 14.4L9.6 9L15.6 15L11.6 19H7L4.2 16.2C3.6 15.6 3.6 15 4.2 14.4Z" fill="#F2F6FA" stroke="rgba(15,23,42,0.26)" stroke-width="0.9" stroke-linejoin="round"/>
      <path d="M9.6 9L11.2 7.4L17.2 13.4L15.6 15L9.6 9Z" fill="#DCE3EC" stroke="rgba(15,23,42,0.2)" stroke-width="0.75" stroke-linejoin="round"/>
      <path d="M11.2 7.4L12.8 5.8C14 4.6 16 4.6 17.2 5.8L18.8 7.4C20 8.6 20 10.6 18.8 11.8L17.2 13.4L11.2 7.4Z" fill="#F8C8DC" stroke="rgba(190,24,93,0.34)" stroke-width="0.85" stroke-linejoin="round"/>
    </g>
  </svg>`;
  return `url("${encodeSvgDataUri(svg)}") 32 32, default`;
}

/**
 * Native OS-Hardware Tool Cursor Controller.
 *
 * Syncs live-sized, live-colored studio SVG CSS cursors directly to CSS custom properties
 * so cursor tracking runs at 0.00ms OS hardware scanout latency (zero JS/DOM/rAF overhead).
 */
export const AnnotationToolCursor: React.FC = () => {
  const { activeTool, penSettings, highlighterSettings, eraserSettings } =
    useAnnotationToolState();

  const penTipDotPx = Math.max(2.6, Math.min(7.5, Math.round(penSettings.size * 0.65 * 10) / 10));
  const hlChiselSpanPx = Math.max(10, Math.min(26, Math.round(highlighterSettings.size * 0.54)));
  const eraserDiameterPx = Math.max(18, Math.min(54, Math.round(eraserSettings.size * 1.0)));

  useEffect(() => {
    const isDrawingTool = activeTool !== 'cursor';
    document.body.classList.toggle('is-annotation-tool-active', isDrawingTool);
    document.body.classList.remove('has-live-tool-cursor');
    return () => {
      document.body.classList.remove('is-annotation-tool-active');
    };
  }, [activeTool]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--annotation-pen-cursor',
      buildPenHardwareCursor(penSettings.color, penTipDotPx)
    );
  }, [penSettings.color, penTipDotPx]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--annotation-hl-cursor',
      buildHighlighterHardwareCursor(highlighterSettings.color, hlChiselSpanPx)
    );
  }, [highlighterSettings.color, hlChiselSpanPx]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--annotation-eraser-cursor',
      buildEraserHardwareCursor(eraserDiameterPx)
    );
  }, [eraserDiameterPx]);

  return null;
};

