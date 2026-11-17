import sharp from 'sharp';
import {
  buildOverlaySvg,
  compositeOverlay,
  DEFAULT_FONT_STACK,
  type DrawSpec,
  type ResolvedStyle,
} from './draw.js';
import type {
  AnnotationStyle,
  CaptureReport,
  CssRect,
  PageMetrics,
  PixelRect,
  ShapeKind,
} from './types.js';

/**
 * Annotating an image that somebody else captured.
 *
 * Nothing here knows about Playwright, CDP, or any particular browser driver -
 * it takes a screenshot, the page metrics that were true when it was taken, and
 * rectangles in CSS pixels. That is deliberate: the screenshot may come from a
 * Playwright MCP server, a Chrome DevTools MCP server, or a Cypress run, and the
 * coordinate maths is identical in every case.
 */

export interface MeasuredTarget {
  /** Viewport-relative CSS px, straight from getBoundingClientRect(). */
  viewportRect: CssRect;
  /**
   * Document-relative CSS px. Derived from viewportRect and scroll when
   * omitted, which is correct for everything that is not position:fixed.
   */
  documentRect?: CssRect;
  /** Fixed elements do not move with scroll, so they get no scroll correction. */
  isFixed?: boolean;
  label?: string;
  shape?: ShapeKind;
  style?: AnnotationStyle;
  /** Used only in warnings, to say which target had a problem. */
  describe?: string;
}

export interface AnnotateImageOptions {
  metrics: PageMetrics;
  /** Whether the image holds just the viewport or the whole document. */
  capture?: 'viewport' | 'fullPage';
  /** Crop to the annotated area plus padding. */
  crop?: boolean;
  /** Context to keep around the target when cropping, CSS px. Default 40. */
  cropPadding?: number;
  style?: AnnotationStyle;
  /**
   * What the capturing tool reported about the image. Without it, the scale is
   * inferred from the image width, which cannot tell a resized image from one
   * the browser window cut short.
   */
  captureReport?: CaptureReport;
}

export interface AnnotateImageResult {
  image: Buffer;
  /** The same pixels without the overlay, cropped identically. */
  rawImage: Buffer;
  width: number;
  height: number;
  /** Image pixels per CSS pixel actually used. */
  scale: number;
  /** One per target that landed in the image. A target outside it is skipped, with a warning. */
  drawnRects: PixelRect[];
  warnings: string[];
}

const DEFAULT_STYLE: Required<AnnotationStyle> = {
  color: '#FF3B30',
  strokeWidth: 3,
  padding: 4,
  radius: 6,
  dimOutside: 0,
  labelFontSize: 14,
  labelColor: '#FFFFFF',
  labelBackground: '',
  labelFontFamily: DEFAULT_FONT_STACK,
  labelFontWeight: 600,
};

/**
 * Merge style layers, lowest priority first. `labelBackground` defaults to
 * whatever `color` resolved to, so setting one brand colour themes the outline
 * and the label pill together, and setting both still works.
 */

export function resolveStyle(...layers: (AnnotationStyle | undefined)[]): Required<AnnotationStyle> {
  const merged: Required<AnnotationStyle> = Object.assign(
    {},
    DEFAULT_STYLE,
    ...layers.map((l) => l ?? {}),
  );
  if (!merged.labelBackground) merged.labelBackground = merged.color;
  return merged;
}

/** Convert CSS-pixel style values into image pixels at the capture's scale. */
function toDeviceStyle(style: Required<AnnotationStyle>, scale: number): ResolvedStyle {
  return {
    color: style.color,
    strokeWidth: style.strokeWidth * scale,
    radius: style.radius * scale,
    dimOutside: style.dimOutside,
    labelFontSize: style.labelFontSize * scale,
    labelColor: style.labelColor,
    labelBackground: style.labelBackground,
    labelFontFamily: style.labelFontFamily,
    labelFontWeight: style.labelFontWeight,
  };
}

function inflate(rect: CssRect, by: number): CssRect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 };
}

function scaleRect(rect: CssRect, scale: number): PixelRect {
  return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
}

function clampRect(rect: PixelRect, width: number, height: number): PixelRect {
  const x = Math.max(0, Math.min(rect.x, width));
  const y = Math.max(0, Math.min(rect.y, height));
  return {
    x,
    y,
    width: Math.max(0, Math.min(rect.x + rect.width, width) - x),
    height: Math.max(0, Math.min(rect.y + rect.height, height) - y),
  };
}

/**
 * The image-pixels-per-CSS-pixel ratio actually used for this capture.
 *
 * `devicePixelRatio` is the intended answer, but it is only a claim about the
 * browser - not about the file. Agent browser tools routinely downscale
 * screenshots to keep them cheap to send, and a capture that has been resized
 * behind your back is exactly what makes a box drift. So the image is measured
 * and the reported ratio is treated as a hint.
 *
 * A narrow image has a second explanation, though. A headless browser window
 * smaller than the viewport captures only its top-left corner, at full scale,
 * and width alone cannot tell that apart from a resize. So when the capturing
 * tool says the image was not resized, its pixel ratio wins.
 */
export function resolveScale(
  imageWidth: number,
  cssWidth: number,
  devicePixelRatio: number,
  warnings: string[],
  report?: CaptureReport,
): number {
  if (report && !report.scaled && report.pixelRatio > 0) return report.pixelRatio;

  if (cssWidth <= 0) {
    warnings.push('Page metrics reported a zero-width viewport; falling back to devicePixelRatio.');
    return devicePixelRatio;
  }

  const expected = Math.round(cssWidth * devicePixelRatio);
  if (Math.abs(imageWidth - expected) <= 2) return devicePixelRatio;

  const derived = imageWidth / cssWidth;
  warnings.push(
    `Screenshot is ${imageWidth}px wide but devicePixelRatio ${devicePixelRatio} over ${cssWidth} ` +
      `CSS px predicted ${expected}px - the image was probably rescaled. ` +
      `Using the measured scale ${derived.toFixed(4)} instead.`,
  );
  return derived;
}

