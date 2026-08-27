/**
 * Tier 2: explains the failures registerFailureCapture could not resolve on
 * its own. Reads the same failures.json the live Cypress run wrote, calls
 * Claude only for the unresolved entries, and draws a box using the rect
 * already captured live at failure time — no browser is opened here, because
 * by now there is nothing left to open one against.
 *
 * `--replay <file>` swaps the Claude call for recorded explanations, mirroring
 * find-bugs.ts's --replay, so this is testable without an API key.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { annotateImage } from '../src/annotate-image.js';
import { measureRegion } from '../src/measure.js';
import {
  ClaudeFailureExplainer,
  ReplayFailureExplainer,
  type FailureExplainer,
  type FailureExplanation,
} from '../src/cypress/failure-explainer.js';
import type { FailureRecord } from '../src/cypress/failure-report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

function loadDotEnv(): void {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const USAGE = `
Usage: npm run explain-failures -- [options]

  --report <path>    failures.json from a Cypress run. Default out/cypress/failures.json
  --out-dir <path>   Where to write annotated images. Default out/cypress/explained
  --replay <file>    JSON map of test title -> explanation, instead of calling Claude.
  --model <id>       Default claude-opus-5
  --effort <level>   low | medium | high | xhigh | max. Default medium
`.trim();

const { values } = parseArgs({
  options: {
    report: { type: 'string', default: 'out/cypress/failures.json' },
    'out-dir': { type: 'string', default: 'out/cypress/explained' },
    replay: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

function slugify(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'failure';
}

const records = JSON.parse(await readFile(values.report, 'utf8')) as FailureRecord[];
const unresolved = records.filter((r) => !r.resolved);

if (unresolved.length === 0) {
  console.log('Nothing to explain — every failure already resolved deterministically.');
  process.exit(0);
}

let explainer: FailureExplainer;
if (values.replay) {
  const recorded = JSON.parse(await readFile(values.replay, 'utf8')) as Record<string, FailureExplanation>;
  explainer = {
    async explain(record: FailureRecord) {
      const found = recorded[record.test];
      if (!found) throw new Error(`No recorded explanation for test "${record.test}" in ${values.replay}`);
      return found;
    },
  };
  console.log(`Replaying ${Object.keys(recorded).length} recorded explanations (no API call).\n`);
} else {
  loadDotEnv();
  explainer = new ClaudeFailureExplainer({
    model: values.model,
    effort: values.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
  });
}

await mkdir(values['out-dir'], { recursive: true });

console.log(`${unresolved.length} unresolved failure(s) to explain.\n`);

for (const record of unresolved) {
  console.log(`- ${record.test}`);
  console.log(`  ${record.errMessage.slice(0, 100)}`);

  let explanation: FailureExplanation;
  try {
    explanation = await explainer.explain(record);
  } catch (error) {
    console.log(`  ! ${error instanceof Error ? error.message : String(error)}\n`);
    continue;
  }

  const match = record.inventory?.find((item) => item.selector === explanation.selector);
  if (!match && !explanation.region) {
    console.log(`  ! Model named a selector not in the inventory and gave no region; skipping.\n`);
    continue;
  }

  const image = await readFile(record.screenshotPath);
  const viewportRect = match?.rect ?? measureRegion(explanation.region!, record.metrics).viewportRect;

  const result = await annotateImage(
    image,
    [{ viewportRect, label: explanation.label, describe: match?.selector ?? 'region' }],
    { metrics: record.metrics, capture: 'viewport', style: { dimOutside: 0.45 } },
  );

  const outPath = join(values['out-dir'], `${slugify(record.test)}.png`);
  await writeFile(outPath, result.image);
  console.log(`  -> ${match ? match.selector : 'region fallback'}: ${explanation.label}`);
  console.log(`  wrote ${outPath}\n`);
}
