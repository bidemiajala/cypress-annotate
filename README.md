# cypress-annotate

Claude looks at a page, says what's broken, and gets an annotated screenshot
pointing at exactly the pixels it means.

- **Step 1 — the annotation pipeline.** Selector in, accurately boxed screenshot
  out. Coordinate maths verified against painted pixels.
- **Step 2 — the reasoning step.** Claude examines the page and returns
  structured findings; the selectors it names are guaranteed to resolve.
- **Step 4 — agent integration.** A driver-agnostic path that annotates a
  screenshot captured by whichever browser MCP is connected, with no browser of
  its own. See [Using this from a live agent session](#using-this-from-a-live-agent-session).

```bash
npm install
npx playwright install chromium

npm run verify          # step 1: alignment suite, 20 cases
npm run verify:image    # step 4: driver-agnostic alignment, 10 cases
npm run test:reasoner   # step 2: request/parse suite, 12 cases, no API key needed
npm run test:cypress    # cypress plugin, 7 cases, real Cypress 15
npm run test:failure-selector  # failed-test selector recovery, 12 cases, no browser
npm run test:cypress-failures  # failed-test capture end-to-end, 4 cases, real Cypress 15
npm run demo            # end-to-end on the buggy fixture, using recorded findings

npm run annotate -- --url https://example.com --selector 'a' --label 'Broken link'
```

## Installing this as a package in another project

Not published to npm — install directly from the private GitHub repo:

```bash
npm install github:bidemiajala/cypress-annotate
# or, pinned to a commit: github:bidemiajala/cypress-annotate#e0f40dc
```

That needs read access to the repo (it's private) — either an SSH key on the
installing machine that has access, or `npm install git+https://<token>@github.com/bidemiajala/cypress-annotate.git`
with a GitHub personal access token that has repo read scope.

**The build runs automatically.** This repo ships TypeScript source, not
compiled output — `dist/` is gitignored. npm's `prepare` script (`tsc` + a
small asset-copy step) runs on install for exactly this case: a package
installed as a git dependency. Confirmed by actually installing it into a
scratch project and importing both entry points, not assumed.

**Three independent entry points, so installing one doesn't drag in the others:**

```ts
// The core pipeline — playwright is a peer dependency, but only
// captureAnnotated() actually needs it, loaded lazily on first call.
// annotateImage/runBugHunt/findingsToAnnotations work with no browser installed.
import { annotateImage, runBugHunt, captureAnnotated } from 'cypress-annotate';

// Claude-backed reasoning — needs @anthropic-ai/sdk. Deliberately not part of
// the root import above: pulling it in from there would have forced the SDK
// on every consumer, including ones who only want annotateImage.
import { ClaudeReasoner } from 'cypress-annotate/reasoner';

// The Cypress plugin — needs neither playwright nor the Anthropic SDK.
import { registerAnnotateTasks } from 'cypress-annotate/cypress/task';
import 'cypress-annotate/cypress/commands';
import { registerFailureCapture } from 'cypress-annotate/cypress/failure-hook';
```

`playwright`, `@anthropic-ai/sdk`, and `cypress` are all `peerDependencies`,
marked optional — npm won't install any of them for you, and won't warn
loudly if you skip them, as long as you only use entry points that don't need
them. Install whichever ones your own usage actually calls into.

This is confirmed, not assumed: the first attempt at this split missed a case
— `ClaudeReasoner` originally lived in the same file as several
Anthropic-free utility functions that the root barrel re-exports, so
importing anything from `'cypress-annotate'` at all (even `annotateImage`) threw
`ERR_MODULE_NOT_FOUND` for `@anthropic-ai/sdk`, regardless of whether you
touched `ClaudeReasoner`. Caught by installing the built package into an
isolated scratch project with neither peer present and actually importing
each entry point — not by reading the code — since ES module imports
evaluate a whole file's top-level code as soon as anything is imported from
it, peer-optional or not.

## The coordinate rules

Four things have to line up, and each one is a separate opportunity to be a few
pixels off. These are the rules the pipeline follows.

**1. `getBoundingClientRect()` is viewport-relative and post-transform.**
It already accounts for CSS transforms, internally scrolled ancestors, and
sub-pixel layout. It does *not* account for page scroll or iframes.

**2. Scroll offset applies only to a full-page capture, and only for elements
that scroll.** A viewport screenshot is in the same space the rect is already in,
so adding scroll there is the classic off-by-a-scroll bug. A full-page screenshot
is document space, so `rect + scrollX/scrollY`. But a `position: fixed` element
has no document position — see the fixed-element note below.

**3. Device pixel ratio scales CSS px to image px, but verify it rather than
trusting it.** `resolveScale()` in [src/annotate.ts](src/annotate.ts) checks the
produced image against `cssWidth × devicePixelRatio`; if they disagree by more
than 2px it derives the real scale from the image and records a warning. Stroke
widths, font sizes and padding are all specified in CSS px and multiplied by that
same scale, so annotations look identical at dpr 1, 2 and 3.

**4. Iframes add their content origin, not their border box.** The offset is
`iframeRect.left + borderLeftWidth + paddingLeft`. A frame's own internal scroll
needs no correction — a rect measured inside the frame is already relative to
that frame's viewport.

### The fixed-element trap

Chromium's full-page capture paints `position: fixed` elements **once**, at
whatever scroll offset the capture started from. So for a fixed element there is
no correct "document position", and adding scroll to it puts the box thousands of
pixels away from the thing it should mark.

The pipeline detects fixed ancestry during measurement, skips the scroll
correction for those elements, scrolls to the top before full-page captures by
default (`scrollToTop`), and emits a warning so the caller knows why.

## API

```ts
import { captureAnnotated } from './src/index.js';

const result = await captureAnnotated('https://example.com', [
  { selector: '#submit', label: 'Misaligned by 12px', shape: 'box' },
  { selector: ['iframe#checkout', '.pay-button'], label: 'Overlaps' },
], { mode: 'element', cropPadding: 80, style: { dimOutside: 0.5 } });

await writeFile('bug.png', result.image);
console.log(result.elements, result.drawnRects, result.warnings);
```

Or drive an existing Playwright page directly with `annotate(page, annotations, options)`
— that's the entry point step 2 will use, since the agent will already have a page open.

**Modes.** `viewport` captures what's on screen (scrolling the first target into
view first). `fullPage` captures the whole document. `element` captures full-page
then crops to the annotated region plus `cropPadding`, which is usually the most
useful thing to attach to a ticket.

