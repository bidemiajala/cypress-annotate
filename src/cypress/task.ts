import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { annotateImage, type MeasuredTarget } from '../annotate-image.js';
import type { AnnotationStyle, PixelRect, ShapeKind } from '../types.js';
import type { DomMeasurement } from './measure-dom.js';
import { appendFailureRecord, appendRecord, type FailureRecord } from './failure-report.js';
import { DEFAULT_MANIFEST_PATH } from './config.js';

/**
 * The Node half of the Cypress plugin.
 *
 * Cypress tests run in the browser, where `sharp` cannot go, so compositing
 * happens here via cy.task(). All the coordinate maths is `annotateImage`, the
 * same code the Playwright and agent paths use.
 */

export interface AnnotateTaskArgs {
  screenshotPath: string;
  measurement: DomMeasurement;
  labels?: (string | undefined)[];
  capture?: 'viewport' | 'fullPage';
  crop?: boolean;
  cropPadding?: number;
  shape?: ShapeKind;
  style?: AnnotationStyle;
  /** Defaults to overwriting the screenshot, so reports show the annotated one. */
  outPath?: string;
  /** Also keep the un-annotated pixels, at `<out>.raw.png`. */
  keepRaw?: boolean;
  /** Where to record what was annotated. Defaults to out/cypress/annotations.json. */
  manifestPath?: string;
  /** Spec and test the annotation came from. Only used for the manifest. */
  spec?: string;
  test?: string;
}

/**
 * One line of the run's manifest. CI wants a list of what was produced without
 * having to walk the screenshots folder and guess which files are ours, and a
 * ticket wants to know which test a given image came from.
 */
export interface AnnotationRecord {
  spec: string | null;
  test: string | null;
  labels: string[];
  outPath: string;
  rawPath: string | null;
  width: number;
  height: number;
  drawnRects: PixelRect[];
  warnings: string[];
  timestamp: string;
}

export interface AnnotateTaskResult {
  outPath: string;
  rawPath: string | null;
  width: number;
  height: number;
  scale: number;
  drawnRects: PixelRect[];
  warnings: string[];
}

/**
 * Manifest paths already written to by this process. Cypress runs the whole of
 * `cypress run` in one Node process, so "first write of the process" is the
 * run boundary, and using it means no before:run handler is needed to clear
 * last run's records.
 */
const manifestsStarted = new Set<string>();

/** Whether the job summary's table header has been written yet this process. */
let summaryStarted = false;

async function appendStepSummary(record: AnnotationRecord): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const label = record.labels.join('; ') || '-';
  const warnings = record.warnings.length > 0 ? ` (${record.warnings.length} warning(s))` : '';
  const row =
    `| ${record.test ?? record.spec ?? '-'} ` +
    `| ${label.replace(/\|/g, '\\|')} ` +
    `| \`${relative(process.cwd(), record.outPath)}\`${warnings} |\n`;

  const header = summaryStarted
    ? ''
    : '### Annotated screenshots\n\n| Test | Label | Image |\n| --- | --- | --- |\n';
  summaryStarted = true;
  await appendFile(summaryPath, header + row);
}

async function recordAnnotation(manifestPath: string, record: AnnotationRecord): Promise<void> {
  if (!manifestsStarted.has(manifestPath)) {
    manifestsStarted.add(manifestPath);
    await rm(manifestPath, { force: true });
  }
  await appendRecord(manifestPath, record);
  await appendStepSummary(record);
}

export async function annotateScreenshot(args: AnnotateTaskArgs): Promise<AnnotateTaskResult> {
  const { screenshotPath, measurement } = args;
  if (!screenshotPath) throw new Error('annotateScreenshot: screenshotPath is required.');
  if (!measurement?.metrics) throw new Error('annotateScreenshot: measurement.metrics is required.');

  const warnings: string[] = [];
  const targets: MeasuredTarget[] = [];

  measurement.targets.forEach((target, i) => {
    if (!target.found || !target.rect) {
      warnings.push(`Selector "${target.selector}" was not measured: ${target.error ?? 'not found'}.`);
      return;
    }
    if ((target.matchCount ?? 1) > 1) {
      warnings.push(
        `Selector "${target.selector}" matched ${target.matchCount} elements; annotated the first.`,
      );
    }
    if (target.inViewport === false && (args.capture ?? 'viewport') === 'viewport') {
      warnings.push(
        `Selector "${target.selector}" was outside the viewport when measured; its box will be clipped.`,
      );
    }
    targets.push({
      viewportRect: target.rect,
      isFixed: target.isFixed,
      label: args.labels?.[i],
      shape: args.shape,
      describe: `Element "${target.selector}"`,
    });
  });

  if (targets.length === 0) {
    throw new Error(`annotateScreenshot: nothing to annotate. ${warnings.join(' ')}`);
  }

  const image = await readFile(screenshotPath);
  const result = await annotateImage(image, targets, {
    metrics: measurement.metrics,
    capture: args.capture ?? 'viewport',
    crop: args.crop,
    cropPadding: args.cropPadding,
    style: args.style,
  });

  const outPath = args.outPath ?? screenshotPath;
  let rawPath: string | null = null;
  if (args.keepRaw) {
    rawPath = outPath.replace(/\.png$/i, '') + '.raw.png';
    await writeFile(rawPath, result.rawImage);
  }
  await writeFile(outPath, result.image);

  const warningsOut = [...warnings, ...result.warnings];
  await recordAnnotation(args.manifestPath ?? DEFAULT_MANIFEST_PATH, {
    spec: args.spec ?? null,
    test: args.test ?? null,
    labels: (args.labels ?? []).filter((label): label is string => Boolean(label)),
    outPath,
    rawPath,
    width: result.width,
    height: result.height,
    drawnRects: result.drawnRects,
    warnings: warningsOut,
    timestamp: new Date().toISOString(),
  });

  return {
    outPath,
    rawPath,
    width: result.width,
    height: result.height,
    scale: result.scale,
    drawnRects: result.drawnRects,
    warnings: warningsOut,
  };
}

/**
 * Cypress's `on` is a set of overloads, one per event. Naming it precisely
 * would mean depending on Cypress's types, which this file deliberately avoids
 * so the task can be imported anywhere. A fully permissive signature accepts
 * any of those overloads; the narrowing cast is contained below.
 */
export type CypressPluginOn = (...args: never[]) => unknown;

type TaskRegistrar = (event: 'task', tasks: Record<string, (arg: never) => unknown>) => void;

/** The `config` half of setupNodeEvents. Accepted for forwards compatibility. */
export interface AnnotateSetupConfig {
  env?: Record<string, unknown>;
}

/**
 * Register in cypress.config setupNodeEvents:
 *
 *   setupNodeEvents(on, config) { registerAnnotateTasks(on, config); }
 *
 * Deliberately registers nothing but tasks. Cypress allows one handler per run
 * event and silently keeps the last one registered, so taking `before:run` or
 * `after:run` here would quietly stop a project's own handler from firing. The
 * manifest and the job summary are driven from the task instead, which can be
 * registered alongside anything.
 *
 * `config` is optional and currently unused.
 */
export function registerAnnotateTasks(on: CypressPluginOn, _config?: AnnotateSetupConfig): void {
  (on as unknown as TaskRegistrar)('task', {
    annotateScreenshot: ((args: AnnotateTaskArgs) => annotateScreenshot(args)) as unknown as (
      arg: never,
    ) => unknown,
    appendFailureRecord: ((args: { reportPath: string; record: FailureRecord }) =>
      appendFailureRecord(args)) as unknown as (arg: never) => unknown,
  });
}
