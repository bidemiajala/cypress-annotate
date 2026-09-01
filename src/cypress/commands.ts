/// <reference types="cypress" />
import {
  measureTargets,
  describeTarget,
  type AnnotateTargetSpec,
  type DomMeasurement,
} from './measure-dom.js';
import { isFullyVisible, scrollIntoViewIfNeeded } from './scroll-into-view.js';
import { readAnnotateConfig } from './config.js';
import type { AnnotateTaskResult } from './task.js';
import type { AnnotationStyle, ShapeKind } from '../types.js';

/**
 * Registers cy.annotate(). Import once from cypress/support/e2e.ts:
 *
 *   import 'cypress-annotate/cypress/commands';
 *
 * The command exists mainly to enforce an ordering that is easy to get wrong by
 * hand: scroll, then measure, then screenshot, with nothing in between. Every
 * rectangle is only valid for the scroll position it was measured at.
 */

/**
 * Every field here can also be set once for the whole project, under
 * `env.annotate` in cypress.config. A value passed to a single call wins over
 * the project default, which wins over the built-in one.
 */
export interface AnnotateCommandOptions {
  /** One per selector, in order. */
  label?: string | string[];
  /** Screenshot name; defaults to a slug of the first selector. */
  name?: string;
  /** Crop to the element, keeping `cropPadding` of context. Good for a ticket. */
  crop?: boolean;
  cropPadding?: number;
  shape?: ShapeKind;
  style?: AnnotationStyle;
  /** Bring the first target into view if it is not already. Default true. */
  scrollIntoView?: boolean;
  /**
   * When scrolling is needed, leave this many CSS px above the element. Cypress
   * otherwise scrolls it flush to the top of the viewport, where a fixed header
   * covers the very thing being annotated. Default 120.
   */
  scrollOffset?: number;
  /** Keep the un-annotated image alongside, for assertions. */
  keepRaw?: boolean;
  /**
   * Capture the whole document rather than the viewport. Off by default and
   * best avoided: Cypress builds a full-page screenshot by scrolling and
   * stitching, which paints position:fixed and sticky elements repeatedly.
   */
  fullPage?: boolean;
}

export type { AnnotateTargetSpec };

function slugify(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'annotated';
}

Cypress.Commands.add(
  'annotate',
  (target: AnnotateTargetSpec | AnnotateTargetSpec[], options: AnnotateCommandOptions = {}) => {
    // Project defaults from env.annotate in cypress.config, so a team sets its
    // colour once. Anything passed here wins over them.
    const defaults = readAnnotateConfig();
    const specs = Array.isArray(target) ? target : [target];
    const labels = options.label === undefined
      ? []
      : Array.isArray(options.label)
        ? options.label
        : [options.label];
    const first0 = specs[0];
    const name = options.name ?? slugify(first0 === undefined ? 'annotated' : describeTarget(first0));
    const capture = options.fullPage ? 'fullPage' : 'viewport';

    return cy
      .window({ log: false })
      .then((win) => {
        const initial = measureTargets(win, specs);
        const first = initial.targets[0];

        // Only scroll when the element genuinely is not fully visible. Cypress's
        // scrollIntoView always scrolls, so calling it unconditionally moves a
        // perfectly visible element under a sticky header for no reason.
        const needsScroll =
          options.scrollIntoView !== false &&
          first?.found === true &&
          first.rect !== undefined &&
          !isFullyVisible(first.rect, win);

        if (!needsScroll) return cy.wrap(initial, { log: false });

        // cy.scrollIntoView only reaches the top document, so a target inside a
        // frame is left where it is. The box is still drawn correctly; it may
        // just sit outside a viewport capture.
        const firstSpec = specs[0];
        if (typeof firstSpec !== 'string') return cy.wrap(initial, { log: false });

        return scrollIntoViewIfNeeded(firstSpec, options.scrollOffset ?? defaults.scrollOffset ?? 120)
          // Re-measure: the rects from before the scroll are now meaningless.
          .then(() => cy.window({ log: false }).then((w) => measureTargets(w, specs)));
      })
      .then((measurement: DomMeasurement) => {
        let screenshotPath: string | undefined;

        return cy
          .screenshot(name, {
            capture,
            overwrite: true,
            log: false,
            onAfterScreenshot(_el, props) {
              screenshotPath = props.path;
            },
          })
          .then(() => {
            if (!screenshotPath) {
              throw new Error('cy.annotate: Cypress did not report a screenshot path.');
            }
            return cy.task<AnnotateTaskResult>('annotateScreenshot', {
              screenshotPath,
              measurement,
              labels,
              capture,
              crop: options.crop ?? defaults.crop,
              cropPadding: options.cropPadding ?? defaults.cropPadding,
              shape: options.shape ?? defaults.shape,
              style: { ...defaults.style, ...options.style },
              keepRaw: options.keepRaw ?? defaults.keepRaw,
              manifestPath: defaults.manifestPath,
              spec: Cypress.spec.relative,
              test: Cypress.currentTest?.titlePath?.join(' > ') ?? name,
            });
          })
          .then((result: AnnotateTaskResult) => {
            for (const warning of result.warnings) {
              Cypress.log({ name: 'annotate', message: `! ${warning}` });
            }
            return result;
          });
      });
  },
);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      /**
       * Screenshot the page with an accurate box drawn around the target.
       *
       * A target is a CSS selector, or `{ frame, selector }` to reach into one
       * or more nested iframes. An array annotates several at once.
       *
       *   cy.annotate('#promo-apply')
       *   cy.annotate({ frame: 'iframe#checkout', selector: '.pay-button' })
       *   cy.annotate(['#total', { frame: 'iframe#checkout', selector: '.pay' }])
       *
       * Yields the annotation result, including where the box was drawn.
       */
      annotate(
        target: AnnotateTargetSpec | AnnotateTargetSpec[],
        options?: AnnotateCommandOptions,
      ): Chainable<AnnotateTaskResult>;
    }
  }
}