**Result.** Alongside `image`, you get `rawImage` (same capture, same crop, no
overlay), the measured `elements`, the final `drawnRects` in image pixels, and
`warnings`.

**Warnings worth acting on:** selector matched more than one element, element has
a zero-sized box, element is outside the viewport, element is fixed during a
full-page capture.

### The region fallback

When no element corresponds to the problem — blank space where something should
be — a target can instead be a rectangle in percentages:

```ts
{ region: { xPct: 10, yPct: 50, widthPct: 30, heightPct: 8, basis: 'viewport' } }
```

`basis: 'viewport'` percentages are relative to the scroll position they were
measured at, which is why the hunt never scrolls between measuring and drawing.
`basis: 'document'` is absolute. Both paths are covered by the alignment suite
and land on the same pixels the selector path does.

## Step 2 — the reasoning step

Point it at a URL. That's the whole invocation:

```bash
npm run find-bugs -- --url https://news.ycombinator.com
```

A ticket is optional. With one, findings are judged against it; without one, the
page is judged on its own terms.

```bash
npm run find-bugs -- --url https://your.app/checkout \
  --ticket "CHK-482 — customer reviews the order and places it"
```

**The problem this solves.** A model cannot reliably invent a CSS selector by
looking at a screenshot. So it is never asked to. Before the screenshot is taken,
every candidate element is tagged with a `data-annot-ref` attribute and listed
for the model with its tag, accessible name and bounding box:

```
[e17] <button> "Apply" @ 1090,642 87x39 — #promo-apply
[e24] <span> "£244.99" @ 1262,1046 57x22 — #grand-total-value
```

The model returns a handle, not a selector, and the handle maps back to a
selector that is guaranteed to resolve because we injected it. The readable
selector (`#promo-apply`) still goes in the ticket. The bounding boxes are also
the model's best evidence for geometric bugs — overlapping boxes and boxes
extending past a parent are visible in the numbers, not just the pixels.

**Structured output.** Findings come back through a strict tool schema:

```json
{ "description": "...", "evidence": "...", "severity": "blocker", "ref": "e17", "region": null }
```

Severity drives the annotation colour. Every finding gets a cropped, dimmed
close-up; each pass also produces an overview with numbered markers, because
full-sentence labels on an overview cover the rest of the page.

**Three resolution paths, all tested:** a valid handle resolves to its injected
selector; a handle the model invented falls back to the region it supplied; a
finding with neither is reported as unresolved rather than silently dropped.

**Viewport sweep.** `runBugHunt` works down the page one viewport at a time,
overlapping passes by 10%. A pass is the unit of correctness: the inventory, the
screenshot the model reasons over, and any percentage region it returns all
share one scroll position. Findings are de-duplicated across passes by readable
selector, since handles are re-issued each pass.

