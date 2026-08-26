import type { PageMetrics } from '../types.js';

/**
 * Measure elements inside a given window.
 *
 * This is the bundled counterpart to src/browser/measure-target.js, which is the
 * copy-pasteable version for agent MCP sessions. They must stay in agreement:
 * same metrics definitions, same fixed-ancestry rule, same rect shape.
 */

export interface MeasuredDomTarget {
  selector: string;
  found: boolean;
  error?: string;
  matchCount?: number;
  tag?: string;
  text?: string;
  isFixed?: boolean;
  inViewport?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface DomMeasurement {
  metrics: PageMetrics;
  targets: MeasuredDomTarget[];
}

export function readMetrics(win: Window): PageMetrics {
  const doc = win.document.documentElement;
  const body = win.document.body;
  return {
    devicePixelRatio: win.devicePixelRatio,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
    // innerWidth/Height rather than documentElement.clientWidth/Height: on a
    // page with no doctype the root element reports the content size, not the
    // viewport.
    viewportWidth: win.innerWidth,
    viewportHeight: win.innerHeight,
    documentWidth: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
    documentHeight: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
  };
}

export function measureTargets(win: Window, selectors: string[]): DomMeasurement {
  const metrics = readMetrics(win);

  const targets = selectors.map<MeasuredDomTarget>((selector) => {
    let matches: NodeListOf<Element>;
    try {
      matches = win.document.querySelectorAll(selector);
    } catch (error) {
      return {
        selector,
        found: false,
        error: `invalid selector: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (matches.length === 0) return { selector, found: false, error: 'no element matched' };

    const el = matches[0] as Element;
    const r = el.getBoundingClientRect();

    // An element inside a fixed subtree does not move with document scroll, so
    // it has no meaningful document-space position.
    let isFixed = false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (win.getComputedStyle(node).position === 'fixed') {
        isFixed = true;
        break;
      }
    }

    return {
      selector,
      found: true,
      matchCount: matches.length,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      isFixed,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      inViewport:
        r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth,
    };
  });

  return { metrics, targets };
}
