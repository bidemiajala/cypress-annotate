import { readFile, writeFile } from 'node:fs/promises';
import type { PageMetrics, PixelRect } from '../types.js';
import type { DomMeasurement } from './measure-dom.js';

/**
 * One test failure, captured live and written to disk. The Node-side task
 * appends to this file rather than overwriting it, since a spec run produces
 * many failures across many test files.
 */
export interface FailureRecord {
  spec: string;
  test: string;
  errMessage: string;
  errName: string | undefined;
  selector: string | null;
  selectorSource: string;
  expected: string | null;
  actual: string | null;
  elementNotFound: boolean;
  label: string;
  /** Set only when a selector resolved to a live, measurable element. */
  resolved: boolean;
  screenshotPath: string;
  annotatedPath: string | null;
  drawnRect: PixelRect | null;
  /** Always captured, so the fallback script can convert inventory rects later. */
  metrics: PageMetrics;
  /**
   * Present only when no selector resolved. A same-shape inventory to the one
   * the MCP skill uses, captured live because a screenshot alone carries no
   * DOM information - this is what lets the Claude fallback reason about the
   * failure after the browser session is long gone.
   */
  inventory: DomMeasurement['targets'] | null;
  warnings: string[];
  timestamp: string;
}

export interface AppendFailureArgs {
  reportPath: string;
  record: FailureRecord;
}

export async function appendFailureRecord({ reportPath, record }: AppendFailureArgs): Promise<null> {
  let existing: FailureRecord[] = [];
  try {
    existing = JSON.parse(await readFile(reportPath, 'utf8')) as FailureRecord[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  existing.push(record);
  await writeFile(reportPath, JSON.stringify(existing, null, 2));
  return null;
}