## Using this from a live agent session

When Claude is already driving a real browser — a Playwright MCP or Chrome
DevTools MCP session that is logged in — the thing to avoid is opening a second
browser. It would not share the session and would land on the SSO login page.
So this path never opens one.

Three pieces:

- **[src/browser/measure-target.js](src/browser/measure-target.js)** — a snippet
  to paste into whichever `evaluate` tool is live. Edit one line, run it, get
  `{ metrics, targets }` back. Both backends can write the result straight to a
  file (`filename` on Playwright MCP, `filePath` on Chrome DevTools MCP).
- **`npm run annotate-shot`** — takes a PNG plus that JSON and draws the boxes.
  It never opens a browser and knows nothing about either backend.
- **[skills/annotate-bug/SKILL.md](skills/annotate-bug/SKILL.md)** — the protocol
  written as a skill, with the exact tool calls for both backends. Copy it into
  `.claude/skills/`.

```bash
npm run annotate-shot -- --image shot.png --measurement measure.json \
  --label "Apply button escapes its card" --out annotated.png --crop
```

**The ordering rule that makes it work:** measure, then screenshot, with no
navigation, scroll, or click in between. A rectangle is only valid for the scroll
position it was measured at. Everything else the pipeline can recover from; this
it cannot.

**Why the scale is measured, not trusted.** Both backends can hand back a resized
image — Playwright MCP via `scale: "css"`, Chrome DevTools MCP via
`--screenshot-max-width` — so `devicePixelRatio` is a claim about the browser,
not about the file. `resolveScale()` compares the image against the viewport it
was supposed to cover and uses the measured ratio when they disagree, printing a
warning. `npm run verify:image` proves this holds at scales from 0.5 to 2.0,
including a case downscaled to 900px from a 2560px capture.

If there is no element to point at — blank space where something should render —
`--region x,y,w,h` takes percentages of the viewport instead.

## Cypress plugin

For annotating *known* failures in an existing Cypress suite — no AI involved.
Cypress runs in the browser, so `getBoundingClientRect()` is right there; only
the compositing has to happen in Node, via a task.

```ts
// cypress.config.ts
import { registerAnnotateTasks } from 'cypress-annotate/cypress/task';

export default defineConfig({
  e2e: { setupNodeEvents(on) { registerAnnotateTasks(on); } },
});

// cypress/support/e2e.ts
import 'cypress-annotate/cypress/commands';
```

```ts
cy.annotate('#promo-apply', { label: 'Apply button escapes its card', crop: true });

// or several at once
cy.annotate(['#promo-apply', '#order-ref'], { label: ['Escapes its card', 'Overflows'] });
```

It overwrites the screenshot Cypress recorded, so the annotated image is what
lands in your reports and CI artifacts. It yields the result — `drawnRects`,
`scale`, `warnings` — so tests can assert on it.

Run this repo's suite with `npm run test:cypress` (7 cases, real Cypress 15).

### Annotating failed test runs

For "the wrong text showed" and similar assertion failures, most of the time you
don't need Claude at all. Register once:

```ts
// cypress/support/e2e.ts
import { registerFailureCapture } from 'cypress-annotate/cypress/failure-hook';
registerFailureCapture();
```

```ts
// cypress.config.ts — required, so this hook's screenshot isn't racing
// Cypress's own automatic one
export default defineConfig({ screenshotOnRunFailure: false, ... });
```

On every failed test it recovers the selector the failing command was targeting
— `cy.state('current')`'s own args when available, chai-jquery's `<tag#id>`
rendering in the error message as fallback — measures that element live while
the page is still in its failed state, scrolls it into view if needed, and
draws a box labelled from the assertion's own values:

> Expected "THIS WILL NOT MATCH" but got "£244.99"

That label is built entirely from `err.expected`/`err.actual`
(chai-quote-unwrapped — see below), with **zero LLM calls**. It writes one
record per failure to `out/cypress/failures.json` (path configurable):
selector, source, expected/actual, the annotated image path, and warnings.

