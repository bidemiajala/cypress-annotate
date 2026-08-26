import Anthropic from '@anthropic-ai/sdk';
import type { Page } from 'playwright';
import { collectInventory, renderInventory, type InventoryItem } from './inventory.js';
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

const SEVERITIES: Severity[] = ['blocker', 'major', 'minor', 'cosmetic'];

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      description: 'Every visual or functional defect found. Empty if the page looks correct.',
      items: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'What is wrong, in one sentence a developer could act on.',
          },
          evidence: {
            type: 'string',
            description: 'What in the screenshot or element list shows this is a defect.',
          },
          severity: { type: 'string', enum: SEVERITIES },
          ref: {
            type: ['string', 'null'],
            description:
              'The handle of the single element the annotation should point at, e.g. "e12". ' +
              'Null only if no listed element corresponds to the problem.',
          },
          region: {
            type: ['object', 'null'],
            description:
              'Fallback used only when ref is null: the area of the viewport to box, in percentages.',
            properties: {
              xPct: { type: 'number' },
              yPct: { type: 'number' },
              widthPct: { type: 'number' },
              heightPct: { type: 'number' },
            },
            required: ['xPct', 'yPct', 'widthPct', 'heightPct'],
            additionalProperties: false,
          },
        },
        required: ['description', 'evidence', 'severity', 'ref', 'region'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are doing exploratory visual testing of a web page.

You get a screenshot and a list of the page's elements. Every element has a handle
like [e12], its tag, its accessible name, and its bounding box in CSS pixels
(x,y width x height) relative to the viewport.

Report defects a developer would accept as real bugs: overlapping or clipped
content, misalignment, text overflowing its container, invisible or unreadable
text, controls positioned off-screen or outside their container, broken images,
inconsistent spacing that breaks an otherwise regular rhythm, and anything that
contradicts the ticket.

Do not report subjective styling preferences, and do not invent defects. If the
page looks correct, return an empty findings array.

For each finding, set "ref" to the handle of the single element the annotation
should point at — the element that is wrong, not its container, and not the
element it collides with. The bounding boxes in the element list are the best
evidence for geometric bugs: overlapping boxes, boxes extending past a parent,
and boxes with a zero or negative gap are all visible in the numbers.

Only set "ref" to null when no listed element corresponds to the problem — for
example whitespace where something should be. In that case fill in "region"
with the area to box, as percentages of the viewport.

Always call the report_findings tool exactly once, even when you find nothing.`;

export interface ClaudeReasonerOptions {
  model?: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  client?: Anthropic;
}

export class ClaudeReasoner implements Reasoner {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  constructor(options: ClaudeReasonerOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? 'claude-opus-5';
    this.maxTokens = options.maxTokens ?? 16000;
    this.effort = options.effort ?? 'high';
  }

  async propose(input: ReasonerInput): Promise<BugFinding[]> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort },
      tools: [
        {
          name: 'report_findings',
          description: 'Report every defect found on the page.',
          input_schema: FINDING_SCHEMA as unknown as Anthropic.Tool['input_schema'],
          strict: true,
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: input.screenshotPng.toString('base64'),
              },
            },
            {
              type: 'text',
              text:
                `URL: ${input.url}\n\n` +
                `${describeIntent(input.ticket)}\n\n` +
                `Elements on the page:\n${renderInventory(input.inventory)}`,
            },
          ],
        },
      ],
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      throw new Error(
        `Model declined the request (${message.stop_details?.category ?? 'unknown'}).`,
      );
    }

    const call = message.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === 'report_findings',
    );
    if (!call) {
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ');
      throw new Error(
        `Model did not call report_findings (stop_reason: ${message.stop_reason}). Said: ${text.slice(0, 300)}`,
      );
    }

    // Tool inputs are already parsed objects, but escaping varies by model, so
    // never string-match on them.
    const parsed = call.input as { findings?: unknown };
    return normaliseFindings(parsed.findings);
  }
}

/**
 * With no ticket there is nothing to contradict, so the model is told to judge
 * the page on its own terms rather than being handed an empty requirement it
 * might try to reason against.
 */
function describeIntent(ticket: string): string {
  const trimmed = ticket.trim();
  return trimmed
    ? `Ticket / what this page is supposed to do:\n${trimmed}`
    : 'No ticket was supplied. Judge the page on its own terms: report anything that ' +
        'looks broken, misaligned, unreadable, clipped, or otherwise unintentional.';
}

function normaliseFindings(raw: unknown): BugFinding[] {
  if (!Array.isArray(raw)) return [];
  const findings: BugFinding[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const severity = SEVERITIES.includes(record.severity as Severity)
      ? (record.severity as Severity)
      : 'minor';

    findings.push({
      description: String(record.description ?? '').trim(),
      evidence: String(record.evidence ?? '').trim(),
      severity,
      ref: typeof record.ref === 'string' && record.ref ? record.ref : null,
      region: isRegion(record.region) ? record.region : null,
    });
  }

  return findings.filter((f) => f.description.length > 0);
}

function isRegion(value: unknown): value is Region {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.xPct === 'number' &&
    typeof r.yPct === 'number' &&
    typeof r.widthPct === 'number' &&
    typeof r.heightPct === 'number'
  );
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
