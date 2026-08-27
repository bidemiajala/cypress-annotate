import type { Page } from 'playwright';
import { collectInventory, type InventoryItem } from './inventory.js';
import type { Annotation, Region } from './types.js';

export type Severity = 'blocker' | 'major' | 'minor' | 'cosmetic';

export interface BugFinding {
  description: string;
  /** Inventory handle, e.g. "e12". Null when the model could not pick one. */
  ref: string | null;
  /** Percentage fallback, used only when `ref` is null. */
  region: Region | null;
  severity: Severity;
  /** What the model saw that made it call this a bug. */
  evidence: string;
}

/**
 * The reasoning step is an interface so the pipeline can be exercised with a
 * recorded response, and so a different backend (computer use, an MCP server)
 * can be dropped in without touching the annotation code.
 *
 * This file deliberately has no dependency on `@anthropic-ai/sdk` - see
 * claude-reasoner.ts, which implements this interface and is the only file
 * that does. Keeping them separate means importing anything here (from the
 * package's root barrel) never forces the SDK to be installed.
 */
export interface Reasoner {
  propose(input: ReasonerInput): Promise<BugFinding[]>;
}

export interface ReasonerInput {
  screenshotPng: Buffer;
  inventory: InventoryItem[];
  ticket: string;
  url: string;
}

/** A reasoner backed by a recorded response, for tests and offline runs. */
export class ReplayReasoner implements Reasoner {
  constructor(private readonly findings: BugFinding[]) {}
  async propose(): Promise<BugFinding[]> {
    return this.findings;
  }
}

export const SEVERITY_COLORS: Record<Severity, string> = {
  blocker: '#FF2D2D',
  major: '#FF6A00',
  minor: '#F5A623',
  cosmetic: '#3D7BFF',
};

export interface ResolvedFinding {
  finding: BugFinding;
  annotation: Annotation;
  /** Present when the finding resolved through an inventory handle. */
  item?: InventoryItem;
  /**
   * Stable identity for de-duplicating the same bug seen in overlapping
   * viewport passes. Inventory handles are re-issued on every pass, so this is
   * keyed on the readable selector instead.
   */
  key: string;
}

export interface ResolvedFindings {
  resolved: ResolvedFinding[];
  /** Findings that named neither a valid ref nor a usable region. */
  unresolved: { finding: BugFinding; reason: string }[];
}

/**
 * Turn model findings into annotations. A ref is looked up in the inventory,
 * which is what guarantees the selector resolves; a region is passed through;
 * anything else is reported as unresolved rather than silently dropped.
 */
export function findingsToAnnotations(
  findings: BugFinding[],
  inventory: InventoryItem[],
): ResolvedFindings {
  const byRef = new Map(inventory.map((item) => [item.ref, item]));
  const resolved: ResolvedFinding[] = [];
  const unresolved: { finding: BugFinding; reason: string }[] = [];

  for (const finding of findings) {
    const style = { color: SEVERITY_COLORS[finding.severity] };
    const label = `${finding.severity}: ${finding.description}`;

    if (finding.ref) {
      const item = byRef.get(finding.ref);
      if (item) {
        resolved.push({
          finding,
          annotation: { selector: item.target, label, style },
          item,
          key: `sel:${item.reportSelector}`,
        });
        continue;
      }
      // A hallucinated handle is recoverable if a region came with it.
      if (!finding.region) {
        unresolved.push({ finding, reason: `ref "${finding.ref}" is not in the inventory` });
        continue;
      }
    }

    if (finding.region) {
      const r = finding.region;
      resolved.push({
        finding,
        annotation: { region: r, label, style },
        key: `region:${Math.round(r.xPct)},${Math.round(r.yPct)},${Math.round(r.widthPct)},${Math.round(r.heightPct)}`,
      });
      continue;
    }

    unresolved.push({ finding, reason: 'no ref and no region' });
  }

  return { resolved, unresolved };
}

export async function gatherReasonerInput(
  page: Page,
  ticket: string,
  viewportOnly = true,
): Promise<ReasonerInput> {
  const inventory = await collectInventory(page, { viewportOnly });
  const screenshotPng = await page.screenshot({ animations: 'disabled', caret: 'hide', type: 'png' });
  return { screenshotPng, inventory, ticket, url: page.url() };
}
