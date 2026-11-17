/// <reference types="cypress" />
import { describeFailure, recoverFailure, type CommandLike, type CypressLikeError } from './failure-selector.js';
import { collectInventory, measureTargets, readMetrics, type InventoryItem } from './measure-dom.js';
import { isFullyVisible } from './scroll-into-view.js';
import { readAnnotateConfig, DEFAULT_REPORT_PATH } from './config.js';
import type { AnnotateTaskResult, SoftResult } from './task.js';
import type { FailureRecord } from './failure-report.js';
import type { AnnotationStyle, CaptureReport, PageMetrics } from '../types.js';
import type { MeasuredDomTarget } from './measure-dom.js';

export interface FailureCaptureOptions {
  /** Where failure records accumulate across the whole run. */
  reportPath?: string;
  style?: AnnotationStyle;
}

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
 *
 * The hook must never fail the run. A failing afterEach makes Cypress skip
 * every remaining test in the spec, which is far worse than a missing box. So
 * every step that can fail does so softly and leaves a warning, and a `fail`
 * handler catches anything that still gets through.
 */
export function registerFailureCapture(options: FailureCaptureOptions = {}): void {
  afterEach(function (this: Mocha.Context) {
    if (this.currentTest?.state !== 'failed') return;

    // cy.on binds to the current runnable, so this covers the hook and is gone
    // by the next test. Returning false abandons the hook's remaining commands,
    // which is why it is only the backstop.
    cy.on('fail', (error: Error) => {
      Cypress.log({ name: 'annotate', message: `! Failure capture gave up: ${error.message}` });
      return false;
    });

    // Read inside the hook rather than at registration: the support file is
    // evaluated before Cypress has finished setting up env for the spec.
    const defaults = readAnnotateConfig();
    const reportPath = options.reportPath ?? defaults.reportPath ?? DEFAULT_REPORT_PATH;

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
     *
     * The scroll is done synchronously on the element just measured. A cy.get
     * here would re-query, and if the page re-rendered in between it would
     * wait out the whole command timeout and then fail the hook.
     */
    function prepare(win: Window): Prepared {
      const selector = recovered.selector && !recovered.elementNotFound ? recovered.selector : null;
      let target = selector ? measureTargets(win, [selector]).targets[0] : undefined;

      if (selector && target?.found && target.rect && !isFullyVisible(target.rect, win)) {
        const el = win.document.querySelector(selector);
        if (el) {
          const offset = defaults.scrollOffset ?? 120;
          el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
          win.scrollBy({ top: -offset, behavior: 'instant' });
          // The rect from before the scroll is meaningless now.
          target = measureTargets(win, [selector]).targets[0];
        }
      }

      const resolved = Boolean(target?.found && target.rect);
      return {
        target: target ?? null,
        resolved,
        inventory: resolved ? null : collectInventory(win),
        metrics: readMetrics(win),
      };
    }

    cy.window({ log: false })
      .then((win) => cy.wrap(prepare(win), { log: false }))
      .then(({ target, resolved, inventory, metrics }) => {
        let screenshotPath: string | undefined;
        let captureReport: CaptureReport | undefined;

        return cy
          .screenshot(name, {
            capture: 'viewport',
            overwrite: true,
            log: false,
            onAfterScreenshot(_el, props) {
              screenshotPath = props.path;
              // Cypress sets `scaled` at runtime but leaves it out of its types.
              // Without it, send nothing and let the scale be inferred as before.
              const scaled = (props as { scaled?: unknown }).scaled;
              if (typeof scaled === 'boolean') captureReport = { pixelRatio: props.pixelRatio, scaled };
            },
          })
          .then(() => {
            if (!screenshotPath) {
              throw new Error('registerFailureCapture: Cypress did not report a screenshot path.');
            }
            if (!resolved) {
              return cy.wrap<SoftResult<AnnotateTaskResult> | null>(null, { log: false }) as Cypress.Chainable<
                SoftResult<AnnotateTaskResult> | null
              >;
            }

            return cy.task('annotateScreenshotSoft', {
              screenshotPath,
              measurement: { metrics, targets: [target!] },
              captureReport,
              labels: [label],
              capture: 'viewport',
              style: { ...defaults.style, ...options.style },
              keepRaw: defaults.keepRaw,
              manifestPath: defaults.manifestPath,
              spec: Cypress.spec.relative,
              test: testTitle,
            }, { log: false }) as Cypress.Chainable<SoftResult<AnnotateTaskResult> | null>;
          })
          .then((soft: SoftResult<AnnotateTaskResult> | null) => {
            const annotateResult = soft && 'result' in soft ? soft.result : null;
            const warnings = [...(annotateResult?.warnings ?? [])];
            if (soft && 'error' in soft) {
              warnings.push(`Annotating the screenshot failed, so it was kept as it was: ${soft.error}`);
            }
            for (const warning of warnings) {
              Cypress.log({ name: 'annotate', message: `! ${warning}` });
            }

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
              warnings,
              timestamp: new Date().toISOString(),
            };

            return cy
              .task<SoftResult<null>>('appendFailureRecord', { reportPath, record }, { log: false })
              .then((written) => {
                if ('error' in written) {
                  Cypress.log({ name: 'annotate', message: `! Could not write ${reportPath}: ${written.error}` });
                }
              });
          });
      });
  });
}
