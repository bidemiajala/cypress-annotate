import type { Page } from 'playwright';
import { annotate } from './annotate.js';
import {
  findingsToAnnotations,
  gatherReasonerInput,
  type BugFinding,
  type Reasoner,
} from './finder.js';
import type { InventoryItem } from './inventory.js';
import { readPageMetrics } from './measure.js';
import type { Annotation, PixelRect } from './types.js';

export interface BugHuntOptions {
  ticket: string;
  reasoner: Reasoner;
  /** Also render a cropped close-up per finding. Default true. */
  perFinding?: boolean;
  /** Context around each finding in its close-up, CSS px. Default 90. */
  cropPadding?: number;
  /** Cap on viewport passes down the page. Default 6. */
  maxPasses?: number;
}

export interface AnnotatedFinding {
  /** 1-based, stable across the whole hunt; matches the overview marker. */
  number: number;
  finding: BugFinding;
  annotation: Annotation;
  /** Which element the annotation actually landed on, for auditing. */
  resolvedTo: string;
  /** Readable selector for the ticket, when the finding resolved to an element. */
  reportSelector: string | null;
  /** Which viewport pass reported it. */
  pass: number;
  image: Buffer;
  drawnRect: PixelRect | undefined;
  warnings: string[];
}

export interface HuntPass {
  index: number;
  scrollY: number;
  inventorySize: number;
  findingCount: number;
  /** Every finding from this pass on one viewport screenshot. */
  overview: Buffer | null;
}

export interface BugHuntResult {
  /** De-duplicated across passes. */
  annotated: AnnotatedFinding[];
  unresolved: { finding: BugFinding; reason: string }[];
  passes: HuntPass[];
  /** Union of every pass's inventory, keyed by readable selector. */
  inventory: InventoryItem[];
}

/**
 * Work down the page one viewport at a time, reasoning about each and
 * annotating whatever comes back.
 *
 * A pass is the unit of correctness here: the inventory, the screenshot the
 * model reasons over, and any percentage region it returns must all share one
 * scroll position. Mixing scroll positions between those three is what makes
 * region fallbacks land in the wrong place, so each pass scrolls, settles, and
 * only then measures.
 */
export async function runBugHunt(page: Page, options: BugHuntOptions): Promise<BugHuntResult> {
  const maxPasses = options.maxPasses ?? 6;

  // Reuse the one definition of these metrics rather than re-deriving them:
  // getting the viewport height wrong here silently collapses the sweep to a
  // single pass on any quirks-mode page.
  const { viewportHeight, documentHeight } = await readPageMetrics(page);

  // Overlap each pass by 10% so a bug straddling a boundary is fully visible in
  // at least one of them.
  const step = Math.max(1, Math.floor(viewportHeight * 0.9));
  const positions: number[] = [];
  for (let y = 0; positions.length < maxPasses; y += step) {
    const clamped = Math.min(y, Math.max(0, documentHeight - viewportHeight));
    if (positions.length > 0 && clamped === positions[positions.length - 1]) break;
    positions.push(clamped);
    if (clamped + viewportHeight >= documentHeight) break;
  }

  const annotated: AnnotatedFinding[] = [];
  const unresolvedByDescription = new Map<string, { finding: BugFinding; reason: string }>();
  const passes: HuntPass[] = [];
  const inventoryBySelector = new Map<string, InventoryItem>();
  const seenKeys = new Set<string>();
  let findingNumber = 0;

  for (const [passIndex, scrollY] of positions.entries()) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(120);

    const input = await gatherReasonerInput(page, options.ticket, true);
    for (const item of input.inventory) {
      if (!inventoryBySelector.has(item.reportSelector)) {
        inventoryBySelector.set(item.reportSelector, item);
      }
    }

    const findings = await options.reasoner.propose(input);
    const resolution = findingsToAnnotations(findings, input.inventory);
    for (const entry of resolution.unresolved) {
      // An element below the fold on this pass may resolve on the next one, so
      // key by description and reconcile against the annotated set at the end.
      if (!unresolvedByDescription.has(entry.finding.description)) {
        unresolvedByDescription.set(entry.finding.description, entry);
      }
    }

    // A bug visible in the overlap between two passes gets reported twice.
    const fresh = resolution.resolved
      .filter((entry) => !seenKeys.has(entry.key))
      .map((entry) => ({ entry, number: ++findingNumber }));
    for (const { entry } of fresh) seenKeys.add(entry.key);

    let overview: Buffer | null = null;
    if (fresh.length > 0) {
      // Full sentences would cover the rest of the page here, so the overview
      // carries a marker and the close-up carries the description.
      const result = await annotate(
        page,
        fresh.map(({ entry, number }) => ({
          ...entry.annotation,
          label: `#${number} ${entry.finding.severity}`,
        })),
        { mode: 'viewport', scrollIntoView: false },
      );
      overview = result.image;
    }

    passes.push({
      index: passIndex,
      scrollY,
      inventorySize: input.inventory.length,
      findingCount: fresh.length,
      overview,
    });

    if (options.perFinding ?? true) {
      for (const { entry, number } of fresh) {
        const labelled: Annotation = {
          ...entry.annotation,
          label: `#${number} ${entry.finding.severity}: ${entry.finding.description}`,
        };
        const result = await annotate(page, [labelled], {
          mode: 'element',
          cropPadding: options.cropPadding ?? 90,
          // Staying at this pass's scroll position keeps percentage regions
          // meaningful; annotate() converts to document space from here.
          scrollToTop: false,
          style: { dimOutside: 0.45 },
        });

        annotated.push({
          number,
          finding: entry.finding,
          annotation: labelled,
          resolvedTo: result.elements[0]?.selector ?? 'unknown',
          reportSelector: entry.item?.reportSelector ?? null,
          pass: passIndex,
          image: result.image,
          drawnRect: result.drawnRects[0],
          warnings: result.warnings,
        });
      }
    }
  }

  const annotatedDescriptions = new Set(annotated.map((a) => a.finding.description));
  const unresolved = Array.from(unresolvedByDescription.values()).filter(
    (entry) => !annotatedDescriptions.has(entry.finding.description),
  );

  return {
    annotated,
    unresolved,
    passes,
    inventory: Array.from(inventoryBySelector.values()),
  };
}
