# cypress-annotate

A Cypress plugin that draws a pixel-accurate box on exactly what's wrong in a
screenshot. Call `cy.annotate()` where you already know what broke, or register
the failure hook and get a box on every failed test, labelled from the
assertion's own expected and actual values, with no AI involved.

`sharp` is the only thing that installs with it. No browser download, nothing
else to configure.

## Getting started

### 1. Install

```bash
npm install --save-dev cypress-annotate
```

Needs Node 20.19+ or 22.12+. The package is ESM, and those are the versions that
can `require()` an ES module, which is what Cypress's default webpack and Babel
preprocessor ends up doing with the import in step 3.

### 2. Register the Node task

The measuring happens in the browser, the image compositing happens in Node. This
is the Node half.

```ts
// cypress.config.ts
import { defineConfig } from 'cypress';
import { registerAnnotateTasks } from 'cypress-annotate/cypress/task';

export default defineConfig({
  e2e: {
    setupNodeEvents(on) {
      registerAnnotateTasks(on);
    },
  },
});
```

### 3. Register the command

```ts
// cypress/support/e2e.ts
import 'cypress-annotate/cypress/commands';
```

That adds `cy.annotate()` and its TypeScript types. Nothing else to import in
your specs.

### 4. Annotate something

```ts
it('flags the broken promo button', () => {
  cy.visit('/checkout');
  cy.annotate('#promo-apply', { label: 'Apply button escapes its card' });
});
```

### 5. Find the image

It overwrites the screenshot Cypress just recorded, so the annotated version is
what lands in `cypress/screenshots/`, in your reports, and in CI artifacts. There
is no second file to collect and no reporter to configure.

That's the whole setup. Everything below is optional.

## Using `cy.annotate()`

```ts
cy.annotate(selector, options?)
```

`selector` is a CSS selector or an array of them. Several at once, each with its
own label:

```ts
cy.annotate(['#promo-apply', '#order-ref'], {
  label: ['Escapes its card', 'Overflows'],
});
```

Reach into an iframe with `{ frame, selector }`. The offset is the frame's
content origin, so a frame with its own border and padding lands correctly, and a
frame scrolled internally needs no correction:

```ts
cy.annotate({ frame: 'iframe#checkout', selector: '.pay-button' }, {
  label: 'Pay button overflows the frame',
});

// nested frames, outermost first
cy.annotate({ frame: ['iframe#outer', 'iframe#inner'], selector: '.total' });

// mix frame targets and plain ones in a single shot
cy.annotate([
  '#order-ref',
  { frame: 'iframe#checkout', selector: '.pay-button' },
], { label: ['Overflows', 'Escapes its card'] });
```

Cross-origin frames cannot be measured from the page, so those fail loudly
rather than drawing a box in the wrong place.

Crop tight to the element with the rest of the page dimmed, which is usually what
you want to paste into a ticket:

```ts
cy.annotate('#promo-apply', { label: 'Escapes its card', crop: true, cropPadding: 80 });
```

Assert on where the box actually landed. The command yields the result:

```ts
cy.annotate('#grand-total-value', { label: 'Wrong total' }).then((result) => {
  expect(result.warnings).to.be.empty;
  expect(result.drawnRects[0].width).to.be.greaterThan(0);
});
```

### Options

