/**
 * Checks out/cypress/failures.json against what cypress/e2e/failure-capture.cy.ts
 * is known to produce. The pixel-alignment math is already proven by
 * verify.ts/verify-image.ts (annotateScreenshot is the same annotateImage
 * underneath) - what's new here is the failure-hook's own logic: does it
 * recover the right selector, build the right label, and route correctly
 * between the deterministic and inventory-fallback paths.
 */
import { access, readFile } from 'node:fs/promises';
import type { FailureRecord } from '../src/cypress/failure-report.js';

const REPORT_PATH = 'out/cypress/failures.json';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS  ${name}`);
    passed++;
  } else {
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
    failed++;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function findRecord(records: FailureRecord[], titleContains: string): FailureRecord | undefined {
  return records.find((r) => r.test.includes(titleContains));
}

async function main(): Promise<void> {
  const raw = await readFile(REPORT_PATH, 'utf8').catch(() => null);
  if (!raw) {
    console.log(`FAIL  ${REPORT_PATH} does not exist - did the failing spec even run?`);
    process.exit(1);
  }
  const records = JSON.parse(raw) as FailureRecord[];

  // Eight tests fail. One of them breaks the report write, so it leaves none.
  check('exactly 7 failures recorded', records.length === 7, `got ${records.length}`);

  const diffable = findRecord(records, 'diffable assertion');
  check('diffable case: found', Boolean(diffable));
  if (diffable) {
    check('diffable: selector recovered', diffable.selector === '#grand-total-value', diffable.selector ?? 'null');
    check('diffable: recovered via command state', diffable.selectorSource === 'command-state');
    check('diffable: expected/actual captured', diffable.expected === 'THIS WILL NOT MATCH' && diffable.actual === '£244.99');
    check('diffable: label uses expected/actual', diffable.label === 'Expected "THIS WILL NOT MATCH" but got "£244.99"', diffable.label);
    check('diffable: resolved', diffable.resolved === true);
    check('diffable: annotated image path set', typeof diffable.annotatedPath === 'string');
    check('diffable: a rect was drawn', diffable.drawnRect !== null);
    check('diffable: no inventory needed', diffable.inventory === null);
    if (diffable.annotatedPath) {
      check('diffable: annotated file actually exists', await exists(diffable.annotatedPath));
    }
  }

  const nonDiffable = findRecord(records, 'non-diffable assertion');
  check('non-diffable case: found', Boolean(nonDiffable));
  if (nonDiffable) {
    check('non-diffable: selector recovered', nonDiffable.selector === '#promo-apply', nonDiffable.selector ?? 'null');
    check('non-diffable: no expected/actual on a contain assertion', nonDiffable.expected === null && nonDiffable.actual === null);
    check('non-diffable: still resolved (element exists live)', nonDiffable.resolved === true);
    check('non-diffable: label falls back to the cleaned message', nonDiffable.label.includes('to contain'), nonDiffable.label);
  }

  const notFound = findRecord(records, 'never appears');
  check('not-found case: found', Boolean(notFound));
  if (notFound) {
    check('not-found: flagged as element-not-found', notFound.elementNotFound === true);
    check('not-found: selector still named', notFound.selector === '#does-not-exist', notFound.selector ?? 'null');
    check('not-found: not resolved (nothing to measure)', notFound.resolved === false);
    check('not-found: no annotated image', notFound.annotatedPath === null);
    check('not-found: falls back to inventory', Array.isArray(notFound.inventory) && notFound.inventory.length > 0);
    check('not-found: label names the selector', notFound.label.includes('#does-not-exist'), notFound.label);
  }

  const unrecoverable = findRecord(records, 'no recoverable selector');
  check('unrecoverable case: found', Boolean(unrecoverable));
  if (unrecoverable) {
    check('unrecoverable: no selector recovered', unrecoverable.selector === null, unrecoverable.selector ?? 'set');
    check('unrecoverable: not resolved', unrecoverable.resolved === false);
    check('unrecoverable: falls back to inventory anyway', Array.isArray(unrecoverable.inventory) && unrecoverable.inventory.length > 0);
  }

  const belowFold = findRecord(records, 'below the fold');
  check('below-fold case: found', Boolean(belowFold));
  if (belowFold) {
    const { metrics, drawnRect } = belowFold;
    check('below-fold: resolved', belowFold.resolved === true);
    check('below-fold: page was scrolled to it', metrics.scrollY > 0, `scrollY ${metrics.scrollY}`);
    const imageHeight = metrics.viewportHeight * metrics.devicePixelRatio;
    check(
      'below-fold: box lands inside the screenshot',
      drawnRect !== null && drawnRect.y >= 0 && drawnRect.y + drawnRect.height <= imageHeight,
      JSON.stringify(drawnRect),
    );
  }

  const annotateThrew = findRecord(records, 'annotating throws');
  check('annotate-throws case: still recorded', Boolean(annotateThrew));
  if (annotateThrew) {
    check('annotate-throws: no annotated path', annotateThrew.annotatedPath === null);
    check(
      'annotate-throws: warning says why',
      annotateThrew.warnings.some((w) => w.startsWith('Annotating the screenshot failed') && w.includes('ENOTDIR')),
      JSON.stringify(annotateThrew.warnings),
    );
  }

  check('report-throws case: nothing recorded, as expected', !findRecord(records, 'report throws'));
  check(
    'the spec kept running after the hook went wrong',
    Boolean(findRecord(records, 'next failure is still captured')),
  );

  console.log(`\n${passed}/${passed + failed} checks passed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
