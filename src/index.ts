import { annotate } from './annotate.js';
import type { Annotation, AnnotateOptions, AnnotateResult } from './types.js';
import type { Browser, LaunchOptions } from 'playwright';

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
// ClaudeReasoner is not re-exported here - import it from 'cypress-annotate/reasoner'
// instead. It is the only piece of this package with a real (non-type-only)
// dependency on @anthropic-ai/sdk; keeping it out of this barrel means every
// other export here stays usable with neither the SDK nor a peer install of it.
export {
  findingsToAnnotations,
  gatherReasonerInput,
  ReplayReasoner,
  SEVERITY_COLORS,
  type BugFinding,
  type Reasoner,
  type ReasonerInput,
  type ResolvedFinding,
  type ResolvedFindings,
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

/**
 * One-shot: open a URL, annotate it, close the browser.
 *
 * Playwright is loaded lazily, on the first call, rather than imported at the
 * top of this file. `playwright` is an optional peer dependency - a consumer
 * who only wants annotateImage()/the Cypress plugin (neither of which touch a
 * browser at all) should never be forced to have it installed just because
 * this function exists somewhere else in the same package.
 */
/**
 * playwright is an optional peer, so a consumer who only uses the Cypress
 * plugin or annotateImage never installs it. Reaching this without it is an
 * ordinary mistake, and the bare ERR_MODULE_NOT_FOUND names an internal dist
 * path rather than the two commands that fix it.
 */
async function loadChromium(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'captureAnnotated() needs playwright, which is an optional peer dependency.\n' +
          '  npm install playwright\n' +
          '  npx playwright install chromium\n' +
          'The Cypress plugin and annotateImage() do not need it.',
        { cause: error },
      );
    }
    throw error;
  }
}

export async function captureAnnotated(
  url: string,
  annotations: Annotation[],
  options: CaptureOptions = {},
): Promise<AnnotateResult> {
  let browser: Browser | undefined;
  try {
    const { chromium } = await loadChromium();
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
