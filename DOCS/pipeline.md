# The Playwright pipeline and the reasoning layer

Two things ship in `cypress-annotate` that the Cypress plugin never touches: a
general Playwright-driven annotation pipeline, and a Claude-based reasoning layer
that looks at a page and works out *what's* wrong before drawing the box. This
document covers both. For the Cypress plugin, see the [README](../README.md).

Both are optional. `playwright` and `@anthropic-ai/sdk` are optional
`peerDependencies`, so install whichever your own usage calls into:

```bash
npm install playwright @anthropic-ai/sdk
npx playwright install chromium
```

The repo's own suites for this half:

```bash
npm run verify           # coordinate-pipeline alignment suite, 20 cases
npm run verify:image     # driver-agnostic (MCP) alignment suite, 10 cases
npm run test:reasoner    # Claude reasoning request/parse suite, 12 cases, no API key needed
npm run demo             # end-to-end on the buggy fixture, using recorded findings
npm run annotate -- --url https://example.com --selector 'a' --label 'Broken link'
```

## API

```ts
import { captureAnnotated } from 'cypress-annotate';

const result = await captureAnnotated('https://example.com', [
  { selector: '#submit', label: 'Misaligned by 12px', shape: 'box' },
  { selector: ['iframe#checkout', '.pay-button'], label: 'Overlaps' },
], { mode: 'element', cropPadding: 80, style: { dimOutside: 0.5 } });

await writeFile('bug.png', result.image);
console.log(result.elements, result.drawnRects, result.warnings);
```

`captureAnnotated()` is the only export in the package that launches a browser,
and it imports playwright lazily on first call. `annotateImage`, `runBugHunt`,
and `findingsToAnnotations` all work with no browser installed.

Or drive an existing Playwright page directly with
`annotate(page, annotations, options)`. That's the entry point the reasoning step
uses, since the agent already has a page open.

**Modes.** `viewport` captures what's on screen, scrolling the first target into
view first. `fullPage` captures the whole document. `element` captures full-page
then crops to the annotated region plus `cropPadding`, which is usually the most
useful thing to attach to a ticket.

**Result.** Alongside `image`, you get `rawImage` (same capture, same crop, no
overlay), the measured `elements`, the final `drawnRects` in image pixels, and
`warnings`.

**Warnings worth acting on:** selector matched more than one element, element has
a zero-sized box, element is outside the viewport, element is fixed during a
full-page capture.

### The region fallback

When no element corresponds to the problem (blank space where something should
be), a target can be a rectangle in percentages instead:

```ts
{ region: { xPct: 10, yPct: 50, widthPct: 30, heightPct: 8, basis: 'viewport' } }
```

`basis: 'viewport'` percentages are relative to the scroll position they were
measured at, which is why the hunt never scrolls between measuring and drawing.
`basis: 'document'` is absolute. Both paths are covered by the alignment suite
and land on the same pixels the selector path does.

## The reasoning step

Point it at a URL. That's the whole invocation:

```bash
npm run find-bugs -- --url https://news.ycombinator.com
```

A ticket is optional. With one, findings are judged against it. Without one, the
page is judged on its own terms.

```bash
npm run find-bugs -- --url https://your.app/checkout \
  --ticket "CHK-482: customer reviews the order and places it"
```

**The problem this solves.** A model cannot reliably invent a CSS selector by
looking at a screenshot. So it is never asked to. Before the screenshot is taken,
every candidate element is tagged with a `data-annot-ref` attribute and listed
for the model with its tag, accessible name and bounding box:

```
[e17] <button> "Apply" @ 1090,642 87x39 — #promo-apply
[e24] <span> "£244.99" @ 1262,1046 57x22 — #grand-total-value
```

The model returns a handle, which maps back to a selector guaranteed to resolve
because we injected it. The readable selector (`#promo-apply`) still goes in the
ticket. Those bounding boxes are also the model's best evidence for geometric
bugs, since overlapping boxes and boxes that run past a parent show up in the
numbers as clearly as in the pixels.

**Structured output.** Findings come back through a strict tool schema:

```json
{ "description": "...", "evidence": "...", "severity": "blocker", "ref": "e17", "region": null }
```

Severity drives the annotation colour. Every finding gets a cropped, dimmed
close-up, and each pass also produces an overview with numbered markers, because
full-sentence labels on an overview cover the rest of the page.

**Three resolution paths, all tested:** a valid handle resolves to its injected
selector; a handle the model invented falls back to the region it supplied; a
finding with neither is reported as unresolved rather than silently dropped.

**Viewport sweep.** `runBugHunt` works down the page one viewport at a time,
overlapping passes by 10%. A pass is the unit of correctness: the inventory, the
screenshot the model reasons over, and any percentage region it returns all share
one scroll position. Findings are de-duplicated across passes by readable
selector, since handles are re-issued each pass.

## Using this from a live agent session

When Claude is already driving a real browser, say a Playwright MCP or Chrome
DevTools MCP session that is logged in, the thing to avoid is opening a second
one. A second browser would not share the session and would land on the SSO login
page, so this path never opens one.

Three pieces:

- **[src/browser/measure-target.js](../src/browser/measure-target.js)** is a
  snippet to paste into whichever `evaluate` tool is live. Edit one line, run it,
  get `{ metrics, targets }` back. Both backends can write the result straight to
  a file (`filename` on Playwright MCP, `filePath` on Chrome DevTools MCP).