| Option | Default | What it does |
| --- | --- | --- |
| `label` | none | Text on the box. One string, or one per selector in order. |
| `name` | slug of the first selector | Screenshot filename. |
| `crop` | `false` | Crop to the element and dim everything outside it. |
| `cropPadding` | pipeline default | CSS px of context to keep around the crop. |
| `shape` | `box` | Shape drawn around the target. |
| `style` | none | Colours, stroke width, label colour, dim strength. |
| `scrollIntoView` | `true` | Scroll the first target into view, but only if it isn't already. |
| `scrollOffset` | `120` | CSS px left above the element when scrolling, so a fixed header doesn't cover it. |
| `keepRaw` | `false` | Keep the un-annotated image alongside, for pixel assertions. |
| `fullPage` | `false` | Capture the whole document. See the warning under [Things that will bite you](#things-that-will-bite-you). |

### What it yields

| Field | Meaning |
| --- | --- |
| `outPath` | Where the annotated image was written. |
| `rawPath` | The un-annotated image, when `keepRaw` is set. |
| `width`, `height` | Image dimensions in pixels. |
| `scale` | The device pixel ratio actually measured off the image. |
| `drawnRects` | Final box positions, in image pixels. |
| `warnings` | Anything ambiguous, such as a selector matching more than one element. |

## Annotating every failed test

For "the wrong text showed" and similar assertion failures, you can skip
`cy.annotate()` entirely and have every failure annotate itself.

### 1. Turn off Cypress's own failure screenshot

```ts
// cypress.config.ts
export default defineConfig({
  screenshotOnRunFailure: false,
  // ...
});
```

This is required. Otherwise Cypress's automatic screenshot and this hook's
screenshot race each other, and it becomes ambiguous which one the DOM
measurement matches.

### 2. Register the hook

```ts
// cypress/support/e2e.ts
import { registerFailureCapture } from 'cypress-annotate/cypress/failure-hook';

registerFailureCapture();
```

Optionally, `registerFailureCapture({ reportPath: 'out/cypress/failures.json' })`
to move the report, or pass `style` to change the box colours.

### 3. Run your suite as normal

Every failed test now produces an annotated screenshot and one record in
`out/cypress/failures.json`.

### What you get

On each failure the hook recovers the selector the failing command was targeting,
using `cy.state('current')`'s own args where they're available and falling back
to chai-jquery's `<tag#id>` rendering in the error message. It measures that
element live while the page is still in its failed state, scrolls it into view if
needed, and draws a box labelled from the assertion's own values:

> Expected "THIS WILL NOT MATCH" but got "£244.99"

That label comes entirely from `err.expected` and `err.actual`, with **zero LLM
calls**. Each record in the report carries the spec and test name, the recovered
`selector` and where it came from, `expected` and `actual`, the `label`, the
screenshot and annotated image paths, `drawnRect`, page `metrics`, and warnings.

**When no selector can be recovered**, as with an existence check, a
`cy.contains()` chain, or a generic page-state assertion, there's nothing to box
deterministically. Those failures still get captured for free: a plain screenshot
plus a live inventory of candidate elements, because a screenshot on its own
carries no DOM information and the browser session will be gone by the time
anyone looks at it. Getting Claude to explain those is a separate, explicit step,
covered in [DOCS/pipeline.md](DOCS/pipeline.md).

### Cypress Cloud

**Confirmed working against a real recorded run.** A `cy.screenshot()` call taken
from an `afterEach` hook, overwritten in place with the annotation before the run
ends, is picked up by `cypress run --record` and uploaded as a normal
`Screenshot` cloud artifact, under the same category label and through the same
pipeline as any other Cypress screenshot. The uploaded image showed the box.

That confirmation replaced an earlier design that looked obviously safer:
overwrite Cypress's own *automatic* on-failure screenshot in place, on the theory
that mutating the file Cypress already tracks removes all doubt. It doesn't work.
That automatic screenshot includes the full Runner UI, meaning the command log
sidebar, the browser toolbar, and the app rendered at some auto-computed zoom
that is never a 1:1 capture, so there's no reliable coordinate math to draw a box
on it at all. The `cy.screenshot({capture: 'viewport'})` this hook takes is a
clean, predictable capture, the same one every alignment test in this repo is
verified against, and the `--record` result above shows that uploading it costs
nothing in Cloud compatibility.

Nothing in this path calls Claude, spends money, or needs `ANTHROPIC_API_KEY`
available to the test job. Every CI run captures its data for free.

## Using this with an AI coding agent

The package ships a skill file at `skills/cypress-annotate/SKILL.md` covering the
setup, every option, and the traps worth knowing. For Claude Code, copy it into
your project:

```bash
cp node_modules/cypress-annotate/skills/cypress-annotate/SKILL.md \
   .claude/skills/cypress-annotate/SKILL.md
```

Agents working inside this repo should read [AGENTS.md](AGENTS.md) instead.

## Things that will bite you

**A pitfall if you write your own chai assertions against `err.expected` and
`err.actual`:** they hold chai's own quoted rendering of the value rather than
the raw value. `.should('have.text', 'X')` puts `'X'` into `err.expected` with
the quote marks included. An early version of this feature got that wrong, and it
was fixed by running a real Cypress failure and inspecting the field.

**Full-page capture repeats fixed elements.** Cypress builds a full-page
screenshot by scrolling and stitching, so `position: fixed` and `sticky` elements
are painted several times in one image. Viewport capture is therefore the default
and `fullPage` is opt-in.

**`cy.scrollIntoView()` always scrolls**, whether or not the element is already
on screen. Calling it unconditionally shoved a perfectly visible element up under
the fixed header, where the annotation was correct but the element was hidden
behind it. The command now measures first and only scrolls when the element is
genuinely not fully visible, leaving `scrollOffset` px of clearance when it does.

**Cypress scales the app when the window is smaller than the viewport**, and the
screenshot may not be `viewport × devicePixelRatio`. `resolveScale()` measures
the real ratio off the image and corrects for it.

**If Cypress fails to start with "bad option: --no-sandbox"**, something in your
environment has set `ELECTRON_RUN_AS_NODE=1`, which VS Code's extension host
does. Cypress's binary is Electron, so it starts as plain Node and rejects
Chromium flags. `npm run test:cypress` goes through
[scripts/run-cypress.ts](scripts/run-cypress.ts), which strips that variable.

**Worth knowing for any visual assertion in Cypress:** Electron's macOS capture
applies a colour-profile shift. A fixture painted `#FF00E4` comes back as
`rgb(234,51,221)`. Exact-colour assertions against your stylesheet will fail, so
the test suite samples the rendered colour out of the image.

## The coordinate rules

Four things have to line up, and each one is a separate opportunity to be a few
pixels off. These are the rules the engine follows.

**1. `getBoundingClientRect()` is viewport-relative and post-transform.**
It already accounts for CSS transforms, internally scrolled ancestors, and
sub-pixel layout. It does *not* account for page scroll or iframes.

**2. Scroll offset applies only to a full-page capture, and only for elements
that scroll.** A viewport screenshot is in the same space the rect is already in,
so adding scroll there is the classic off-by-a-scroll bug. A full-page screenshot
is document space, so `rect + scrollX/scrollY`. A `position: fixed` element has
no document position at all, which the fixed-element note below covers.

**3. Device pixel ratio scales CSS px to image px, but verify it rather than
trusting it.** `resolveScale()` in [src/annotate.ts](src/annotate.ts) checks the
produced image against `cssWidth × devicePixelRatio`; if they disagree by more
than 2px it derives the real scale from the image and records a warning. Stroke
widths, font sizes and padding are all specified in CSS px and multiplied by that
same scale, so annotations look identical at dpr 1, 2 and 3.

**4. Iframes add their content origin, not their border box.** The offset is
`iframeRect.left + borderLeftWidth + paddingLeft`. A frame's own internal scroll
needs no correction, since a rect measured inside the frame is already relative
to that frame's viewport.

### The fixed-element trap

Chromium's full-page capture paints `position: fixed` elements **once**, at
whatever scroll offset the capture started from. So for a fixed element there is
no correct "document position", and adding scroll to it puts the box thousands of
pixels away from the thing it should mark.

The engine detects fixed ancestry during measurement, skips the scroll correction
for those elements, scrolls to the top before full-page captures by default
(`scrollToTop`), and emits a warning so the caller knows why.

## How alignment is verified

Eyeballing a screenshot does not prove pixel accuracy, so nothing here relies on
it.

Every target in [fixtures/test-page.html](fixtures/test-page.html) is painted a
flat, unique colour with no radius, border or shadow, so the pixels it paints are
exactly its border box. [scripts/verify.ts](scripts/verify.ts) scans the
un-annotated capture for that colour, recovers the element's true pixel
footprint, and compares it against the rect the engine computed.

20 cases pass: dpr 1/2/3, CSS transforms, iframe nesting with border and padding,
internally scrolled containers, below-the-fold targets under both auto-scroll and
manual scroll, full-page and cropped captures, fixed elements under scroll, and
the percentage-region fallback in both bases.

Residual drift is ≤1.13px at dpr 3, and it comes from scanner quantisation.
`#target-top` sits at y=147.375 CSS px, so its top edge falls on device pixel
294.75 and the partially covered row 294 fails the colour test. Its x is an
integer and the horizontal delta is exactly 0.00. The same 0.5-device-pixel
signature shows up on every case, always on the axis with a fractional
coordinate.

## Working on this repo

```bash
npm install
npm run test:cypress            # cypress plugin, 7 cases, real Cypress 15
npm run test:failure-selector   # failed-test selector recovery, 12 cases, no browser
npm run test:cypress-failures   # failed-test capture end-to-end, 4 cases, real Cypress 15
npm run test:svg-escaping       # SVG injection regression suite, 5 cases
npm run typecheck
```

The alignment suite in the section above drives a headless browser directly, so
it needs a little more setup. [DOCS/pipeline.md](DOCS/pipeline.md) covers it.

### Publishing and packaging

**The build runs automatically on install.** This repo ships TypeScript source
and `dist/` is gitignored, so npm's `prepare` script (`tsc` plus a small
asset-copy step) runs on install. Confirmed by installing the packed tarball into
an empty project and importing each entry point, which is also what the
`package install` CI job does on every run.

