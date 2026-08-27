import type { Page, Locator, FrameLocator } from 'playwright';
import type { CssRect, MeasuredElement, PageMetrics, Region } from './types.js';

/** Anything that can host a `.locator()` / `.frameLocator()` call. */
type LocatorHost = Page | FrameLocator;

export async function readPageMetrics(page: Page): Promise<PageMetrics> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      // window.innerWidth/Height, not documentElement.clientWidth/Height: in
      // quirks mode (a page with no doctype - Hacker News, plenty of internal
      // tools) the root element reports the *content* size, so clientHeight can
      // be the full document height. innerWidth/Height is also exactly the
      // viewport Playwright was configured with, which is what the screenshot
      // dimensions are derived from.
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
      documentHeight: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
    };
  });
}

/**
 * Walk a frame chain, accumulating the offset of each iframe's content origin
 * within the top-level viewport. A frame's own internal scrolling needs no
 * correction: `getBoundingClientRect()` inside that frame is already relative
 * to the frame's own viewport.
 */
async function resolveTarget(
  page: Page,
  chain: string[],
): Promise<{ locator: Locator; offsetX: number; offsetY: number }> {
  const targetSelector = chain[chain.length - 1];
  if (targetSelector === undefined) throw new Error('Empty selector chain.');

  let host: LocatorHost = page;
  let offsetX = 0;
  let offsetY = 0;

  for (const frameSelector of chain.slice(0, -1)) {
    const frameElement = host.locator(frameSelector);
    if ((await frameElement.count()) === 0) {
      throw new Error(`Frame selector matched nothing: ${frameSelector}`);
    }
    const origin = await frameElement.first().evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        x: rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
        y: rect.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
      };
    });
    offsetX += origin.x;
    offsetY += origin.y;
    host = host.frameLocator(frameSelector);
  }

  return { locator: host.locator(targetSelector), offsetX, offsetY };
}

export async function measureElement(
  page: Page,
  selector: string | string[],
  metrics: PageMetrics,
): Promise<MeasuredElement> {
  const chain = Array.isArray(selector) ? selector : [selector];
  const label = chain.join(' >>> ');
  const { locator, offsetX, offsetY } = await resolveTarget(page, chain);

  const matchCount = await locator.count();
  if (matchCount === 0) throw new Error(`Selector matched no elements: ${label}`);

  const measured = await locator.first().evaluate((el) => {
    const rect = el.getBoundingClientRect();

    // An element inside a fixed subtree does not move with document scroll, so
    // its document-space position is undefined in the usual sense.
    let fixed = false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') {
        fixed = true;
        break;
      }
    }

    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      isFixed: fixed,
      tagName: el.tagName.toLowerCase(),
    };
  });

  const viewportRect: CssRect = {
    x: measured.x + offsetX,
    y: measured.y + offsetY,
    width: measured.width,
    height: measured.height,
  };

  const documentRect: CssRect = measured.isFixed
    ? { ...viewportRect }
    : {
        ...viewportRect,
        x: viewportRect.x + metrics.scrollX,
        y: viewportRect.y + metrics.scrollY,
      };

  const inViewport =
    viewportRect.x + viewportRect.width > 0 &&
    viewportRect.y + viewportRect.height > 0 &&
    viewportRect.x < metrics.viewportWidth &&
    viewportRect.y < metrics.viewportHeight;

  return {
    selector: label,
    source: 'selector',
    viewportRect,
    documentRect,
    isFixed: measured.isFixed,
    inViewport,
    framePath: chain.slice(0, -1),
    tagName: measured.tagName,
    matchCount,
  };
}

/**
 * Turn a percentage region into the same shape a measured element has, so the
 * rest of the pipeline cannot tell the difference.
 */
export function measureRegion(region: Region, metrics: PageMetrics): MeasuredElement {
  const basis = region.basis ?? 'viewport';
  const baseWidth = basis === 'document' ? metrics.documentWidth : metrics.viewportWidth;
  const baseHeight = basis === 'document' ? metrics.documentHeight : metrics.viewportHeight;

  const rect: CssRect = {
    x: (region.xPct / 100) * baseWidth,
    y: (region.yPct / 100) * baseHeight,
    width: (region.widthPct / 100) * baseWidth,
    height: (region.heightPct / 100) * baseHeight,
  };

  const viewportRect =
    basis === 'document' ? { ...rect, x: rect.x - metrics.scrollX, y: rect.y - metrics.scrollY } : rect;
  const documentRect =
    basis === 'document' ? rect : { ...rect, x: rect.x + metrics.scrollX, y: rect.y + metrics.scrollY };

  return {
    selector:
      `region ${region.xPct}%,${region.yPct}% ${region.widthPct}x${region.heightPct}% of ${basis}`,
    source: 'region',
    viewportRect,
    documentRect,
    isFixed: false,
    inViewport:
      viewportRect.x + viewportRect.width > 0 &&
      viewportRect.y + viewportRect.height > 0 &&
      viewportRect.x < metrics.viewportWidth &&
      viewportRect.y < metrics.viewportHeight,
    framePath: [],
    tagName: 'region',
    matchCount: 1,
  };
}

export async function scrollElementIntoView(page: Page, selector: string | string[]): Promise<void> {
  const chain = Array.isArray(selector) ? selector : [selector];
  const { locator } = await resolveTarget(page, chain);
  await locator.first().scrollIntoViewIfNeeded();
}
