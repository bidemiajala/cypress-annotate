import { chromium, type Browser, type LaunchOptions } from 'playwright';
import { annotate } from './annotate.js';
import type { Annotation, AnnotateOptions, AnnotateResult } from './types.js';

export { annotate } from './annotate.js';
export {
  annotateImage,
  resolveScale,
  type AnnotateImageOptions,
  type AnnotateImageResult,
  type MeasuredTarget,
} from './annotate-image.js';
export { measureElement, measureRegion, readPageMetrics } from './measure.js';
export { buildOverlaySvg, compositeOverlay } from './draw.js';
export { collectInventory, renderInventory, type InventoryItem } from './inventory.js';
export {
  ClaudeReasoner,
  findingsToAnnotations,
  gatherReasonerInput,
  SEVERITY_COLORS,
  type BugFinding,
  type Reasoner,
  type ReasonerInput,
  type Severity,
} from './finder.js';
export { runBugHunt, type BugHuntOptions, type BugHuntResult } from './pipeline.js';
export type * from './types.js';

export interface CaptureOptions extends AnnotateOptions {
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  headless?: boolean;
  /** Extra settling time after load, in ms, for pages that animate in. */
  settleMs?: number;
  launch?: LaunchOptions;
}

/** One-shot: open a URL, annotate it, close the browser. */
export async function captureAnnotated(
  url: string,
  annotations: Annotation[],
  options: CaptureOptions = {},
): Promise<AnnotateResult> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: options.headless ?? true, ...options.launch });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 800 },
      deviceScaleFactor: options.deviceScaleFactor ?? 2,
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    if (options.settleMs) await page.waitForTimeout(options.settleMs);
    return await annotate(page, annotations, options);
  } finally {
    await browser?.close();
  }
}
