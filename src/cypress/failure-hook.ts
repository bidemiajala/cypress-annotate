/// <reference types="cypress" />
import { describeFailure, recoverFailure, type CommandLike, type CypressLikeError } from './failure-selector.js';
import { collectInventory, measureTargets, readMetrics, type InventoryItem } from './measure-dom.js';
import { isFullyVisible, scrollIntoViewIfNeeded } from './scroll-into-view.js';
import type { AnnotateTaskResult } from './task.js';
import type { FailureRecord } from './failure-report.js';
import type { AnnotationStyle, PageMetrics } from '../types.js';
import type { MeasuredDomTarget } from './measure-dom.js';

export interface FailureCaptureOptions {
  /** Where failure records accumulate across the whole run. */
  reportPath?: string;
  style?: AnnotationStyle;
}

const DEFAULT_REPORT_PATH = 'out/cypress/failures.json';

function slugify(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'failure';
}

/**
 * Register once, in cypress/support/e2e.ts:
 *
 *   registerFailureCapture();
 *
 * On every failed test, this recovers the selector the failing command was
 * targeting (deterministic, no AI - see failure-selector.ts), measures it live
 * while the page is still in its failed state, and draws a box with a label
 * built from the assertion's own expected/actual values.
 *
 * When no selector can be recovered - an existence check, a `cy.contains()`
 * chain, a generic page-state assertion - there is nothing to box
 * deterministically. Those failures get a plain screenshot plus a live DOM
 * inventory (metrics + candidate elements), written to the same report for a
 * separate, explicit tool to reason about afterwards. That split is
 * deliberate: capturing is free and happens for every failure; calling Claude
 * is a cost decision left to whoever reads the report, not made here.
 *
 * Requires `screenshotOnRunFailure: false` in cypress.config.ts - otherwise
 * Cypress's own automatic failure screenshot and this hook's screenshot race,
 * and it becomes ambiguous which one the DOM measurement actually matches.
 */
export function registerFailureCapture(options: FailureCaptureOptions = {}): void {
  const reportPath = options.reportPath ?? DEFAULT_REPORT_PATH;

  afterEach(function (this: Mocha.Context) {
    if (this.currentTest?.state !== 'failed') return;

    // Read failure state before issuing any cy.* command below - those mutate
    // cy.state('current'), so this has to happen first and synchronously.
    const err = this.currentTest.err as CypressLikeError | undefined;
    // cy.state is undocumented Cypress driver internals; guarded because a
    // Cypress upgrade could remove or rename it, and this hook must degrade to
    // "no selector recovered" rather than break the whole afterEach.
    let current: CommandLike | null = null;
    try {
      current = (cy as unknown as { state(key: string): CommandLike }).state('current');
    } catch {
      current = null;
    }

    const recovered = recoverFailure(err, current);
    const label = describeFailure(err, recovered);
    const testTitle = this.currentTest.fullTitle();
    const name = `failure-${slugify(testTitle)}`;

    interface Prepared {
      target: MeasuredDomTarget | null;
      resolved: boolean;
      inventory: InventoryItem[] | null;
      metrics: PageMetrics;
    }

    /**
     * Same measure -> scroll-if-needed -> re-measure discipline as cy.annotate().
     * The failing element was found by cy.state, not chosen from the current
     * viewport, so unlike cy.annotate() it may sit well below the fold - the
     * whole reason this exists is to point at a mismatch, so screenshotting a
     * viewport that never contains the mismatch would be a silent no-op box.
     */
    function prepare(win: Window): Cypress.Chainable<Prepared> {
      const initial =
        recovered.selector && !recovered.elementNotFound ? measureTargets(win, [recovered.selector]) : null;
      const initialTarget = initial?.targets[0];

      const needsScroll =
        initialTarget?.found === true && initialTarget.rect !== undefined && !isFullyVisible(initialTarget.rect, win);

      if (!needsScroll) {
        const resolved = Boolean(initialTarget?.found && initialTarget.rect);
        return cy.wrap<Prepared>(
          {
            target: initialTarget ?? null,
            resolved,
            inventory: resolved ? null : collectInventory(win),
            metrics: readMetrics(win),
          },
          { log: false },
        );
      }

      return scrollIntoViewIfNeeded(recovered.selector as string)
        .then(() => cy.window({ log: false }))
        .then((w) => {
          const remeasured = measureTargets(w, [recovered.selector as string]);
          const target = remeasured.targets[0];
          const resolved = Boolean(target?.found && target.rect);
          return {
            target: target ?? null,
            resolved,
            inventory: resolved ? null : collectInventory(w),
            metrics: readMetrics(w),
          };
        });
    }

    cy.window({ log: false })
      .then((win) => prepare(win))
      .then(({ target, resolved, inventory, metrics }) => {
        let screenshotPath: string | undefined;

        return cy
          .screenshot(name, {
            capture: 'viewport',
            overwrite: true,
            log: false,
            onAfterScreenshot(_el, props) {
              screenshotPath = props.path;
            },
          })
          .then(() => {
            if (!screenshotPath) {
              throw new Error('registerFailureCapture: Cypress did not report a screenshot path.');
            }
            if (!resolved) {
              return cy.wrap<AnnotateTaskResult | null>(null, { log: false }) as Cypress.Chainable<
                AnnotateTaskResult | null
              >;
            }

            return cy.task('annotateScreenshot', {
              screenshotPath,
              measurement: { metrics, targets: [target!] },
              labels: [label],
              capture: 'viewport',
              style: options.style,
            }) as Cypress.Chainable<AnnotateTaskResult | null>;
          })
          .then((annotateResult: AnnotateTaskResult | null) => {
            const record: FailureRecord = {
              spec: Cypress.spec.relative,
              test: testTitle,
              errMessage: err?.message ?? '',
              errName: err?.name,
              selector: recovered.selector,
              selectorSource: recovered.source,
              expected: recovered.expected,
              actual: recovered.actual,
              elementNotFound: recovered.elementNotFound,
              label,
              resolved,
              screenshotPath: screenshotPath!,
              annotatedPath: annotateResult?.outPath ?? null,
              drawnRect: annotateResult?.drawnRects[0] ?? null,
              metrics,
              inventory: inventory
                ? inventory.map((item) => ({
                    selector: `[data-annot-ref="${item.ref}"]`,
                    found: true,
                    tag: item.tag,
                    text: item.name,
                    rect: item.rect,
                  }))
                : null,
              warnings: annotateResult?.warnings ?? [],
              timestamp: new Date().toISOString(),
            };

            return cy.task('appendFailureRecord', { reportPath, record }, { log: false });
          });
      });
  });
}
