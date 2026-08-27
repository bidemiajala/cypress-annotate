/**
 * Recover the selector a failed Cypress command was operating on, and the
 * expected/actual values, without parsing a guessed error format.
 *
 * Verified empirically against real Cypress 15.19 output (see
 * scripts/test-failure-selector.ts, which replays captured error objects):
 *
 *   cy.get('#grand-total-value').should('have.text', 'X')  fails with
 *     err.expected = 'X', err.actual = '£244.99'                (diffable assertions only)
 *     err.message  = "expected '<span#grand-total-value>' to have text 'X', but the text was '£244.99'"
 *     cy.state('current').get('name') = 'get'
 *     cy.state('current').get('args') = ['#grand-total-value']
 *
 *   cy.get('#promo-apply').should('contain', 'X')  fails with
 *     err.expected / err.actual absent (chai's contain assertion is not diffable)
 *     err.message  = "expected '<button#promo-apply>' to contain 'X'"
 *
 *   cy.get('#missing').should('be.visible')  fails with
 *     err.message  = "Expected to find element: `#missing`, but never found it."
 */

export interface CypressLikeError {
  name?: string;
  message?: string;
  expected?: string;
  actual?: string;
}

/** Minimal shape of what cy.state('current') exposes, read defensively. */
export interface CommandLike {
  get(key: 'name'): string | undefined;
  get(key: 'args'): unknown[] | undefined;
}

export interface RecoveredFailure {
  /** CSS selector the failing command targeted, if one could be recovered. */
  selector: string | null;
  /** How it was recovered - for diagnostics, not behaviour. */
  source: 'command-state' | 'message-selector' | 'message-not-found' | 'none';
  expected: string | null;
  actual: string | null;
  /** True for "element never existed" failures - there is nothing to box. */
  elementNotFound: boolean;
}

/**
 * Chai stores `err.expected`/`err.actual` as chai's own `inspect()` rendering
 * of the value, not the raw value - for a string that means it arrives wrapped
 * in its own single quotes: `err.expected` for `.should('have.text', 'X')` is
 * the string `'X'` with its quote marks, not `X`. Confirmed against a real Cypress
 * 15.19 run (see scripts/test-failure-selector.ts) rather than assumed.
 */
function unquote(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = value.match(/^'(.*)'$/s);
  return match ? (match[1] ?? '') : value;
}

/** Cypress commands whose first argument is a locator. */
const LOCATOR_COMMANDS = new Set(['get', 'find', 'contains']);

function firstStringArg(args: unknown[] | undefined): string | null {
  if (!args) return null;
  const value = args.find((a): a is string => typeof a === 'string');
  return value ?? null;
}

/**
 * chai-jquery renders a matched element as `<tag#id>` or `<tag.class>` inside
 * its assertion messages. This is part of chai-jquery's public message format,
 * not an accident of one version, but it is still text-parsing - used only when
 * cy.state('current') did not resolve.
 */
function selectorFromMessage(message: string): string | null {
  const match = message.match(/<([a-z][a-z0-9]*)(#[\w-]+|\.[\w-]+)?>/i);
  if (!match) return null;
  const [, tag, qualifier] = match;
  return qualifier ? qualifier : (tag ?? null);
}

function notFoundSelector(message: string): string | null {
  // "Expected to find element: `#missing`, but never found it."
  const match = message.match(/Expected to find element:\s*`([^`]+)`/);
  return match?.[1] ?? null;
}

export function recoverFailure(err: CypressLikeError | undefined, current: CommandLike | null): RecoveredFailure {
  const message = err?.message ?? '';
  const elementNotFound = /but never found it|Expected to find element/.test(message);

  let selector: string | null = null;
  let source: RecoveredFailure['source'] = 'none';

  const commandName = current?.get('name');
  if (commandName && LOCATOR_COMMANDS.has(commandName)) {
    const fromState = firstStringArg(current?.get('args'));
    if (fromState) {
      selector = fromState;
      source = 'command-state';
    }
  }

  if (!selector && elementNotFound) {
    const found = notFoundSelector(message);
    if (found) {
      selector = found;
      source = 'message-not-found';
    }
  }

  if (!selector) {
    const found = selectorFromMessage(message);
    if (found) {
      selector = found;
      source = 'message-selector';
    }
  }

  return {
    selector,
    source,
    expected: unquote(err?.expected),
    actual: unquote(err?.actual),
    elementNotFound,
  };
}

/** One-line label for the annotation, built entirely from what was recovered. */
export function describeFailure(err: CypressLikeError | undefined, recovered: RecoveredFailure): string {
  if (recovered.expected !== null && recovered.actual !== null) {
    return `Expected "${recovered.expected}" but got "${recovered.actual}"`;
  }
  if (recovered.elementNotFound) {
    return `Element never appeared: ${recovered.selector ?? 'unknown selector'}`;
  }
  // No diffable values (e.g. a `contain` assertion) - the message itself
  // already states expected vs. found, just less structured.
  const message = err?.message ?? 'Assertion failed';
  return message.replace(/^Timed out retrying after \d+ms:\s*/, '');
}
