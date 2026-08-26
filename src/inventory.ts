import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Frame, Page } from 'playwright';
import type { CssRect } from './types.js';

export interface InventoryItem {
  /** Handle the model refers to, e.g. "e12". */
  ref: string;
  /**
   * Selector chain that is guaranteed to resolve, because the attribute it
   * matches was injected during collection.
   */
  target: string[];
  /** Readable selector for the bug report, derived from ids/test-ids/structure. */
  reportSelector: string;
  tag: string;
  role: string | null;
  /** Accessible-ish name: aria-label, alt, placeholder, value, or trimmed text. */
  name: string;
  rect: CssRect;
  inViewport: boolean;
  /** Empty for the main document. */
  framePath: string[];
}

export interface InventoryOptions {
  /** Cap on items sent to the model, to bound token cost. Default 120. */
  limit?: number;
  /** Ignore anything smaller than this many CSS px on either axis. Default 8. */
  minSize?: number;
  /** Only collect elements currently intersecting the viewport. Default false. */
  viewportOnly?: boolean;
}

interface RawItem {
  ref: string;
  reportSelector: string;
  tag: string;
  role: string | null;
  name: string;
  rect: CssRect;
  inViewport: boolean;
}

const REF_ATTR = 'data-annot-ref';
const FRAME_ATTR = 'data-annot-frame';

const COLLECTOR_PATH = join(dirname(fileURLToPath(import.meta.url)), 'browser', 'collect-elements.js');
let collectorSource: string | undefined;

async function loadCollector(): Promise<string> {
  collectorSource ??= await readFile(COLLECTOR_PATH, 'utf8');
  return collectorSource;
}

/**
 * Run the collector in a frame.
 *
 * The source is inlined into a self-invoking expression rather than passed as a
 * function: Playwright will not call a function supplied as a string with
 * arguments, and passing the TypeScript function directly breaks because
 * esbuild rewrites it to reference a `__name` helper that the page lacks.
 */
async function runCollector(
  frame: Frame,
  args: { prefix: string; refAttr: string; minSize: number; viewportOnly: boolean },
): Promise<RawItem[]> {
  const source = await loadCollector();
  return frame.evaluate(`(${source})(${JSON.stringify(args)})`) as Promise<RawItem[]>;
}

/** Tag same-origin child frames so their contents can be addressed by a chain. */
async function tagFrames(page: Page): Promise<Map<Frame, string>> {
  const map = new Map<Frame, string>();
  let index = 0;

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const element = await frame.frameElement();
      const id = `f${++index}`;
      await element.evaluate(
        (el, [attr, value]) => (el as unknown as Element).setAttribute(attr!, value!),
        [FRAME_ATTR, id],
      );
      map.set(frame, `[${FRAME_ATTR}="${id}"]`);
    } catch {
      // Cross-origin or detached frames cannot be tagged; they are skipped and
      // their contents simply will not appear in the inventory.
    }
  }
  return map;
}

export async function collectInventory(
  page: Page,
  options: InventoryOptions = {},
): Promise<InventoryItem[]> {
  const limit = options.limit ?? 120;
  const args = {
    refAttr: REF_ATTR,
    minSize: options.minSize ?? 8,
    viewportOnly: options.viewportOnly ?? false,
  };

  const items: InventoryItem[] = [];

  const mainRaw = await runCollector(page.mainFrame(), { ...args, prefix: 'e' });
  for (const raw of mainRaw) {
    items.push({ ...raw, target: [`[${REF_ATTR}="${raw.ref}"]`], framePath: [] });
  }

  const frames = await tagFrames(page);
  let frameIndex = 0;
  for (const [frame, frameSelector] of frames) {
    frameIndex++;
    try {
      const raw = await runCollector(frame, { ...args, prefix: `f${frameIndex}e` });
      for (const item of raw) {
        items.push({
          ...item,
          target: [frameSelector, `[${REF_ATTR}="${item.ref}"]`],
          framePath: [frameSelector],
        });
      }
    } catch {
      // Same reasoning as tagFrames: an inaccessible frame is skipped.
    }
  }

  return items.slice(0, limit);
}

/** Compact text rendering of the inventory for the model prompt. */
export function renderInventory(items: InventoryItem[]): string {
  return items
    .map((item) => {
      const r = item.rect;
      const box = `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      const role = item.role ? ` role=${item.role}` : '';
      const frame = item.framePath.length > 0 ? ' [in iframe]' : '';
      const name = item.name ? ` "${item.name}"` : '';
      return `[${item.ref}] <${item.tag}>${role}${name} @ ${box}${frame} — ${item.reportSelector}`;
    })
    .join('\n');
}
