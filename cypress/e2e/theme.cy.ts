import type { AnnotateTaskResult } from '../../src/cypress/task.js';

/**
 * Proves the env.annotate block in cypress.config reaches the pixels.
 *
 * A theme that silently does nothing is the failure mode worth testing for, so
 * this samples the drawn stroke out of the finished image rather than trusting
 * the options object it was built from. cypress.config sets #7C3AED at a 6px
 * stroke; the fat stroke is only there to give the sample somewhere safe to
 * land.
 */

const THEME_COLOR = '#7C3AED';
const OVERRIDE_COLOR = '#0A9E4A';

/** Sample the middle of the box's top stroke and say how far off `expected` it is. */
function expectStrokeColor(result: AnnotateTaskResult, expected: string, strokeWidth: number): void {
  const rect = result.drawnRects[0];
  expect(rect, 'a rect was drawn').to.not.equal(undefined);

  const probe = {
    x: Math.round(rect!.x + rect!.width / 2),
    y: Math.round(rect!.y + (strokeWidth * result.scale) / 2),
  };

  cy.task<{ sampled: string; backgroundDistance: number }>('probeAndScan', {
    path: result.outPath,
    probe,
    // probeAndScan reports distance from whatever colour it is handed, so
    // handing it the expected one turns it into a colour assertion.
    background: expected,
  }).then(({ sampled, backgroundDistance }) => {
    expect(backgroundDistance, `stroke sampled ${sampled}, expected ${expected}`).to.be.lessThan(40);
  });
}

describe('theming from cypress.config', () => {
  beforeEach(() => {
    cy.visit('/test-page.html');
  });

  it('draws in the project colour with no per-call style at all', () => {
    cy.annotate('#target-top', { name: 'theme-default' }).then((result) => {
      expectStrokeColor(result, THEME_COLOR, 6);
    });
  });

  it('lets a single call override the project colour', () => {
    cy.annotate('#target-top', {
      name: 'theme-override',
      style: { color: OVERRIDE_COLOR },
    }).then((result) => {
      // strokeWidth is not overridden, so the project's 6 still applies and the
      // two layers are proven to merge rather than replace one another.
      expectStrokeColor(result, OVERRIDE_COLOR, 6);
    });
  });
});