**When no selector can be recovered** — an existence check, a `cy.contains()`
chain, a generic page-state assertion — there's nothing to box
deterministically. Those failures still get captured for free: a plain
screenshot plus a live inventory of candidate elements (same shape as the MCP
skill's), because a screenshot alone carries no DOM information and the browser
session will be gone by the time anyone looks at this. Calling Claude on them is
a separate, explicit step:

```bash
npm run explain-failures                          # scans failures.json, costs API calls
npm run explain-failures -- --replay recorded.json # no API call, for testing
```

### Cypress Cloud

**Confirmed working**, not just expected to: a `cy.screenshot()` call taken from
an `afterEach` hook, then overwritten in place with the annotation before the
run ends, is picked up by `cypress run --record` and uploaded as a normal
`Screenshot` cloud artifact — the same category label and pipeline as any other
Cypress screenshot. Verified against a real project with `--record`; the
uploaded image showed the box.

That confirmation replaced an earlier, more "obviously safe"-looking design:
overwriting Cypress's own *automatic* on-failure screenshot in place instead of
taking a second one, on the theory that mutating the file Cypress itself
already tracks removes all doubt. It doesn't work — that automatic screenshot
turned out to include the full Runner UI (command log sidebar, browser
toolbar, the app rendered at some auto-computed zoom, not a 1:1 capture), so
there's no reliable coordinate math to draw a box on it at all. The
`cy.screenshot({capture: 'viewport'})` this hook actually takes is a clean,
predictable capture — the same one every alignment test in this repo is
verified against — and per the `--record` result above, uploading it is not a
trade-off against Cloud compatibility.

This only touches the failures the deterministic pass couldn't resolve — it
never runs automatically during `cypress run`. That split is deliberate: every
CI run captures data for free; nothing calls Claude, spends money, or needs
`ANTHROPIC_API_KEY` available to the test job unless a human (or a separate CI
step) explicitly asks for the explanation. Run `npm run test:cypress-failures`
to see all four cases (resolved via command state, resolved via message
fallback, unresolved-with-inventory, fully unrecoverable) captured for real, and
`npm run test:failure-selector` for the pure selector-recovery logic (12 cases,
no browser).

**A pitfall worth knowing if you write your own chai assertions against
`err.expected`/`err.actual`:** they are chai's own quoted rendering of the
value, not the raw value — `.should('have.text', 'X')` puts the five-character
string `'X'` (with the quote marks) in `err.expected`, not `X`. This was wrong
in an early version of this feature, confirmed and fixed by running a real
Cypress failure and inspecting the actual field rather than trusting the
assumption.

**Three Cypress-specific traps, all handled:**

- **Full-page capture repeats fixed elements.** Cypress builds a full-page
  screenshot by scrolling and stitching, so `position: fixed` and `sticky`
  elements are painted several times in one image. Viewport capture is therefore
  the default and `fullPage` is opt-in with a warning in the docs.
- **`cy.scrollIntoView()` always scrolls**, unlike Playwright's
  `scrollIntoViewIfNeeded`. Calling it unconditionally shoved a perfectly
  visible element up under the fixed header, where the annotation was correct
  but the element was hidden behind it. The command now measures first and only
  scrolls when the element is genuinely not fully visible, leaving 120px of
  clearance when it does.
- **Cypress scales the app when the window is smaller than the viewport**, and
  the screenshot may not be `viewport × devicePixelRatio`. The same
  `resolveScale()` that handles MCP rescaling covers this.

**If Cypress fails to start with "bad option: --no-sandbox"**, something in your
environment has set `ELECTRON_RUN_AS_NODE=1` — VS Code's extension host does.
Cypress's binary is Electron, so it starts as plain Node and rejects Chromium
flags. `npm run test:cypress` goes through
[scripts/run-cypress.ts](scripts/run-cypress.ts), which strips that variable.

**Worth knowing for any visual assertion in Cypress:** Electron's macOS capture
applies a colour-profile shift. A fixture painted `#FF00E4` comes back as
`rgb(234,51,221)`. Exact-colour assertions against your stylesheet will fail, so
the test suite samples the rendered colour from the image instead of trusting
the CSS value.

## How alignment is verified

Eyeballing a screenshot does not prove pixel accuracy, so nothing here relies on it.

Every target in [fixtures/test-page.html](fixtures/test-page.html) is painted a
flat, unique colour with no radius, border or shadow — so the pixels it paints
are exactly its border box. [scripts/verify.ts](scripts/verify.ts) scans the
un-annotated capture for that colour, recovers the element's true pixel
footprint, and compares it against the rect the pipeline computed.

16 cases pass: dpr 1/2/3, CSS transforms, iframe nesting with border and padding,
internally scrolled containers, below-the-fold targets under both auto-scroll and
manual scroll, full-page and cropped captures, fixed elements under scroll, and
the percentage-region fallback in both bases.

Residual drift is ≤1.13px at dpr 3 and is entirely scanner quantisation, not
pipeline error: `#target-top` sits at y=147.375 CSS px, so its top edge falls on
device pixel 294.75 and the partially-covered row 294 fails the colour test. Its
x is an integer and the horizontal delta is exactly 0.00. The same 0.5-device-pixel
signature shows up on every case, always on the axis with a fractional coordinate.

## How the reasoning step is verified

The live call has been run against the real API (see below). It is also tested
without credentials, so the suite stays runnable and free: `npm run test:reasoner` drives
`ClaudeReasoner` through a stubbed `fetch` that returns a real SSE stream, which
covers request construction (model, strict tool schema, adaptive thinking, the
image and inventory blocks), stream handling, tool-use parsing, all three
resolution paths, refusals, and malformed model output. 12 checks.

`npm run demo` then runs the whole pipeline against
[fixtures/buggy-checkout.html](fixtures/buggy-checkout.html) — a page with five
deliberate bugs — using recorded findings in place of the model. The recorded
findings name real CSS selectors, which the replay translates into the handles
the model would have returned, so the resolution path under test is identical to
the live one. Two of the seven entries are deliberate fallback tests.

**To run it live**, copy `.env.example` to `.env` and put your key in it:

```bash
cp .env.example .env
# ANTHROPIC_API_KEY=sk-ant-...

npm run find-bugs -- --url https://your.app/checkout --ticket "CHK-482 — …"
```

`.env` is read by `scripts/find-bugs.ts` via `process.loadEnvFile` and is
gitignored. Exporting `ANTHROPIC_API_KEY` in your shell works too, as does an
`ant auth login` profile — the SDK resolves credentials in that order. It does so
lazily, at request time rather than when the client is constructed, so a missing
key surfaces once the first request is made; the CLI catches that and prints
setup instructions instead of a stack trace.

The library itself never reads `.env` — only the CLI does, so importing
`annotate()` or `ClaudeReasoner` into your own program leaves credential handling
to you.

### What the first live runs showed

On [fixtures/buggy-checkout.html](fixtures/buggy-checkout.html) with **no ticket**,
Claude found 4 of the 5 planted bugs, every selector resolved, and nothing was
unresolved. It missed the `#place-order` button overlapping the terms text.

The evidence it gave is the part worth noting, because it confirms the design
premise — it reasons from the bounding boxes, not only the pixels:

> `#postcode-field` — "e10/e11/e12 start at x=419 while all other fields (e3, e7,
> e9, e13) start at x=385, and the input is narrower (476 vs 510)."

