/**
 * Exercises failure-selector.ts against error objects captured from a real
 * Cypress 15.19 run (see cypress/e2e/probe-failure.cy.ts, now deleted - its
 * output is reproduced here as fixtures so this stays fast and needs no
 * browser). If Cypress ever changes this error shape, this is what will show
 * it, since these are not hand-written guesses.
 */
import assert from 'node:assert/strict';
import { describeFailure, recoverFailure, type CommandLike } from '../src/cypress/failure-selector.js';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

function command(name: string, args: unknown[]): CommandLike {
  return {
    get: ((key: string) => (key === 'name' ? name : key === 'args' ? args : undefined)) as CommandLike['get'],
  };
}

// Recorded verbatim from a real Cypress 15.19 run (out/cypress/failures.json,
// produced by cypress/e2e/failure-capture.cy.ts). err.expected/err.actual are
// chai's own quoted rendering, not the raw values - confirmed by that run, not
// assumed, after an earlier version of this file guessed wrong and shipped a
// label reading `Expected "'THIS WILL NOT MATCH'" but got "'£244.99'"`.
const HAVE_TEXT_ERROR = {
  name: 'AssertionError',
  message:
    "Timed out retrying after 4000ms: expected '<span#grand-total-value>' to have text 'THIS WILL NOT MATCH', but the text was '£244.99'",
  expected: "'THIS WILL NOT MATCH'",
  actual: "'£244.99'",
};

const CONTAIN_ERROR = {
  name: 'AssertionError',
  message: "Timed out retrying after 4000ms: expected '<button#promo-apply>' to contain 'NOPE'",
};

const NOT_FOUND_ERROR = {
  name: 'AssertionError',
  message: 'Timed out retrying after 1000ms: Expected to find element: `#does-not-exist`, but never found it.',
};

check('recovers the selector from cy.state when available', () => {
  const recovered = recoverFailure(HAVE_TEXT_ERROR, command('get', ['#grand-total-value']));
  assert.equal(recovered.selector, '#grand-total-value');
  assert.equal(recovered.source, 'command-state');
});

check('reads expected/actual off the error object, unwrapped from chai quoting', () => {
  const recovered = recoverFailure(HAVE_TEXT_ERROR, command('get', ['#grand-total-value']));
  assert.equal(recovered.expected, 'THIS WILL NOT MATCH');
  assert.equal(recovered.actual, '£244.99');
  assert.equal(recovered.elementNotFound, false);
});

check('a value that is not chai-quoted is passed through unchanged', () => {
  const recovered = recoverFailure(
    { name: 'AssertionError', message: 'x', expected: '5', actual: '3' },
    null,
  );
  assert.equal(recovered.expected, '5');
  assert.equal(recovered.actual, '3');
});

check('falls back to message parsing when command state is unavailable', () => {
  const recovered = recoverFailure(CONTAIN_ERROR, null);
  assert.equal(recovered.selector, '#promo-apply');
  assert.equal(recovered.source, 'message-selector');
});

check('a non-diffable assertion (contain) has no expected/actual on the error', () => {
  const recovered = recoverFailure(CONTAIN_ERROR, command('get', ['#promo-apply']));
  assert.equal(recovered.expected, null);
  assert.equal(recovered.actual, null);
});

check('an existence failure is flagged, with the selector still recovered', () => {
  const recovered = recoverFailure(NOT_FOUND_ERROR, command('get', ['#does-not-exist', {}]));
  assert.equal(recovered.selector, '#does-not-exist');
  assert.equal(recovered.elementNotFound, true);
});

check('existence failure recovers via message when command state is missing', () => {
  const recovered = recoverFailure(NOT_FOUND_ERROR, null);
  assert.equal(recovered.selector, '#does-not-exist');
  assert.equal(recovered.source, 'message-not-found');
});

check('a command targeting a non-locator does not falsely claim its args', () => {
  // e.g. cy.wait(1000).should(...) - 'wait' is not a locator command, so a
  // numeric arg must never be mistaken for a selector.
  const recovered = recoverFailure(CONTAIN_ERROR, command('wait', [1000]));
  // Falls through to message parsing rather than treating 1000 as a selector.
  assert.equal(recovered.selector, '#promo-apply');
  assert.equal(recovered.source, 'message-selector');
});

check('nothing recoverable yields selector: null, not a throw', () => {
  const recovered = recoverFailure({ name: 'Error', message: 'the network request failed' }, null);
  assert.equal(recovered.selector, null);
  assert.equal(recovered.source, 'none');
});

check('describeFailure prefers expected/actual when both are present', () => {
  const recovered = recoverFailure(HAVE_TEXT_ERROR, command('get', ['#grand-total-value']));
  assert.equal(describeFailure(HAVE_TEXT_ERROR, recovered), 'Expected "THIS WILL NOT MATCH" but got "£244.99"');
});

check('describeFailure names the selector for an existence failure', () => {
  const recovered = recoverFailure(NOT_FOUND_ERROR, command('get', ['#does-not-exist']));
  assert.equal(describeFailure(NOT_FOUND_ERROR, recovered), 'Element never appeared: #does-not-exist');
});

check('describeFailure falls back to a cleaned message for non-diffable assertions', () => {
  const recovered = recoverFailure(CONTAIN_ERROR, command('get', ['#promo-apply']));
  assert.equal(
    describeFailure(CONTAIN_ERROR, recovered),
    "expected '<button#promo-apply>' to contain 'NOPE'",
  );
});

console.log(`\n${passed}/${passed + failed} failure-selector checks passed.\n`);
process.exit(failed === 0 ? 0 : 1);
