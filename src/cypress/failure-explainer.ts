import Anthropic from '@anthropic-ai/sdk';
import type { FailureRecord } from './failure-report.js';

/**
 * Claude fallback for the failures registerFailureCapture could not resolve
 * deterministically - no selector recovered, or the recovered selector matched
 * nothing live. Deliberately a separate, narrower task from finder.ts's
 * open-ended bug hunting: the failure is already known (err.message says so);
 * the only open question is *where on screen it shows up*, from a fixed list
 * of candidate elements captured live at failure time. That's a smaller,
 * cheaper, more constrained ask than "find bugs on this page".
 */

export interface FailureExplanation {
  /** One of the inventory selectors from the record, or null if none fit. */
  selector: string | null;
  label: string;
  /** Fallback region (percent of viewport) when no inventory item fits. */
  region: { xPct: number; yPct: number; widthPct: number; heightPct: number } | null;
}

export interface FailureExplainer {
  explain(record: FailureRecord): Promise<FailureExplanation>;
}

const SCHEMA = {
  type: 'object',
  properties: {
    selector: {
      type: ['string', 'null'],
      description:
        'The "selector" value of the single inventory element that best shows where this failure is ' +
        'visible on screen. Null only if no listed element corresponds to it.',
    },
    label: {
      type: 'string',
      description: 'One short sentence for the annotation, explaining the failure in plain terms.',
    },
    region: {
      type: ['object', 'null'],
      description: 'Fallback used only when selector is null: the area to box, in percentages of the viewport.',
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
  required: ['selector', 'label', 'region'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `A Cypress test failed. You are given the screenshot at the moment of failure,
the test's own error message, and a list of candidate elements on the page with their
tag, visible text, and bounding box in CSS pixels.

This is not exploratory bug hunting - the failure is already known and described by the
error message. Your only job is to say where on screen it is visible, by picking the
single best-matching element from the list, and to write one short, plain-language
sentence explaining it for someone triaging CI failures who has not read the error.

Prefer an element whose visible text or position plausibly explains the error message
over one that merely has a similar name. If nothing in the list corresponds to the
failure - for example the error describes something absent, like a modal that should
have appeared - set selector to null and give a region instead, as percentages of the
viewport, for roughly where it was expected.

Always call the report tool exactly once.`;

function renderInventory(inventory: FailureRecord['inventory']): string {
  if (!inventory) return '(no candidate elements captured)';
  return inventory
    .map((item) => {
      const r = item.rect;
      const box = r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : '?';
      const text = item.text ? ` "${item.text}"` : '';
      return `[${item.selector}] <${item.tag ?? '?'}>${text} @ ${box}`;
    })
    .join('\n');
}

export interface ClaudeFailureExplainerOptions {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  client?: Anthropic;
}

export class ClaudeFailureExplainer implements FailureExplainer {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  constructor(options: ClaudeFailureExplainerOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? 'claude-opus-5';
    this.effort = options.effort ?? 'medium';
  }

  async explain(record: FailureRecord): Promise<FailureExplanation> {
    const { readFile } = await import('node:fs/promises');
    const screenshot = await readFile(record.screenshotPath);

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort },
      tools: [
        {
          name: 'report_location',
          description: 'Report where the known failure is visible on screen.',
          input_schema: SCHEMA as unknown as Anthropic.Tool['input_schema'],
          strict: true,
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot.toString('base64') } },
            {
              type: 'text',
              text:
                `Test: ${record.test}\n` +
                `Error: ${record.errMessage}\n\n` +
                `Candidate elements:\n${renderInventory(record.inventory)}`,
            },
          ],
        },
      ],
    });

    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      throw new Error(`Model declined (${message.stop_details?.category ?? 'unknown'}).`);
    }

    const call = message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'report_location',
    );
    if (!call) throw new Error(`Model did not call report_location (stop_reason: ${message.stop_reason}).`);

    const input = call.input as Partial<FailureExplanation>;
    return {
      selector: typeof input.selector === 'string' ? input.selector : null,
      label: typeof input.label === 'string' && input.label ? input.label : record.label,
      region: input.region ?? null,
    };
  }
}

/** For tests and offline runs - no API call. */
export class ReplayFailureExplainer implements FailureExplainer {
  constructor(private readonly explanation: FailureExplanation) {}
  async explain(): Promise<FailureExplanation> {
    return this.explanation;
  }
}