function documentRectOf(target: MeasuredTarget, metrics: PageMetrics): CssRect {
  if (target.documentRect) return target.documentRect;
  if (target.isFixed) return { ...target.viewportRect };
  return {
    ...target.viewportRect,
    x: target.viewportRect.x + metrics.scrollX,
    y: target.viewportRect.y + metrics.scrollY,
  };
}

export async function annotateImage(
  screenshot: Buffer,
  targets: MeasuredTarget[],
  options: AnnotateImageOptions,
): Promise<AnnotateImageResult> {
  if (targets.length === 0) throw new Error('No targets supplied.');

  const { metrics } = options;
  const capture = options.capture ?? 'viewport';
  const fullPage = capture === 'fullPage';
  const warnings: string[] = [];

  const meta = await sharp(screenshot).metadata();
  const imageWidth = meta.width ?? 0;
  const imageHeight = meta.height ?? 0;
  if (imageWidth === 0 || imageHeight === 0) throw new Error('Could not read the screenshot dimensions.');

  const cssWidth = fullPage ? metrics.documentWidth : metrics.viewportWidth;
  const cssHeight = fullPage ? metrics.documentHeight : metrics.viewportHeight;
  const scale = resolveScale(imageWidth, cssWidth, metrics.devicePixelRatio, warnings, options.captureReport);

  // The CSS area the image actually holds, from its own top-left corner.
  const coveredWidth = imageWidth / scale;
  const coveredHeight = imageHeight / scale;
  if (coveredWidth < cssWidth - 1 || coveredHeight < cssHeight - 1) {
    warnings.push(
      `Screenshot covers only ${Math.round(coveredWidth)}x${Math.round(coveredHeight)} CSS px of the ` +
        `${Math.round(cssWidth)}x${Math.round(cssHeight)} ${fullPage ? 'page' : 'viewport'}, which usually ` +
        `means the browser window is smaller than the viewport. Size the window to match in before:browser:launch.`,
    );
  }

  const placed: { target: MeasuredTarget; rect: PixelRect }[] = [];
  for (const target of targets) {
    const name = target.describe ?? 'target';
    if (target.viewportRect.width === 0 || target.viewportRect.height === 0) {
      warnings.push(`${name} has a zero-sized box.`);
    }
    if (target.isFixed && fullPage) {
      warnings.push(
        `${name} is position:fixed, so it has no stable document position in a full-page capture; ` +
          `annotated where it was painted.`,
      );
    }

    const base = fullPage ? documentRectOf(target, metrics) : target.viewportRect;
    const right = base.x + base.width;
    const bottom = base.y + base.height;
    if (base.x >= coveredWidth || base.y >= coveredHeight || right <= 0 || bottom <= 0) {
      warnings.push(`${name} is outside the captured area, so no box was drawn for it.`);
      continue;
    }
    if (base.x < 0 || base.y < 0 || right > coveredWidth || bottom > coveredHeight) {
      warnings.push(`${name} runs past the edge of the captured area; its box is clipped.`);
    }

    const style = resolveStyle(options.style, target.style);
    placed.push({ target, rect: scaleRect(inflate(base, style.padding), scale) });
  }
  const sourceRects = placed.map((p) => p.rect);

  let finalImage = screenshot;
  let finalWidth = imageWidth;
  let finalHeight = imageHeight;
  let originX = 0;
  let originY = 0;

  if (options.crop && sourceRects.length > 0) {
    const pad = (options.cropPadding ?? 40) * scale;
    const union = sourceRects.reduce<PixelRect>(
      (acc, r) => {
        const x = Math.min(acc.x, r.x);
        const y = Math.min(acc.y, r.y);
        return {
          x,
          y,
          width: Math.max(acc.x + acc.width, r.x + r.width) - x,
          height: Math.max(acc.y + acc.height, r.y + r.height) - y,
        };
      },
      { ...(sourceRects[0] as PixelRect) },
    );

    const crop = clampRect(inflate(union, pad) as PixelRect, imageWidth, imageHeight);
    const box = {
      left: Math.floor(crop.x),
      top: Math.floor(crop.y),
      width: Math.max(1, Math.ceil(crop.width)),
      height: Math.max(1, Math.ceil(crop.height)),
    };
    if (box.left + box.width > imageWidth) box.width = imageWidth - box.left;
    if (box.top + box.height > imageHeight) box.height = imageHeight - box.top;

    finalImage = await sharp(screenshot).extract(box).png().toBuffer();
    finalWidth = box.width;
    finalHeight = box.height;
    originX = box.left;
    originY = box.top;
  }

  const drawnRects = sourceRects.map((r) => ({ ...r, x: r.x - originX, y: r.y - originY }));

  const specs: DrawSpec[] = drawnRects.map((rect, i) => {
    const target = placed[i]?.target;
    const style = resolveStyle(options.style, target?.style);
    return {
      rect,
      label: target?.label,
      shape: target?.shape ?? 'box',
      style: toDeviceStyle(style, scale),
    };
  });

  // Nothing landed in the image, so leave it untouched. Dimming everything
  // outside zero boxes would only darken the whole screenshot.
  const image =
    specs.length > 0
      ? await compositeOverlay(finalImage, buildOverlaySvg(finalWidth, finalHeight, specs))
      : finalImage;

  return {
    image,
    rawImage: finalImage,
    width: finalWidth,
    height: finalHeight,
    scale,
    drawnRects,
    warnings,
  };
}
