/**
 * Annotate a screenshot that some other tool captured.
 *
 * This is the driver-agnostic entry point: it never opens a browser. Give it a
 * PNG and the measurement JSON produced by src/browser/measure-target.js, and it
 * draws the boxes. Whatever took the screenshot - Playwright MCP, Chrome
 * DevTools MCP, Cypress, a human with a screenshot key - is irrelevant here.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { annotateImage, type MeasuredTarget } from '../src/annotate-image.js';
import type { PageMetrics, ShapeKind } from '../src/types.js';

const USAGE = `
Usage: npm run annotate-shot -- --image <png> --measurement <json> --out <png>

  --image <path>         Screenshot to annotate.
  --measurement <path>   JSON from src/browser/measure-target.js. Accepts the
                         raw object, or the { result: ... } wrapper some MCP
                         servers write.
  --out <path>           Where to write the annotated PNG. Default annotated.png
  --label <text>         Label for the matching target. Repeatable, in order.
  --capture <mode>       What the image holds: viewport | fullPage. Default viewport.
  --crop                 Crop to the target instead of keeping the whole image.
  --crop-padding <px>    Context to keep when cropping, CSS px. Default 90.
  --dim <0..1>           Darken everything outside the box. Default 0 (0.45 with --crop).
  --color <css>          Box colour. Default #FF3B30.
  --shape <s>            box | circle | arrow. Default box.
  --region <x,y,w,h>     Fallback when no selector matched: percentages of the
                         viewport. Repeatable. Used instead of measurement targets.
  --json                 Print the result as JSON.
`.trim();

const { values } = parseArgs({
  options: {
    image: { type: 'string' },
    measurement: { type: 'string' },
    out: { type: 'string', default: 'annotated.png' },
    label: { type: 'string', multiple: true, default: [] },
    capture: { type: 'string', default: 'viewport' },
    crop: { type: 'boolean', default: false },
    'crop-padding': { type: 'string' },
    dim: { type: 'string' },
    color: { type: 'string' },
    shape: { type: 'string', default: 'box' },
    region: { type: 'string', multiple: true, default: [] },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || !values.image || (!values.measurement && values.region.length === 0)) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

interface MeasuredPayload {
  metrics: PageMetrics;
  targets: {
    selector: string;
    found: boolean;
    error?: string;
    matchCount?: number;
    tag?: string;
    isFixed?: boolean;
    inViewport?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
  }[];
}

/**
 * MCP servers differ in how they wrap an evaluate result - some write the value
 * itself, others nest it under `result`. Accept either rather than making the
 * caller unwrap it.
 */
function unwrap(raw: unknown): MeasuredPayload {
  let value = raw;
  for (const key of ['result', 'value', 'data']) {
    if (
      value &&
      typeof value === 'object' &&
      !('metrics' in (value as object)) &&
      key in (value as object)
    ) {
      value = (value as Record<string, unknown>)[key];
    }
  }
  const payload = value as MeasuredPayload;
  if (!payload?.metrics || !Array.isArray(payload.targets)) {
    throw new Error(
      'Measurement JSON has no { metrics, targets } - is it the output of measure-target.js?',
    );
  }
  return payload;
}

const image = await readFile(values.image);
const warnings: string[] = [];
let metrics: PageMetrics;
let targets: MeasuredTarget[] = [];

if (values.measurement) {
  const payload = unwrap(JSON.parse(await readFile(values.measurement, 'utf8')));
  metrics = payload.metrics;

  payload.targets.forEach((target, i) => {
    if (!target.found || !target.rect) {
      warnings.push(`Selector "${target.selector}" was not measured: ${target.error ?? 'not found'}.`);
      return;
    }
    if ((target.matchCount ?? 1) > 1) {
      warnings.push(
        `Selector "${target.selector}" matched ${target.matchCount} elements; annotated the first.`,
      );
    }
    if (target.inViewport === false && values.capture === 'viewport') {
      warnings.push(`Selector "${target.selector}" was outside the viewport when measured.`);
    }
    targets.push({
      viewportRect: target.rect,
      isFixed: target.isFixed,
      label: values.label[i],
      shape: values.shape as ShapeKind,
      describe: `Element "${target.selector}"`,
    });
  });
} else {
  // Region-only mode still needs metrics; without a measurement, derive them
  // from the image and let percentages be relative to it.
  metrics = {
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    documentWidth: 0,
    documentHeight: 0,
  };
}

if (values.region.length > 0) {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // Percentages are resolved against the image itself here, so this path works
  // even with no page metrics at all - the pixel-only fallback.
  if (metrics.viewportWidth === 0) {
    metrics = { ...metrics, viewportWidth: width, viewportHeight: height };
  }
  const scaleX = width / metrics.viewportWidth;

  targets = values.region.map((spec, i) => {
    const [x, y, w, h] = spec.split(',').map(Number);
    if ([x, y, w, h].some((n) => n === undefined || Number.isNaN(n))) {
      throw new Error(`--region expects "x,y,w,h" as percentages, got "${spec}"`);
    }
    return {
      viewportRect: {
        x: ((x! / 100) * width) / scaleX,
        y: ((y! / 100) * height) / scaleX,
        width: ((w! / 100) * width) / scaleX,
        height: ((h! / 100) * height) / scaleX,
      },
      label: values.label[i],
      shape: values.shape as ShapeKind,
      describe: `Region ${spec}%`,
    };
  });
}

if (targets.length === 0) {
  console.error('Nothing to annotate.');
  for (const warning of warnings) console.error(`  ! ${warning}`);
  process.exit(1);
}

const result = await annotateImage(image, targets, {
  metrics,
  capture: values.capture === 'fullPage' ? 'fullPage' : 'viewport',
  crop: values.crop,
  cropPadding: values['crop-padding'] ? Number(values['crop-padding']) : undefined,
  style: {
    ...(values.color ? { color: values.color } : {}),
    dimOutside: values.dim ? Number(values.dim) : values.crop ? 0.45 : 0,
  },
});

await writeFile(values.out, result.image);
const allWarnings = [...warnings, ...result.warnings];

if (values.json) {
  console.log(
    JSON.stringify(
      { out: values.out, width: result.width, height: result.height, scale: result.scale, drawnRects: result.drawnRects, warnings: allWarnings },
      null,
      2,
    ),
  );
} else {
  console.log(`Wrote ${values.out} (${result.width}x${result.height}, scale ${result.scale.toFixed(3)})`);
  for (const [i, rect] of result.drawnRects.entries()) {
    console.log(
      `  ${targets[i]?.describe} -> ${Math.round(rect.x)},${Math.round(rect.y)} ` +
        `${Math.round(rect.width)}x${Math.round(rect.height)}px`,
    );
  }
  for (const warning of allWarnings) console.log(`  ! ${warning}`);
}
