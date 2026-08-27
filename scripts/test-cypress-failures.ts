/**
 * Runs the deliberately-failing spec (expected non-zero exit), then checks
 * out/cypress/failures.json for correctness. Two separate exit codes matter
 * here for different reasons, so they cannot share one `cypress run` call:
 * Cypress exiting non-zero is the expected, healthy outcome; a failure to
 * *produce a correct report* is the actual thing under test.
 */
import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

await rm('out/cypress/failures.json', { force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const run = spawnSync('npx', ['cypress', 'run', '--e2e', '--spec', 'cypress/e2e/failure-capture.cy.ts'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

if (run.status === 0) {
  console.error('\nExpected the failure-capture spec to fail (that is the point of it) but it passed.\n');
  process.exit(1);
}

console.log('\n(The failures above are expected - verifying the capture they produced.)\n');

const verify = spawnSync('npx', ['tsx', 'scripts/verify-cypress-failures.ts'], { stdio: 'inherit' });
process.exit(verify.status ?? 1);
