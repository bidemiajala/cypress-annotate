/**
 * Every test in this spec is meant to fail - that is what's under test. Run it
 * with `npm run test:cypress-failures`, which tolerates the non-zero exit and
 * then checks out/cypress/failures.json for correctness, rather than trusting
 * that a file merely exists.
 */
describe('failure capture', () => {
  it('text mismatch with a diffable assertion', () => {
    cy.visit('/buggy-checkout.html');
    cy.get('#grand-total-value').should('have.text', 'THIS WILL NOT MATCH');
  });

  it('text mismatch with a non-diffable assertion', () => {
    cy.visit('/buggy-checkout.html');
    cy.get('#promo-apply').should('contain', 'NOPE');
  });

  it('element that never appears', () => {
    cy.visit('/buggy-checkout.html');
    cy.get('#does-not-exist', { timeout: 500 }).should('be.visible');
  });

  it('a failure with no recoverable selector at all', () => {
    cy.visit('/buggy-checkout.html');
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(2).to.equal(3);
  });
});

/**
 * The hook runs in an afterEach, and a failing afterEach makes Cypress skip
 * every remaining test in the spec. These break the hook's own steps on
 * purpose. The last test only produces a record if the spec kept going.
 */
describe('failure capture that goes wrong itself', () => {
  const projectDefaults = Cypress.env('annotate') as Record<string, unknown> | undefined;

  // Restored before each test, because the hook reads env after the test ends
  // and a describe-level afterEach would run before it.
  beforeEach(() => {
    Cypress.env('annotate', projectDefaults);
  });

  it('a failing element below the fold', () => {
    cy.visit('/test-page.html');
    cy.get('#target-below-fold').should('have.class', 'NOPE');
  });

  it('annotating throws inside the task', () => {
    // A path under a file, so the manifest write fails with ENOTDIR.
    Cypress.env('annotate', { ...projectDefaults, manifestPath: 'package.json/annotations.json' });
    cy.visit('/buggy-checkout.html');
    cy.get('#grand-total-value').should('have.text', 'ANNOTATE WILL THROW');
  });

  it('writing the failure report throws', () => {
    Cypress.env('annotate', { ...projectDefaults, reportPath: 'package.json/failures.json' });
    cy.visit('/buggy-checkout.html');
    cy.get('#grand-total-value').should('have.text', 'REPORT WILL THROW');
  });

  it('the next failure is still captured', () => {
    cy.visit('/buggy-checkout.html');
    cy.get('#promo-apply').should('contain', 'STILL RUNNING');
  });
});