Two real bugs surfaced from pointing it at Hacker News, both now fixed and
covered by the alignment suite:

- **Quirks mode.** HN has no doctype, so `documentElement.clientHeight` returns
  the *content* height (1214) instead of the viewport height (900). The sweep
  concluded the page fit on one screen, and percentage regions were measured
  against the wrong height. Metrics now use `window.innerWidth/innerHeight`, and
  [fixtures/quirks-page.html](fixtures/quirks-page.html) covers it.
- **Stale handles.** Each pass restarts its counter at `e1`, but the previous
  pass's attributes were still in the DOM, so `[data-annot-ref="e5"]` could match
  two elements and annotate the wrong one. The collector now clears stale
  handles before tagging.

Both were caught by the pipeline reporting its own warnings rather than by
inspecting output, which is the argument for keeping `warnings` in the report.

## Known limits

- Findings vary between runs on the same page, as you'd expect. Two runs of the
  Hacker News front page returned three findings and one.
- Judgement is not calibrated: the missing-domain finding on Hacker News is
  arguably a false positive, since HN legitimately shows no domain for text
  posts. The model considered that and reported it anyway.
- `element` mode captures full-page and then crops, which is wasteful on very
  long pages. Fine at this stage; worth revisiting if it becomes a bottleneck.
- Label pill widths are estimated from an average glyph ratio, because librsvg
  gives no text measurement API. Long labels get slightly generous padding.
- Only Chromium is exercised. The fixed-element behaviour in rule 2 is
  specifically a Chromium capture behaviour and would need re-checking elsewhere.
- The inventory covers the main document and same-origin iframes. Cross-origin
  frames are skipped, so bugs inside them will not be found.
- Overview labels can still overlap each other when findings are close together.

## Next: step 3

Selector accuracy is looking like the solved part — across the live runs so far,
every handle Claude picked resolved to the element it described, and nothing has
needed the region fallback yet on a real page.

The open question has shifted to **judgement**: precision and recall, not
targeting. It missed the button/text overlap on the fixture, and its Hacker News
finding is arguably a false positive. Worth running against pages with known
defects and counting both misses and false alarms. `report.json` already carries
what that needs — `selector` is what Claude chose, `resolvedTo` is what was
annotated, `warnings` flags ambiguity, and `unresolved` lists what it could not
point at.
