import sharp from 'sharp';
import type { PixelRect, ShapeKind } from './types.js';

/** Style values already converted to image pixels. */
export interface ResolvedStyle {
  color: string;
  strokeWidth: number;
  radius: number;
  dimOutside: number;
  labelFontSize: number;
  labelColor: string;
}

export interface DrawSpec {
  rect: PixelRect;
  label?: string;
  shape: ShapeKind;
  style: ResolvedStyle;
}

const FONT_STACK = "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif";

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      default: return '&quot;';
    }
  });
}

function round(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/**
 * Approximate rendered text width. librsvg gives us no measurement API, so the
 * label pill is sized from an average glyph ratio and generous padding.
 */
function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.58;
}

function dimPath(width: number, height: number, holes: PixelRect[]): string {
  const outer = `M0 0 H${round(width)} V${round(height)} H0 Z`;
  const inner = holes
    .map((r) => `M${round(r.x)} ${round(r.y)} H${round(r.x + r.width)} V${round(r.y + r.height)} H${round(r.x)} Z`)
    .join(' ');
  return `${outer} ${inner}`;
}

function boxShape(rect: PixelRect, style: ResolvedStyle): string {
  // Inset by half the stroke so the outline's outer edge lands on the rect.
  const half = style.strokeWidth / 2;
  return (
    `<rect x="${round(rect.x + half)}" y="${round(rect.y + half)}" ` +
    `width="${round(Math.max(0, rect.width - style.strokeWidth))}" ` +
    `height="${round(Math.max(0, rect.height - style.strokeWidth))}" ` +
    `rx="${round(style.radius)}" fill="none" ` +
    `stroke="${escapeXml(style.color)}" stroke-width="${round(style.strokeWidth)}" />`
  );
}

function circleShape(rect: PixelRect, style: ResolvedStyle): string {
  // Semi-axes scaled by sqrt(2) so the ellipse circumscribes the rectangle.
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rx = (rect.width / 2) * Math.SQRT2;
  const ry = (rect.height / 2) * Math.SQRT2;
  return (
    `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(rx)}" ry="${round(ry)}" ` +
    `fill="none" stroke="${escapeXml(style.color)}" stroke-width="${round(style.strokeWidth)}" />`
  );
}

interface ArrowGeometry {
  svg: string;
  /** Where the arrow starts, so a label can sit there instead of over the target. */
  tail: { x: number; y: number };
}

function arrowShape(
  rect: PixelRect,
  style: ResolvedStyle,
  imageWidth: number,
  imageHeight: number,
): ArrowGeometry {
  const length = style.strokeWidth * 22;
  const tipX = rect.x + rect.width / 2;
  const tipY = rect.y;

  // Prefer approaching from above-left; flip whichever axis has no room.
  let dx = -length * 0.7;
  let dy = -length;
  if (tipY + dy < style.strokeWidth * 4) dy = rect.height + length;
  if (tipX + dx < style.strokeWidth * 4) dx = length * 0.7;

  const tailX = Math.min(Math.max(tipX + dx, 0), imageWidth);
  const tailY = Math.min(Math.max(dy > 0 ? rect.y + rect.height + length : tipY + dy, 0), imageHeight);
  const anchorY = dy > 0 ? rect.y + rect.height : tipY;

  const angle = Math.atan2(anchorY - tailY, tipX - tailX);
  const head = style.strokeWidth * 5;
  const spread = Math.PI / 7;
  const p1x = tipX - head * Math.cos(angle - spread);
  const p1y = anchorY - head * Math.sin(angle - spread);
  const p2x = tipX - head * Math.cos(angle + spread);
  const p2y = anchorY - head * Math.sin(angle + spread);

  return {
    svg:
      `<line x1="${round(tailX)}" y1="${round(tailY)}" x2="${round(tipX - Math.cos(angle) * head * 0.6)}" ` +
      `y2="${round(anchorY - Math.sin(angle) * head * 0.6)}" stroke="${escapeXml(style.color)}" ` +
      `stroke-width="${round(style.strokeWidth)}" stroke-linecap="round" />` +
      `<polygon points="${round(tipX)},${round(anchorY)} ${round(p1x)},${round(p1y)} ${round(p2x)},${round(p2y)}" ` +
      `fill="${escapeXml(style.color)}" />`,
    tail: { x: tailX, y: tailY },
  };
}