Every peer dependency is marked optional, so npm installs none of them for you
and stays quiet about it, as long as you only use entry points that don't need
them. The three Cypress entry points need nothing beyond `cypress` itself.

That separation was worth proving. The first attempt at the split missed a case:
`ClaudeReasoner` lived in the same file as several utility functions that the
root barrel re-exports, so importing anything at all from `'cypress-annotate'`,
even `annotateImage`, threw `ERR_MODULE_NOT_FOUND` for `@anthropic-ai/sdk`
whether or not you ever touched the reasoner. Reading the code would never have
shown it, because an ES module evaluates a whole file's top-level code the moment
anything is imported from it, peer-optional or otherwise. What caught it was
installing the built package into an isolated scratch project with no peers
present and importing each entry point for real. CI now does that on every push.

## Known limits

- Label pill widths are estimated from an average glyph ratio, because librsvg
  gives no text measurement API. Long labels get slightly generous padding.
- Only Chromium is exercised. The fixed-element behaviour in rule 2 is
  specifically a Chromium capture behaviour and would need re-checking elsewhere.

## Also in this package

The same coordinate engine powers two things the Cypress plugin never touches: a
general annotation pipeline you can point at any URL, and a Claude-based
reasoning layer that decides *what's* wrong before drawing the box. Both are
optional and neither installs by default.
[DOCS/pipeline.md](DOCS/pipeline.md) covers them.
