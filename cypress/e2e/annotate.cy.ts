import type { AnnotateTaskResult } from '../../src/cypress/task.js';
import type { PixelRect } from '../../src/types.js';

/**
 * These assert pixel accuracy, not just that a file was produced.
 *
 * Fixture targets are painted a flat unique colour, so the annotated image is
 * scanned for that colour and the recovered box is compared against the box the
 * plugin computed. A screenshot that merely exists proves nothing.
 */

const TOLERANCE_PX = 2;

const PAGE_BACKGROUND = '#F4F5F7';

/**
 * Zero padding so the drawn box is exactly the element's border box, which is
 * what the painted pixels represent. Any padding would show up as drift.
 */
const EXACT = { style: { padding: 0 }, keepRaw: true } as const;

/**
 * Assert the box sits exactly on `selector`'s painted pixels.
 *
 * Three checks together close the loop. The box centre must not be page
 * background, so a box over empty space fails. The painted region must match
 * the drawn rect, so the box must be on whatever it points at. And the painted
 * region's CSS size must match the element's own `getBoundingClientRect()`,
 * read independently through jQuery, so the box must be on *this* element and
 * not some other coloured one.
 */
function expectBoxOnTarget(result: AnnotateTaskResult, selector: string): void {
  expect(result.rawPath, 'raw image kept for scanning').to.be.a('string');
  const rect = result.drawnRects[0];
  expect(rect, 'a rect was drawn').to.not.equal(undefined);

  const probe = {
    x: Math.round(rect!.x + rect!.width / 2),
    y: Math.round(rect!.y + rect!.height / 2),
  };

  cy.task<{ sampled: string; backgroundDistance: number; painted: PixelRect | null }>(
    'probeAndScan',
    { path: result.rawPath, probe, background: PAGE_BACKGROUND },
  ).then(({ sampled, backgroundDistance, painted }) => {
    expect(backgroundDistance, `box centre sampled ${sampled}, distance from page background`).to.be
      .greaterThan(60);
    expect(painted, 'painted region found').to.not.equal(null);

    cy.get(selector)
      .first()
      .then(($el) => {
        const dom = $el[0]!.getBoundingClientRect();
        expect(painted!.width / result.scale, 'painted width in CSS px').to.be.closeTo(dom.width, 2);
        expect(painted!.height / result.scale, 'painted height in CSS px').to.be.closeTo(dom.height, 2);
      });

    cy.task<number>('driftAgainst', {
      computed: rect,
      painted,
      width: result.width,
      height: result.height,
    }).then((drift) => {
      expect(drift, 'max edge drift in px').to.be.lessThan(TOLERANCE_PX);
    });
  });
}

describe('cy.annotate', () => {
  it('draws a box on the exact pixels of an element above the fold', () => {
    cy.visit('/test-page.html');
    cy.annotate('#target-top', { ...EXACT, label: 'Above the fold', name: 'above-fold' }).then(
      (result) => {
        expect(result.warnings, 'no warnings').to.deep.equal([]);
        expectBoxOnTarget(result, '#target-top');
      },
    );
  });

  it('scrolls a below-the-fold element into view and still lands on it', () => {
    cy.visit('/test-page.html');
    cy.annotate('#target-below-fold', { ...EXACT, label: 'Below the fold', name: 'below-fold' }).then(
      (result) => {
        expectBoxOnTarget(result, '#target-below-fold');
      },
    );
  });

  it('handles a transformed element, whose painted box is the post-transform one', () => {
    cy.visit('/test-page.html');
    cy.annotate('#target-transformed', { ...EXACT, name: 'transformed' }).then((result) => {
      expectBoxOnTarget(result, '#target-transformed');
    });
  });

  it('crops to the element with the surroundings dimmed', () => {
    cy.visit('/test-page.html');
    cy.annotate('#target-top', {
      ...EXACT,
      label: 'Cropped close-up',
      crop: true,
      cropPadding: 60,
      name: 'cropped',
    }).then((result) => {
      // The crop must be smaller than the viewport capture but still contain
      // the target plus its padding.
      expect(result.width).to.be.lessThan(1280 * result.scale);
      expectBoxOnTarget(result, '#target-top');
    });
  });

  it('reports an ambiguous selector rather than silently picking one', () => {
    cy.visit('/test-page.html');
    cy.annotate('.target', { ...EXACT, name: 'ambiguous' }).then((result) => {
      expect(result.warnings.join(' ')).to.match(/matched \d+ elements/);
    });
  });

  it('annotates several elements in one shot', () => {
    cy.visit('/buggy-checkout.html');
    cy.annotate(['#promo-apply', '#order-ref'], {
      label: ['Apply button escapes its card', 'Order reference overflows'],
      name: 'checkout-bugs',
    }).then((result) => {
      expect(result.drawnRects).to.have.length(2);
      expect(result.warnings, 'no warnings').to.deep.equal([]);
    });
  });

  it('fails loudly when the selector matches nothing', () => {
    cy.visit('/test-page.html');
    cy.on('fail', (error) => {
      expect(error.message).to.match(/no element matched|Timed out/);
      return false;
    });
    cy.annotate('#definitely-not-here', { scrollIntoView: false, name: 'missing' });
  });
});
