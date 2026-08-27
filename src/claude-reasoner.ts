import Anthropic from '@anthropic-ai/sdk';
import { renderInventory } from './inventory.js';
import type { BugFinding, Reasoner, ReasonerInput, Severity } from './finder.js';
import type { Region } from './types.js';

/**
 * Split out from finder.ts on purpose: this is the only file in the package
 * with a real (non-type-only) import of `@anthropic-ai/sdk`. finder.ts's other
 * exports (findingsToAnnotations, gatherReasonerInput, ReplayReasoner, ...) do
 * not need the SDK at all, and index.ts re-exports them from its root barrel -
 * if ClaudeReasoner lived in the same file, importing anything from that
 * barrel would eagerly load the SDK too, since ES module imports evaluate the
 * whole file regardless of which export you asked for. Caught by actually
 * installing the built package into a scratch project and importing it with
 * no SDK present, not by inspection.
 */

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
should point at - the element that is wrong, not its container, and not the
element it collides with. The bounding boxes in the element list are the best
evidence for geometric bugs: overlapping boxes, boxes extending past a parent,
and boxes with a zero or negative gap are all visible in the numbers.

Only set "ref" to null when no listed element corresponds to the problem - for
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