- **`npm run annotate-shot`** takes a PNG plus that JSON and draws the boxes. It
  never opens a browser and knows nothing about either backend.
- **[skills/annotate-bug/SKILL.md](../skills/annotate-bug/SKILL.md)** is the
  protocol written as a skill, with the exact tool calls for both backends. Copy
  it into `.claude/skills/`.

```bash
npm run annotate-shot -- --image shot.png --measurement measure.json \
  --label "Apply button escapes its card" --out annotated.png --crop
```

**The ordering rule that makes it work:** measure, then screenshot, with no
navigation, scroll, or click in between. A rectangle is only valid for the scroll
position it was measured at. Everything else the pipeline can recover from. This
it cannot.

**The scale is measured on every capture.** Both backends can hand back a resized
image, Playwright MCP via `scale: "css"` and Chrome DevTools MCP via
`--screenshot-max-width`, so `devicePixelRatio` describes the browser and says
nothing about the file on disk. `resolveScale()` compares the image against the
viewport it was supposed to cover, uses the measured ratio when the two disagree,
and prints a warning. `npm run verify:image` proves this holds at scales from 0.5
to 2.0, including a case downscaled to 900px from a 2560px capture.

If there is no element to point at (blank space where something should render),
`--region x,y,w,h` takes percentages of the viewport instead.

## How the reasoning step is verified

The live call has been run against the real API (see below). It is also tested
without credentials, so the suite stays runnable and free. `npm run test:reasoner`
drives `ClaudeReasoner` through a stubbed `fetch` that returns a real SSE stream,
covering request construction (model, strict tool schema, adaptive thinking, the
image and inventory blocks), stream handling, tool-use parsing, all three
resolution paths, refusals, and malformed model output. 12 checks.

`npm run demo` then runs the whole pipeline against
[fixtures/buggy-checkout.html](../fixtures/buggy-checkout.html), a page with five
deliberate bugs, using recorded findings in place of the model. The recorded
findings name real CSS selectors, which the replay translates into the handles
the model would have returned, so the resolution path under test is identical to
the live one. Two of the seven entries are deliberate fallback tests.

**To run it live**, copy `.env.example` to `.env` and put your key in it:

```bash
cp .env.example .env
# ANTHROPIC_API_KEY=sk-ant-...

npm run find-bugs -- --url https://your.app/checkout --ticket "CHK-482: ..."
```

`.env` is read by `scripts/find-bugs.ts` via `process.loadEnvFile` and is
gitignored. Exporting `ANTHROPIC_API_KEY` in your shell works too, as does an
`ant auth login` profile, and the SDK resolves credentials in that order. It
resolves them lazily, at request time rather than when the client is constructed,
so a missing key surfaces on the first request. The CLI catches that and prints
setup instructions instead of a stack trace.

The library itself never reads `.env`. Only the CLI does, so importing
`annotate()` or `ClaudeReasoner` into your own program leaves credential handling
to you.

### What the first live runs showed

On [fixtures/buggy-checkout.html](../fixtures/buggy-checkout.html) with **no
ticket**, Claude found 4 of the 5 planted bugs, every selector resolved, and
nothing was unresolved. It missed the `#place-order` button overlapping the terms
text.

The evidence it gave is the part that matters, because it shows the design
premise holding up. It reasons from the bounding boxes as much as from the
pixels:

> `#postcode-field`: "e10/e11/e12 start at x=419 while all other fields (e3, e7,
> e9, e13) start at x=385, and the input is narrower (476 vs 510)."

Two real bugs surfaced from pointing it at Hacker News, both now fixed and
covered by the alignment suite:

- **Quirks mode.** HN has no doctype, so `documentElement.clientHeight` returns
  the *content* height (1214) instead of the viewport height (900). The sweep
  concluded the page fit on one screen, and percentage regions were measured
  against the wrong height. Metrics now use `window.innerWidth/innerHeight`, and
  [fixtures/quirks-page.html](../fixtures/quirks-page.html) covers it.
- **Stale handles.** Each pass restarts its counter at `e1`, but the previous
  pass's attributes were still in the DOM, so `[data-annot-ref="e5"]` could match
  two elements and annotate the wrong one. The collector now clears stale handles
  before tagging.

Both surfaced from the pipeline reporting its own warnings, which is the argument
for keeping `warnings` in the report.

## Known limits

- Findings vary between runs on the same page, as you'd expect. Two runs of the
  Hacker News front page returned three findings and one.
- Judgement is not calibrated. The missing-domain finding on Hacker News is
  arguably a false positive, since HN legitimately shows no domain for text
  posts. The model considered that and reported it anyway.
- `element` mode captures full-page and then crops, which is wasteful on very
  long pages. Fine at this stage, worth revisiting if it becomes a bottleneck.
- The inventory covers the main document and same-origin iframes. Cross-origin
  frames are skipped, so bugs inside them will not be found.
- Overview labels can still overlap each other when findings are close together.

## What's next here

Selector accuracy looks like the solved part. Across the live runs so far, every
handle Claude picked resolved to the element it described, and no real page has
needed the region fallback yet.

The open question has shifted to **judgement**, meaning precision and recall.
Claude missed the button and text overlap on the fixture, and its Hacker News
finding is arguably a false positive. Worth running against pages with known
defects and counting both the misses and the false alarms. `report.json` already
carries what that needs: `selector` is what Claude chose, `resolvedTo` is what
got annotated, `warnings` flags ambiguity, and `unresolved` lists what it could
not point at.
