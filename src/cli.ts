#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { captureAnnotated } from './index.js';
import type { Annotation, ScreenshotMode } from './types.js';

const USAGE = `
Usage: cypress-annotate --url <url> --selector <css> [options]

  --url <url>              Page to open (http(s):// or file://).
  --selector <css>         Element to annotate. Repeatable.
                           Use ">>>" to pierce iframes: "iframe#pay >>> .btn".
  --label <text>           Label for the matching --selector. Repeatable.
  --out <path>             Output PNG. Default: annotated.png
  --mode <m>               viewport | fullPage | element. Default: viewport
  --shape <s>              box | circle | arrow. Default: box
  --color <css>            Outline colour. Default: #FF3B30
  --dim <0..1>             Darken everything outside the annotation. Default: 0
  --width <px>             Viewport width, CSS px. Default: 1280
  --height <px>            Viewport height, CSS px. Default: 800
  --dpr <n>                Device scale factor. Default: 2
  --crop-padding <px>      Context to keep around the element in 'element' mode.
  --json                   Print the measurement report as JSON.
`.trim();

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    selector: { type: 'string', multiple: true, default: [] },
    label: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: 'annotated.png' },
    mode: { type: 'string', default: 'viewport' },
    shape: { type: 'string', default: 'box' },
    color: { type: 'string' },
    dim: { type: 'string' },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '800' },
    dpr: { type: 'string', default: '2' },
    'crop-padding': { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help || !values.url || values.selector.length === 0) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const annotations: Annotation[] = values.selector.map((selector, i) => ({
  selector: selector.includes('>>>') ? selector.split('>>>').map((s) => s.trim()) : selector,
  label: values.label[i],
  shape: values.shape as Annotation['shape'],
}));

/**
 * A CLI should print what went wrong and nothing else. Without this, a missing
 * playwright surfaces as an unhandled rejection: the useful sentence buried in
 * a Node module-loader stack, plus the whole `cause` chain printed underneath.
 */
function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const result = await captureAnnotated(values.url, annotations, {
  mode: values.mode as ScreenshotMode,
  viewport: { width: Number(values.width), height: Number(values.height) },
  deviceScaleFactor: Number(values.dpr),
  cropPadding: values['crop-padding'] ? Number(values['crop-padding']) : undefined,
  style: {
    ...(values.color ? { color: values.color } : {}),
    ...(values.dim ? { dimOutside: Number(values.dim) } : {}),
  },
}).catch(fail);

await writeFile(values.out, result.image).catch(fail);

if (values.json) {
  console.log(
    JSON.stringify(
      { out: values.out, width: result.width, height: result.height, metrics: result.metrics, elements: result.elements, drawnRects: result.drawnRects, warnings: result.warnings },
      null,
      2,
    ),
  );
} else {
  console.log(`Wrote ${values.out} (${result.width}x${result.height})`);
  for (const element of result.elements) {
    const r = result.drawnRects[result.elements.indexOf(element)];
    console.log(
      `  ${element.selector} -> <${element.tagName}> ` +
        `css ${element.viewportRect.width.toFixed(0)}x${element.viewportRect.height.toFixed(0)} ` +
        `@ image ${r ? `${r.x.toFixed(0)},${r.y.toFixed(0)}` : '?'}`,
    );
  }
  for (const warning of result.warnings) console.log(`  ! ${warning}`);
}
