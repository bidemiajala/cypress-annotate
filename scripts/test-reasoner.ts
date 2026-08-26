/**
 * Exercises the reasoning step without credentials.
 *
 * The Claude call is driven through a stubbed fetch that returns a real SSE
 * stream, so request construction, stream handling and tool-use parsing are all
 * covered — the parts that would otherwise only fail on a live, billed call.
 */
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import {
  ClaudeReasoner,
  findingsToAnnotations,
  type BugFinding,
} from '../src/finder.js';
import type { InventoryItem } from '../src/inventory.js';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      console.log(`PASS  ${name}`);
      passed++;
    } catch (error) {
      console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    }
  })();
}

function sse(events: object[]): string {
  return events
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

function streamingResponse(toolInput: object): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_test', name: 'report_findings', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 42 },
    },
    { type: 'message_stop' },
  ];

  return new Response(sse(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const sampleInventory: InventoryItem[] = [
  {
    ref: 'e1',
    target: ['[data-annot-ref="e1"]'],
    reportSelector: '#submit',
    tag: 'button',
    role: null,
    name: 'Place order',
    rect: { x: 10, y: 20, width: 100, height: 40 },
    inViewport: true,
    framePath: [],
  },
];

// --- The live request path, through a stubbed transport -----------------------

let capturedBody: Record<string, unknown> | undefined;

const stubFetch: typeof fetch = async (_url, init) => {
  capturedBody = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
  return streamingResponse({
    findings: [
      {
        description: 'The Place order button overlaps the terms text.',
        evidence: 'Their bounding boxes intersect.',
        severity: 'blocker',
        ref: 'e1',
        region: null,
      },
      {
        description: 'Empty area where the delivery estimate should appear.',
        evidence: 'Blank space under the summary.',
        severity: 'minor',
        ref: null,
        region: { xPct: 10, yPct: 50, widthPct: 30, heightPct: 8 },
      },
    ],
  });
};

const reasoner = new ClaudeReasoner({
  client: new Anthropic({ apiKey: 'test-key-not-real', fetch: stubFetch }),
});

const findings = await reasoner.propose({
  screenshotPng: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  inventory: sampleInventory,
  ticket: 'CHK-1 place an order',
  url: 'https://example.test/checkout',
});

await check('request names the configured model', () => {
  assert.equal(capturedBody?.model, 'claude-opus-5');
});

await check('request declares the strict report_findings tool', () => {
  const tools = capturedBody?.tools as { name: string; strict: boolean; input_schema: unknown }[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'report_findings');
  assert.equal(tools[0]?.strict, true);
});

await check('strict schema lists every property as required', () => {
  const tools = capturedBody?.tools as { input_schema: any }[];
  const item = tools[0]?.input_schema.properties.findings.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(new Set(item.required), new Set(Object.keys(item.properties)));
});

await check('request uses adaptive thinking and an effort level', () => {
  assert.deepEqual(capturedBody?.thinking, { type: 'adaptive' });
  assert.equal((capturedBody?.output_config as { effort: string }).effort, 'high');
});

await check('request sends the screenshot and the inventory', () => {
  const messages = capturedBody?.messages as { content: any[] }[];
  const blocks = messages[0]?.content ?? [];
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].source.media_type, 'image/png');
  assert.match(blocks[1].text, /\[e1\] <button> "Place order"/);
  assert.match(blocks[1].text, /CHK-1 place an order/);
});

await check('streamed tool call is parsed into findings', () => {
  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.severity, 'blocker');
  assert.equal(findings[0]?.ref, 'e1');
  assert.equal(findings[1]?.ref, null);
  assert.equal(findings[1]?.region?.widthPct, 30);
});

// --- Resolution, including every fallback path -------------------------------

await check('a valid ref resolves to the injected selector', () => {
  const { resolved } = findingsToAnnotations(findings, sampleInventory);
  assert.deepEqual(resolved[0]?.annotation.selector, ['[data-annot-ref="e1"]']);
  assert.equal(resolved[0]?.key, 'sel:#submit');
});

await check('a region-only finding resolves to a region annotation', () => {
  const { resolved } = findingsToAnnotations(findings, sampleInventory);
  assert.equal(resolved[1]?.annotation.region?.xPct, 10);
  assert.equal(resolved[1]?.annotation.selector, undefined);
});

await check('a hallucinated ref falls back to its region', () => {
  const bad: BugFinding[] = [
    {
      description: 'x',
      evidence: 'y',
      severity: 'major',
      ref: 'e999',
      region: { xPct: 1, yPct: 2, widthPct: 3, heightPct: 4 },
    },
  ];
  const { resolved, unresolved } = findingsToAnnotations(bad, sampleInventory);
  assert.equal(unresolved.length, 0);
  assert.equal(resolved[0]?.annotation.region?.xPct, 1);
});

await check('a hallucinated ref with no region is reported, not dropped', () => {
  const bad: BugFinding[] = [
    { description: 'x', evidence: 'y', severity: 'major', ref: 'e999', region: null },
  ];
  const { resolved, unresolved } = findingsToAnnotations(bad, sampleInventory);
  assert.equal(resolved.length, 0);
  assert.match(unresolved[0]?.reason ?? '', /not in the inventory/);
});

// --- Malformed model output ---------------------------------------------------

await check('a refusal is surfaced as an error', async () => {
  const refusing = new ClaudeReasoner({
    client: new Anthropic({
      apiKey: 'test-key-not-real',
      fetch: async () =>
        new Response(
          sse([
            {
              type: 'message_start',
              message: {
                id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5',
                content: [], stop_reason: null, stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
            {
              type: 'message_delta',
              delta: { stop_reason: 'refusal', stop_sequence: null },
              usage: { output_tokens: 1 },
            },
            { type: 'message_stop' },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    }),
  });

  await assert.rejects(
    () =>
      refusing.propose({
        screenshotPng: Buffer.from([1]),
        inventory: sampleInventory,
        ticket: 't',
        url: 'u',
      }),
    /declined/,
  );
});

await check('an unknown severity is coerced rather than thrown away', async () => {
  const odd = new ClaudeReasoner({
    client: new Anthropic({
      apiKey: 'test-key-not-real',
      fetch: async () =>
        streamingResponse({
          findings: [
            { description: 'still a bug', evidence: 'e', severity: 'catastrophic', ref: 'e1', region: null },
            { description: '', evidence: 'e', severity: 'minor', ref: 'e1', region: null },
          ],
        }),
    }),
  });

  const out = await odd.propose({
    screenshotPng: Buffer.from([1]),
    inventory: sampleInventory,
    ticket: 't',
    url: 'u',
  });
  assert.equal(out.length, 1, 'the empty-description finding should be dropped');
  assert.equal(out[0]?.severity, 'minor');
});

console.log(`\n${passed}/${passed + failed} reasoner checks passed.\n`);
process.exit(failed === 0 ? 0 : 1);
