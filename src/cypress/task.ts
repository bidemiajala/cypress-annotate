import { readFile, writeFile } from 'node:fs/promises';
import { annotateImage, type MeasuredTarget } from '../annotate-image.js';
import type { AnnotationStyle, PixelRect, ShapeKind } from '../types.js';
import type { DomMeasurement } from './measure-dom.js';

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

  return {
    outPath,
    rawPath,
    width: result.width,
    height: result.height,
    scale: result.scale,
    drawnRects: result.drawnRects,
    warnings: [...warnings, ...result.warnings],
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

/**
 * Register in cypress.config setupNodeEvents:
 *
 *   setupNodeEvents(on) { registerAnnotateTasks(on); }
 */
export function registerAnnotateTasks(on: CypressPluginOn): void {
  (on as unknown as TaskRegistrar)('task', {
    annotateScreenshot: ((args: AnnotateTaskArgs) => annotateScreenshot(args)) as unknown as (
      arg: never,
    ) => unknown,
  });
}
