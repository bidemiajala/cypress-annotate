/**
 * Alignment harness for the driver-agnostic path.
 *
 * verify.ts proves the Playwright pipeline. This proves the part that matters
 * for an agent workflow: a screenshot captured by something else, measured with
 * the snippet the agent actually pastes, and annotated with no browser in the
 * loop.
 *
 * The important cases are the rescaled ones. Both browser MCP servers can hand
 * back a resized image - Playwright MCP with `scale: "css"`, Chrome DevTools MCP
 * with `--screenshot-max-width` - so a pipeline that trusts devicePixelRatio
 * draws boxes in the wrong place. Playwright is used here only to produce the
 * inputs an MCP server would have produced.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { chromium, type Page } from 'playwright';
import { annotateImage, type MeasuredTarget } from '../src/annotate-image.js';
import type { PageMetrics } from '../src/types.js';
import { clampToImage, edgeDeltas, scanForColor } from './lib/pixels.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = pathToFileURL(join(ROOT, 'fixtures', 'test-page.html')).href;
const SNIPPET = join(ROOT, 'src', 'browser', 'measure-target.js');
const OUT_DIR = join(ROOT, 'out', 'agnostic');

/** Resampling blurs a rescaled target's edges, so allow two pixels. */
const TOLERANCE_PX = 2.0;

interface Case {
  name: string;
  selector: string;
  color: string;
  capture: 'viewport' | 'fullPage';
  dpr?: number;
  scrollY?: number;
  crop?: boolean;
  /** Resize the screenshot to this width first, mimicking an MCP server. */
  rescaleWidth?: number;
}

const CASES: Case[] = [
  { name: 'viewport, no rescale', selector: '#target-top', color: '#FF00E4', capture: 'viewport' },
  { name: 'viewport, rescaled to CSS size', selector: '#target-top', color: '#FF00E4', capture: 'viewport', rescaleWidth: 1280 },
  { name: 'viewport, rescaled to 1200px', selector: '#target-top', color: '#FF00E4', capture: 'viewport', rescaleWidth: 1200 },
  { name: 'viewport, rescaled to 900px', selector: '#target-top', color: '#FF00E4', capture: 'viewport', rescaleWidth: 900 },
  { name: 'viewport, dpr 1, rescaled to 640px', selector: '#target-top', color: '#FF00E4', capture: 'viewport', dpr: 1, rescaleWidth: 640 },
  { name: 'scrolled, viewport, rescaled', selector: '#target-below-fold', color: '#00E5FF', capture: 'viewport', scrollY: 2200, rescaleWidth: 1100 },
  { name: 'full page, document coords', selector: '#target-below-fold', color: '#00E5FF', capture: 'fullPage' },
  { name: 'full page, rescaled', selector: '#target-below-fold', color: '#00E5FF', capture: 'fullPage', rescaleWidth: 1000 },
  { name: 'fixed element, scrolled', selector: '#target-fixed', color: '#B400FF', capture: 'viewport', scrollY: 1500 },
  { name: 'crop from rescaled capture', selector: '#target-below-fold', color: '#00E5FF', capture: 'fullPage', rescaleWidth: 1100, crop: true },
];

interface Measurement {
  metrics: PageMetrics;
  targets: {
    selector: string;
    found: boolean;
    error?: string;
    isFixed?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
  }[];
}

/**
 * Run the very snippet the agent is told to paste, with only the SELECTORS line
 * substituted - so this suite fails if that file is broken, not just if the
 * library is.
 */
async function measure(page: Page, selector: string): Promise<Measurement> {
  const source = await readFile(SNIPPET, 'utf8');
  const body = source.replace(
    /const SELECTORS = \[[^\]]*\];/,
    `const SELECTORS = ${JSON.stringify([selector])};`,
  );
  if (!body.includes(JSON.stringify([selector]))) {
    throw new Error('Could not substitute SELECTORS - has measure-target.js changed shape?');
  }
  return page.evaluate(`(${body})()`) as Promise<Measurement>;
}

async function runCase(page: Page, testCase: Case, index: number): Promise<{ ok: boolean; detail: string; warnings: string[] }> {
  await page.evaluate((y) => window.scrollTo(0, y), testCase.scrollY ?? 0);
  await page.waitForTimeout(80);

  // Measure first, then capture: the rects are only valid for this scroll
  // position, which is the whole discipline of the agent protocol.
  const measurement = await measure(page, testCase.selector);
  const measured = measurement.targets[0];
  if (!measured?.found || !measured.rect) {
    return { ok: false, detail: `measurement failed: ${measured?.error ?? 'not found'}`, warnings: [] };
  }

  let screenshot = await page.screenshot({
    fullPage: testCase.capture === 'fullPage',
    animations: 'disabled',
    caret: 'hide',
    type: 'png',
  });

  if (testCase.rescaleWidth) {
    screenshot = await sharp(screenshot).resize({ width: testCase.rescaleWidth }).png().toBuffer();
  }

  const target: MeasuredTarget = {
    viewportRect: measured.rect,
    isFixed: measured.isFixed,
    label: testCase.name,
    describe: `Element "${testCase.selector}"`,
  };

  const result = await annotateImage(screenshot, [target], {
    metrics: measurement.metrics,
    capture: testCase.capture,
    crop: testCase.crop,
    cropPadding: 60,
    style: { padding: 0, strokeWidth: 3 },
  });

  const slug = `${String(index).padStart(2, '0')}-${testCase.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  await writeFile(join(OUT_DIR, `${slug}.png`), result.image);

  // Downscaling only blends the target's outermost pixels - its interior stays
  // the exact colour - so the match stays tight. A loose tolerance is actively
  // harmful: resampling rings around a *different* target's edge and those
  // overshoot pixels then get scanned as if they were this one.
  const painted = await scanForColor(result.rawImage, testCase.color, 24);
  if (!painted) return { ok: false, detail: 'target colour not found in capture', warnings: result.warnings };

  const computed = clampToImage(result.drawnRects[0]!, result.width, result.height);
  const deltas = edgeDeltas(computed, painted);
  const worst = Math.max(...Object.values(deltas).map(Math.abs));

  const ok = worst <= TOLERANCE_PX;
  const diagnostic = ok
    ? ''
    : ` | computed ${computed.x.toFixed(0)},${computed.y.toFixed(0)} ` +
      `${computed.width.toFixed(0)}x${computed.height.toFixed(0)}` +
      ` vs painted ${painted.x},${painted.y} ${painted.width}x${painted.height}`;

  return {
    ok,
    detail:
      `max drift ${worst.toFixed(2)}px (l ${deltas.left.toFixed(1)}, t ${deltas.top.toFixed(1)}, ` +
      `r ${deltas.right.toFixed(1)}, b ${deltas.bottom.toFixed(1)}) ` +
      `scale ${result.scale.toFixed(3)} image ${result.width}x${result.height}${diagnostic}`,
    warnings: result.warnings,
  };
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const results: { name: string; ok: boolean; detail: string; warnings: string[] }[] = [];

  try {
    for (const [index, testCase] of CASES.entries()) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: testCase.dpr ?? 2,
      });
      const page = await context.newPage();
      await page.goto(FIXTURE, { waitUntil: 'load' });
      try {
        results.push({ name: testCase.name, ...(await runCase(page, testCase, index)) });
      } catch (error) {
        results.push({
          name: testCase.name,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          warnings: [],
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDriver-agnostic alignment (tolerance ${TOLERANCE_PX}px)\n`);
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(34)} ${result.detail}`);
    for (const warning of result.warnings) console.log(`      note: ${warning}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed. Images in out/agnostic/\n`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
