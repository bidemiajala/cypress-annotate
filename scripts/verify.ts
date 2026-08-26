/**
 * Alignment harness.
 *
 * Each fixture target paints one flat, unique colour, so its exact pixel
 * footprint can be recovered from the screenshot by scanning. That scan is the
 * ground truth: if the rect the pipeline computed does not land on it, the
 * scroll / device-pixel-ratio / crop maths is wrong. Nothing here trusts a
 * human looking at a picture.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { chromium, type Page } from 'playwright';
import { annotate } from '../src/annotate.js';
import type { Annotation, PixelRect, ScreenshotMode } from '../src/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = pathToFileURL(join(ROOT, 'fixtures', 'test-page.html')).href;
const QUIRKS_FIXTURE = pathToFileURL(join(ROOT, 'fixtures', 'quirks-page.html')).href;
const OUT_DIR = join(ROOT, 'out');

/** Half a CSS pixel at dpr 2, i.e. one image pixel of antialiasing slack. */
const TOLERANCE_PX = 1.5;

interface Case {
  name: string;
  selector: string | string[];
  color: string;
  mode: ScreenshotMode;
  /** Defaults to the main fixture. */
  fixture?: string;
  dpr?: number;
  /** Scroll here before capturing, and do not auto-scroll. */
  scrollY?: number;
  /** Scroll so the target's top edge sits this many CSS px below the viewport top. */
  scrollSoTargetAt?: number;
  /**
   * Target the element by percentage region instead of by selector, to check
   * the fallback path lands on the same pixels the selector would.
   */
  useRegion?: 'viewport' | 'document';
  label?: string;
}

