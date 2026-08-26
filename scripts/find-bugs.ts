/**
 * Step 2 runner: reason about a page, then annotate what comes back.
 *
 * `--replay <file>` swaps the Claude call for a recorded set of findings, so
 * the plumbing between reasoning and annotation can be exercised without an API
 * key and without paying for a call on every run.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { runBugHunt } from '../src/pipeline.js';
import {
  ClaudeReasoner,
  type BugFinding,
  type Reasoner,
  type ReasonerInput,
  type Severity,
} from '../src/finder.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

/**
 * Read .env into the environment if it exists.
 *
 * This lives in the CLI rather than in the library because importing a module
 * should not read files from disk — code that uses `annotate()` or
 * `ClaudeReasoner` from its own program supplies credentials its own way.
 */
function loadDotEnv(): boolean {
  try {
    process.loadEnvFile(ENV_PATH);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const CREDENTIAL_HELP = `
No Anthropic credentials found.

Create a .env file in the project root (copy .env.example):

    ANTHROPIC_API_KEY=sk-ant-...

Get a key at https://console.anthropic.com/settings/keys

Alternatives: export ANTHROPIC_API_KEY in your shell, or install the Anthropic
CLI and run "ant auth login" — the SDK picks up a stored profile with no env var.

To try the pipeline without a key, use --replay:

    npm run demo
`.trim();

const USAGE = `
Usage: npm run find-bugs -- --url <url> [options]

  --url <url>        Page to examine. Accepts a local path or a URL.
  --ticket <text>    Optional. What the page is supposed to do. Without it the
                     page is judged on its own terms.
  --replay <file>    Use recorded findings instead of calling Claude.
  --out-dir <dir>    Where to write images and the report. Default: out/bugs
  --model <id>       Default: claude-opus-5
  --effort <level>   low | medium | high | xhigh | max. Default: high
  --width/--height   Viewport size, CSS px. Default 1280x900.
  --dpr <n>          Device scale factor. Default 2.
  --max-passes <n>   Viewport passes down the page; one API call each. Default 6.
`.trim();

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    ticket: { type: 'string' },
    replay: { type: 'string' },
    'out-dir': { type: 'string', default: 'out/bugs' },
    model: { type: 'string' },
    effort: { type: 'string' },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '900' },
    dpr: { type: 'string', default: '2' },
    'max-passes': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || !values.url) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

interface ExpectedEntry {
  selector?: string;
  region?: BugFinding['region'];
  severity: Severity;
  description: string;
  evidence: string;
}

/**
 * Stands in for the model. Recorded findings name a real CSS selector, which is
 * translated into the inventory handle the model would have returned — so the
 * resolution path under test is identical to the live one.
 */
class ReplayReasoner implements Reasoner {
  constructor(private readonly entries: ExpectedEntry[]) {}

  async propose(input: ReasonerInput): Promise<BugFinding[]> {
    return this.entries.map((entry) => {
      const match = entry.selector
        ? input.inventory.find((item) => item.reportSelector === entry.selector)
        : undefined;
      return {
        description: entry.description,
        evidence: entry.evidence,
        severity: entry.severity,
        // An unmatched selector yields a ref the inventory does not contain,
        // which is exactly the hallucinated-handle case.
        ref: entry.selector ? (match?.ref ?? `missing:${entry.selector}`) : null,
        region: entry.region ?? null,
      };
    });
  }
}

function slug(text: string, number: number): string {
  return `${String(number).padStart(2, '0')}-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 44).replace(/-+$/, '')}`;
}

const outDir = values['out-dir'] as string;
await mkdir(outDir, { recursive: true });

let ticket = values.ticket ?? '';
let reasoner: Reasoner;
let envLoaded = false;

if (values.replay) {
  const recorded = JSON.parse(await readFile(values.replay, 'utf8')) as {
    ticket: string;
    expected: ExpectedEntry[];
  };
  ticket = ticket || recorded.ticket;
  reasoner = new ReplayReasoner(recorded.expected);
  console.log(`Replaying ${recorded.expected.length} recorded findings (no API call).`);
} else {
  envLoaded = loadDotEnv();
  reasoner = new ClaudeReasoner({
    model: values.model,
    effort: values.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
  });
}

const target = /^[a-z]+:\/\//i.test(values.url) ? values.url : pathToFileURL(values.url).href;

/**
 * The SDK resolves credentials lazily, at request time rather than at
 * construction, so a missing key surfaces here as a stream error — not when the
 * client is built.
 */
function isCredentialError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /could not resolve authentication|authentication_error|invalid x-api-key|401/i.test(message);
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: Number(values.width), height: Number(values.height) },
    deviceScaleFactor: Number(values.dpr),
  });
  const page = await context.newPage();
  await page.goto(target, { waitUntil: 'networkidle' });

  const result = await runBugHunt(page, {
    ticket,
    reasoner,
    maxPasses: values['max-passes'] ? Number(values['max-passes']) : undefined,
  });

  for (const pass of result.passes) {
    if (pass.overview) await writeFile(`${outDir}/pass-${pass.index}-overview.png`, pass.overview);
  }
  for (const item of result.annotated) {
    await writeFile(`${outDir}/${slug(item.finding.description, item.number)}.png`, item.image);
  }

  await writeFile(
    `${outDir}/report.json`,
    JSON.stringify(
      {
        url: target,
        ticket,
        passes: result.passes.map((p) => ({
          index: p.index,
          scrollY: p.scrollY,
          inventorySize: p.inventorySize,
          findingCount: p.findingCount,
        })),
        inventorySize: result.inventory.length,
        findings: result.annotated.map((a) => ({
          number: a.number,
          severity: a.finding.severity,
          description: a.finding.description,
          evidence: a.finding.evidence,
          selector: a.reportSelector,
          resolvedTo: a.resolvedTo,
          pass: a.pass,
          drawnRect: a.drawnRect,
          warnings: a.warnings,
        })),
        unresolved: result.unresolved,
      },
      null,
      2,
    ),
  );

  const passSummary = result.passes.map((p) => `${p.index}@y=${p.scrollY}`).join(', ');
  console.log(`\nPasses: ${result.passes.length} (${passSummary})`);
  console.log(`Inventory: ${result.inventory.length} unique elements`);
  console.log(`Annotated: ${result.annotated.length}, unresolved: ${result.unresolved.length}\n`);
  for (const item of result.annotated) {
    const rect = item.drawnRect;
    console.log(
      `  #${item.number} [${item.finding.severity}] ${item.finding.description.slice(0, 64)}\n` +
        `      -> ${item.reportSelector ?? item.resolvedTo}` +
        (rect ? ` @ ${Math.round(rect.width)}x${Math.round(rect.height)}px` : ''),
    );
    for (const warning of item.warnings) console.log(`      ! ${warning}`);
  }
  for (const item of result.unresolved) {
    console.log(`  [unresolved] ${item.finding.description.slice(0, 58)} — ${item.reason}`);
  }
  console.log(`\nWrote images and report.json to ${outDir}/\n`);
} catch (error) {
  if (!isCredentialError(error)) throw error;
  console.error(`\n${CREDENTIAL_HELP}\n`);
  console.error(
    envLoaded
      ? `(Read ${ENV_PATH}, but it did not set a usable key.)\n`
      : `(No .env found at ${ENV_PATH}.)\n`,
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
