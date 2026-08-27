/// <reference types="cypress" />

/** Fully on-screen, not merely intersecting - the bar cy.annotate() and the failure hook both use. */
export function isFullyVisible(
  rect: { x: number; y: number; width: number; height: number },
  win: Window,
): boolean {
  return (
    rect.y >= 0 &&
    rect.x >= 0 &&
    rect.y + rect.height <= win.innerHeight &&
    rect.x + rect.width <= win.innerWidth
  );
}

/**
 * Scroll `selector` into view only if it genuinely is not fully visible, and
 * leave clearance above it so a fixed header does not end up covering the very
 * thing being annotated. Cypress's own `scrollIntoView()` scrolls
 * unconditionally and flush to the top, which is wrong for both cases.
 */
export function scrollIntoViewIfNeeded(
  selector: string,
  offset = 120,
): Cypress.Chainable<JQuery<HTMLElement>> {
  return cy.get(selector, { log: false }).first().scrollIntoView({ log: false, offset: { top: -offset, left: 0 } });
}