const CASES: Case[] = [
  { name: 'above-fold, viewport, dpr 2', selector: '#target-top', color: '#FF00E4', mode: 'viewport' },
  { name: 'above-fold, viewport, dpr 1', selector: '#target-top', color: '#FF00E4', mode: 'viewport', dpr: 1 },
  { name: 'above-fold, viewport, dpr 3', selector: '#target-top', color: '#FF00E4', mode: 'viewport', dpr: 3 },
  { name: 'transformed element', selector: '#target-transformed', color: '#00FF3C', mode: 'viewport' },
  { name: 'inside iframe', selector: ['#checkout-frame', '#target-iframe'], color: '#FF7A00', mode: 'viewport' },
  { name: 'inside scrolled container', selector: '#target-in-scroller', color: '#7CFF00', mode: 'viewport' },
  { name: 'below fold, auto scroll into view', selector: '#target-below-fold', color: '#00E5FF', mode: 'viewport' },
  { name: 'below fold, full page', selector: '#target-below-fold', color: '#00E5FF', mode: 'fullPage' },
  { name: 'below fold, full page, dpr 1', selector: '#target-below-fold', color: '#00E5FF', mode: 'fullPage', dpr: 1 },
  { name: 'below fold, element crop', selector: '#target-below-fold', color: '#00E5FF', mode: 'element' },
  { name: 'fixed header, full page', selector: '#target-fixed', color: '#B400FF', mode: 'fullPage' },
  { name: 'fixed header, viewport scrolled 1200', selector: '#target-fixed', color: '#B400FF', mode: 'viewport', scrollY: 1200 },
  { name: 'below fold, scrolled to offset 200', selector: '#target-below-fold', color: '#00E5FF', mode: 'viewport', scrollSoTargetAt: 200 },
  { name: 'region fallback, viewport basis', selector: '#target-top', color: '#FF00E4', mode: 'viewport', useRegion: 'viewport' },
  { name: 'region fallback, document basis', selector: '#target-below-fold', color: '#00E5FF', mode: 'fullPage', useRegion: 'document' },
  { name: 'region fallback, viewport while scrolled', selector: '#target-below-fold', color: '#00E5FF', mode: 'viewport', scrollSoTargetAt: 240, useRegion: 'viewport' },
  { name: 'quirks mode, selector', selector: '#quirks-top', color: '#FF00E4', mode: 'viewport', fixture: QUIRKS_FIXTURE },
  { name: 'quirks mode, region fallback', selector: '#quirks-top', color: '#FF00E4', mode: 'viewport', fixture: QUIRKS_FIXTURE, useRegion: 'viewport' },
  { name: 'quirks mode, region while scrolled', selector: '#quirks-mid', color: '#00E5FF', mode: 'viewport', fixture: QUIRKS_FIXTURE, scrollSoTargetAt: 300, useRegion: 'viewport' },
  { name: 'quirks mode, full page', selector: '#quirks-mid', color: '#00E5FF', mode: 'fullPage', fixture: QUIRKS_FIXTURE },
];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Bounding box of every pixel matching `hex`, in image pixels, or null. */
async function scanForColor(image: Buffer, hex: string): Promise<PixelRect | null> {
  const [tr, tg, tb] = hexToRgb(hex);
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (
        Math.abs((data[i] ?? 0) - tr) <= 24 &&
        Math.abs((data[i + 1] ?? 0) - tg) <= 24 &&
        Math.abs((data[i + 2] ?? 0) - tb) <= 24
      ) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function clampToImage(rect: PixelRect, width: number, height: number): PixelRect {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  return {
    x,
    y,
    width: Math.min(rect.x + rect.width, width) - x,
    height: Math.min(rect.y + rect.height, height) - y,
  };
}

interface CaseResult {
  name: string;
  ok: boolean;
  detail: string;
  warnings: string[];
}

async function runCase(page: Page, testCase: Case, index: number): Promise<CaseResult> {
  const warnings: string[] = [];

  const manualScroll = testCase.scrollY !== undefined || testCase.scrollSoTargetAt !== undefined;
  if (testCase.scrollY !== undefined) {
    await page.evaluate((y) => window.scrollTo(0, y), testCase.scrollY);
  } else if (testCase.scrollSoTargetAt !== undefined) {
    const selector = Array.isArray(testCase.selector) ? testCase.selector[0]! : testCase.selector;
    await page.evaluate(
      ([sel, at]) => {
        const el = document.querySelector(sel as string);
        if (!el) throw new Error(`no element for ${sel}`);
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - (at as number));
      },
      [selector, testCase.scrollSoTargetAt] as const,
    );
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  // Percentages are read after positioning, since a viewport-basis region only
  // means anything relative to the scroll position it was measured at.
  const annotation: Annotation = testCase.useRegion
    ? {
        region: await page.evaluate(
          ([sel, basis]) => {
            const el = document.querySelector(sel as string);
            if (!el) throw new Error(`no element for ${sel}`);
            const r = el.getBoundingClientRect();
            const doc = document.documentElement;
            if (basis === 'document') {
              const w = Math.max(doc.scrollWidth, document.body.scrollWidth);
              const h = Math.max(doc.scrollHeight, document.body.scrollHeight);
              return {
                xPct: ((r.x + window.scrollX) / w) * 100,
                yPct: ((r.y + window.scrollY) / h) * 100,
                widthPct: (r.width / w) * 100,
                heightPct: (r.height / h) * 100,
                basis: 'document' as const,
              };
            }
            // innerWidth/Height, matching readPageMetrics — documentElement's
            // client size is the content size in quirks mode.
            return {
              xPct: (r.x / window.innerWidth) * 100,
              yPct: (r.y / window.innerHeight) * 100,
              widthPct: (r.width / window.innerWidth) * 100,
              heightPct: (r.height / window.innerHeight) * 100,
              basis: 'viewport' as const,
            };
          },
          [Array.isArray(testCase.selector) ? testCase.selector[0]! : testCase.selector, testCase.useRegion] as const,
        ),
        label: testCase.label ?? testCase.name,
      }
    : { selector: testCase.selector, label: testCase.label ?? testCase.name };
  const result = await annotate(page, [annotation], {
    mode: testCase.mode,
    scrollIntoView: !manualScroll,
    scrollToTop: !manualScroll,
    // Padding off: the drawn rect must sit exactly on the element's border box.
    style: { padding: 0, strokeWidth: 3 },
  });
  warnings.push(...result.warnings);

  const slug = `${String(index).padStart(2, '0')}-${testCase.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  await writeFile(join(OUT_DIR, `${slug}.png`), result.image);

  const painted = await scanForColor(result.rawImage, testCase.color);
  const computedRaw = result.drawnRects[0];
  if (!computedRaw) return { name: testCase.name, ok: false, detail: 'no rect computed', warnings };
  if (!painted) {
    return { name: testCase.name, ok: false, detail: 'target colour not found in capture', warnings };
  }

  const computed = clampToImage(computedRaw, result.width, result.height);
  const deltas = {
    left: computed.x - painted.x,
    top: computed.y - painted.y,
    right: computed.x + computed.width - (painted.x + painted.width),
    bottom: computed.y + computed.height - (painted.y + painted.height),
  };
  const worst = Math.max(...Object.values(deltas).map(Math.abs));
  const ok = worst <= TOLERANCE_PX;

  const detail =
    `max drift ${worst.toFixed(2)}px ` +
    `(l ${deltas.left.toFixed(1)}, t ${deltas.top.toFixed(1)}, ` +
    `r ${deltas.right.toFixed(1)}, b ${deltas.bottom.toFixed(1)}) ` +
    `image ${result.width}x${result.height}`;

  return { name: testCase.name, ok, detail, warnings };
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const results: CaseResult[] = [];

  try {
    for (const [index, testCase] of CASES.entries()) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: testCase.dpr ?? 2,
      });
      const page = await context.newPage();
      await page.goto(testCase.fixture ?? FIXTURE, { waitUntil: 'load' });
      try {
        results.push(await runCase(page, testCase, index));
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

  console.log(`\nAlignment against painted pixels (tolerance ${TOLERANCE_PX}px)\n`);
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(38)} ${result.detail}`);
    for (const warning of result.warnings) console.log(`      note: ${warning}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed. Images in out/\n`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