function labelShape(
  text: string,
  rect: PixelRect,
  style: ResolvedStyle,
  imageWidth: number,
  imageHeight: number,
  centerOnAnchor = false,
): string {
  const fontSize = style.labelFontSize;
  const padX = fontSize * 0.55;
  const padY = fontSize * 0.35;
  const lineHeight = fontSize * 1.28;
  const gap = style.strokeWidth * 1.5;

  // Bug descriptions are sentences, not captions, so the label has to wrap or
  // it runs off the edge of a cropped screenshot.
  const maxTextWidth = Math.max(fontSize * 8, imageWidth * 0.92 - padX * 2);
  const lines = wrapText(text, fontSize, maxTextWidth, 3);
  const pillHeight = lines.length * lineHeight + padY * 2;
  const pillWidth =
    Math.max(...lines.map((line) => estimateTextWidth(line, fontSize))) + padX * 2;

  let pillX = centerOnAnchor ? rect.x + rect.width / 2 - pillWidth / 2 : rect.x;
  let pillY = rect.y - pillHeight - gap;
  if (pillY < 0) {
    // No room above: try below, then fall back to sitting inside the top edge.
    pillY = rect.y + rect.height + gap;
    if (pillY + pillHeight > imageHeight) pillY = Math.max(0, rect.y + gap);
  }
  pillX = Math.min(Math.max(0, pillX), Math.max(0, imageWidth - pillWidth));

  const firstBaseline = pillY + padY + fontSize * 0.82;
  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${round(pillX + padX)}" y="${round(firstBaseline + i * lineHeight)}">${escapeXml(line)}</tspan>`,
    )
    .join('');

  return (
    `<rect x="${round(pillX)}" y="${round(pillY)}" width="${round(pillWidth)}" height="${round(pillHeight)}" ` +
    `rx="${round(Math.min(pillHeight / 2, fontSize * 0.5))}" fill="${escapeXml(style.color)}" />` +
    `<text font-family="${FONT_STACK}" font-size="${round(fontSize)}" font-weight="600" ` +
    `fill="${escapeXml(style.labelColor)}" xml:space="preserve">${tspans}</text>`
  );
}

/** Greedy word wrap against the same glyph-ratio estimate used for the pill. */
function wrapText(text: string, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (estimateTextWidth(candidate, fontSize) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);

  if (lines.length === maxLines) {
    // Signal that text was dropped rather than silently truncating a sentence.
    const consumed = lines.join(' ').split(/\s+/).length;
    if (consumed < words.length) {
      const last = lines[maxLines - 1] ?? '';
      lines[maxLines - 1] = `${last.replace(/[,;:]?$/, '')}…`;
    }
  }
  return lines;
}

export function buildOverlaySvg(width: number, height: number, specs: DrawSpec[]): string {
  const parts: string[] = [];

  const dimmed = specs.filter((s) => s.style.dimOutside > 0);
  if (dimmed.length > 0) {
    const opacity = Math.max(...dimmed.map((s) => s.style.dimOutside));
    parts.push(
      `<path d="${dimPath(width, height, specs.map((s) => s.rect))}" fill-rule="evenodd" ` +
        `fill="#000" fill-opacity="${round(opacity)}" />`,
    );
  }

  for (const spec of specs) {
    // An arrow's label belongs at the tail; anywhere else it covers the thing
    // the arrow is pointing at.
    let labelAnchor = spec.rect;
    let centerLabel = false;

    if (spec.shape === 'box') {
      parts.push(boxShape(spec.rect, spec.style));
    } else if (spec.shape === 'circle') {
      parts.push(circleShape(spec.rect, spec.style));
    } else {
      const arrow = arrowShape(spec.rect, spec.style, width, height);
      parts.push(arrow.svg);
      labelAnchor = { x: arrow.tail.x, y: arrow.tail.y, width: 0, height: 0 };
      centerLabel = true;
    }

    if (spec.label) {
      parts.push(labelShape(spec.label, labelAnchor, spec.style, width, height, centerLabel));
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
  );
}

export async function compositeOverlay(screenshot: Buffer, svg: string): Promise<Buffer> {
  return sharp(screenshot)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
