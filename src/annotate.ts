import type { Page } from 'playwright';
import { annotateImage, type MeasuredTarget } from './annotate-image.js';
import { measureElement, measureRegion, readPageMetrics, scrollElementIntoView } from './measure.js';
import type { Annotation, AnnotateOptions, AnnotateResult, MeasuredElement } from './types.js';

/**
 * Playwright-driven annotation: position the page, measure, capture, and hand
 * the pixels to `annotateImage`, which owns all the coordinate maths and is
 * shared with the driver-agnostic path.
 */
export async function annotate(
  page: Page,
  annotations: Annotation[],
  options: AnnotateOptions = {},
): Promise<AnnotateResult> {
  if (annotations.length === 0) throw new Error('No annotations supplied.');

  const mode = options.mode ?? 'viewport';
  const fullPageCapture = mode !== 'viewport';
  const warnings: string[] = [];

  // Positioning happens before measurement: any scroll invalidates every rect.
  if (fullPageCapture && (options.scrollToTop ?? true)) {
    await page.evaluate(() => window.scrollTo(0, 0));
  } else if (mode === 'viewport' && (options.scrollIntoView ?? true)) {
    // A region is defined relative to wherever the page already is, so
    // scrolling to reveal it would invalidate the very percentages given.
    const first = annotations[0];
    if (first?.selector) await scrollElementIntoView(page, first.selector);
  }
  await page.waitForTimeout(60);

  const metrics = await readPageMetrics(page);
  const elements: MeasuredElement[] = [];
  for (const annotation of annotations) {
    if (annotation.selector && annotation.region) {
      throw new Error('An annotation takes either a selector or a region, not both.');
    }
    if (annotation.selector) {
      elements.push(await measureElement(page, annotation.selector, metrics));
    } else if (annotation.region) {
      elements.push(measureRegion(annotation.region, metrics));
    } else {
      throw new Error('An annotation needs either a selector or a region.');
    }
  }

  for (const element of elements) {
    if (element.matchCount > 1) {
      warnings.push(
        `Selector "${element.selector}" matched ${element.matchCount} elements; annotated the first.`,
      );
    }
    if (mode === 'viewport' && !element.inViewport) {
      warnings.push(`Element "${element.selector}" is outside the viewport; its box will be clipped.`);
    }
  }

  const screenshot = await page.screenshot({
    fullPage: fullPageCapture,
    animations: 'disabled',
    caret: 'hide',
    type: 'png',
  });

  const targets: MeasuredTarget[] = elements.map((element, i) => ({
    viewportRect: element.viewportRect,
    documentRect: element.documentRect,
    isFixed: element.isFixed,
    label: annotations[i]?.label,
    shape: annotations[i]?.shape,
    style: annotations[i]?.style,
    describe: `Element "${element.selector}"`,
  }));

  const result = await annotateImage(screenshot, targets, {
    metrics,
    capture: fullPageCapture ? 'fullPage' : 'viewport',
    crop: mode === 'element',
    cropPadding: options.cropPadding,
    style: options.style,
  });

  return {
    image: result.image,
    rawImage: result.rawImage,
    width: result.width,
    height: result.height,
    metrics,
    elements,
    drawnRects: result.drawnRects,
    warnings: [...warnings, ...result.warnings],
  };
}
