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

const REF_ATTR = 'data-annot-ref';
const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'option']);
const STRUCTURAL = new Set(['header', 'nav', 'main', 'footer', 'aside', 'form', 'table', 'img', 'svg', 'video', 'dialog']);
const HEADING = /^h[1-6]$/;

export interface InventoryItem {
  ref: string;
  tag: string;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const alt = el.getAttribute('alt');
  if (alt) return alt.trim();
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return `placeholder: ${placeholder.trim()}`;
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).value) {
    return `value: ${(el as HTMLInputElement).value.trim()}`;
  }
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function isTextLeaf(el: Element): boolean {
  if (!(el.textContent ?? '').trim()) return false;
  for (const child of Array.from(el.children)) {
    if ((child.textContent ?? '').trim()) return false;
  }
  return true;
}

/**
 * Collect elements worth showing to Claude, for the case where no single
 * selector could be recovered from the failure. Same "interesting element"
 * heuristic as src/browser/collect-elements.js (the MCP-facing version), but
 * written directly against `Window` rather than serialized as a string: in
 * Cypress there is no eval boundary to cross, so there is nothing to duplicate
 * that trick for.
 */
export function collectInventory(win: Window, limit = 120): InventoryItem[] {
  const doc = win.document;
  const items: InventoryItem[] = [];
  let counter = 0;

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (items.length >= limit) break;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link') continue;

    const style = win.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (parseFloat(style.opacity) < 0.05) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;

    const interesting =
      INTERACTIVE.has(tag) ||
      STRUCTURAL.has(tag) ||
      HEADING.test(tag) ||
      el.hasAttribute('role') ||
      el.hasAttribute('id') ||
      isTextLeaf(el);
    if (!interesting) continue;

    const ref = `e${++counter}`;
    el.setAttribute(REF_ATTR, ref);
    items.push({
      ref,
      tag,
      name: accessibleName(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }

  return items;
}

export function refSelector(ref: string): string {
  return `[${REF_ATTR}="${ref}"]`;
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
