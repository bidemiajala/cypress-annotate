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
