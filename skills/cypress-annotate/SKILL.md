---
name: cypress-annotate
description: Add pixel-accurate annotated screenshots to a Cypress suite. Use when someone wants a box drawn on what failed in a Cypress screenshot, wants failed tests to annotate themselves, asks why a Cypress screenshot is hard to read, or asks how to attach a visual to a bug ticket from an e2e run. Covers cy.annotate() and automatic failure capture.
---

# cypress-annotate

Draws a box on exactly what's wrong in a Cypress screenshot. Two ways to use it,
and neither calls an LLM.

## Setup

Three files change. All three are required for `cy.annotate()`.

```bash
npm install cypress-annotate
```

```ts
// cypress.config.ts
import { defineConfig } from 'cypress';
import { registerAnnotateTasks } from 'cypress-annotate/cypress/task';

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      registerAnnotateTasks(on, config);
    },
  },
});
```

```ts
// cypress/support/e2e.ts
import 'cypress-annotate/cypress/commands';
```

The task must be registered in `setupNodeEvents` because the measuring happens in
the browser and the image compositing happens in Node. Registering only the
command gives a "task not registered" failure at run time.

## Annotating a known problem

```ts
cy.annotate('#promo-apply', { label: 'Apply button escapes its card' });
```

Several targets, one label each, in order:

```ts
cy.annotate(['#promo-apply', '#order-ref'], {
  label: ['Escapes its card', 'Overflows'],
});
```

Reach into an iframe with `{ frame, selector }`, outermost frame first:

```ts
cy.annotate({ frame: 'iframe#checkout', selector: '.pay-button' });
cy.annotate({ frame: ['iframe#outer', 'iframe#inner'], selector: '.total' });
```

The offset used is the frame's content origin, so frames with their own border
and padding land correctly and a frame's internal scroll needs no correction.
Cross-origin frames cannot be measured and fail loudly.

Crop tight, which is what to use for a ticket attachment. Dimming the
surroundings is a separate `style` setting, since `crop` alone leaves them at
full brightness:

```ts
cy.annotate('#promo-apply', {
  label: 'Escapes its card',
  crop: true,
  cropPadding: 220,
  style: { dimOutside: 0.45 },
});
```

It overwrites the screenshot Cypress just recorded, so the annotated image is
what lands in `cypress/screenshots/`, in reports, and in CI artifacts. There is
no second file to collect.

It yields the result, so a test can assert on where the box landed:

```ts
cy.annotate('#grand-total-value', { label: 'Wrong total' }).then((result) => {
  expect(result.warnings).to.be.empty;
});
```

### Options

| Option | Default | Effect |
| --- | --- | --- |
| `label` | none | Box text. One string, or one per selector in order. |
| `name` | slug of first selector | Screenshot filename. |
| `crop` | `false` | Crop to the element, keeping `cropPadding` of context. |
| `cropPadding` | pipeline default | CSS px of context kept around the crop. |
| `shape` | `box` | Shape drawn around the target. |
| `style` | none | Colours, stroke width, label colour, dim strength. |
| `scrollIntoView` | `true` | Scroll the first target in, but only if needed. |
| `scrollOffset` | `120` | CSS px left above the element when scrolling. |
| `keepRaw` | `false` | Keep the un-annotated image too. |
| `fullPage` | `false` | Whole document. Avoid it, see Traps. |

Result fields: `outPath`, `rawPath`, `width`, `height`, `scale`, `drawnRects`,
`warnings`.

## Annotating every failed test

This one needs no per-test code. Every failure annotates itself, labelled from
the assertion's own expected and actual values.

```ts
// cypress.config.ts
export default defineConfig({
  screenshotOnRunFailure: false,
  // ...
});
```

```ts
// cypress/support/e2e.ts
import { registerFailureCapture } from 'cypress-annotate/cypress/failure-hook';

registerFailureCapture();
```

`screenshotOnRunFailure: false` is required, not optional. Leave it on and
Cypress's automatic screenshot races this hook's screenshot, which makes it
ambiguous which image the DOM measurement matches.

Each failure produces an annotated screenshot plus one record in
`out/cypress/failures.json` carrying the spec and test name, the recovered
selector and where it came from, expected and actual, the label, image paths,
`drawnRect`, page metrics, and warnings.

Where no selector can be recovered, such as an existence check or a
`cy.contains()` chain, the failure still gets a screenshot plus a live inventory
of candidate elements, since the browser session is gone by the time anyone reads
the report.

## Traps

**Don't use `fullPage: true` casually.** Cypress builds a full-page screenshot by
scrolling and stitching, which paints `position: fixed` and `sticky` elements
several times in one image.

**Don't call `cy.scrollIntoView()` before annotating.** It always scrolls, even
when the element is already visible, which can push the target under a fixed
header. The command already handles this, measuring first and only scrolling when
genuinely needed.

**Don't insert anything between measuring and the screenshot.** No navigation,
scroll, or click. A rectangle is only valid for the scroll position it was
measured at. Using `cy.annotate()` rather than hand-rolling this is the point.

**Exact-colour assertions fail on macOS Electron.** Its capture applies a
colour-profile shift, so `#FF00E4` comes back as `rgb(234,51,221)`. Sample the
colour from the image rather than trusting the stylesheet.

**"bad option: --no-sandbox" on start** means something set
`ELECTRON_RUN_AS_NODE=1`, which VS Code's extension host does. Unset it before
running Cypress.

## Project-wide defaults

Colours and the other options are settable once, in cypress.config, so a team
does not repeat them at every call:

```ts
export default defineConfig({
  env: {
    annotate: {
      style: { color: '#7C3AED', strokeWidth: 4, labelBackground: '#1F1F23' },
      keepRaw: true,
    },
  },
});
```

Cypress serialises `env` into the browser, so the block reaches `cy.annotate()`
and the failure hook alike, and `CYPRESS_annotate='{"style":{...}}'` overrides it
for one CI job. Layers merge lowest first: built-in defaults, this block, the
options passed to a single call, then a per-target style. A misspelled key warns
rather than being silently ignored.

Style fields: `color`, `strokeWidth`, `padding`, `radius`, `dimOutside`,
`labelFontSize`, `labelColor`, `labelBackground`, `labelFontFamily`,
`labelFontWeight`. Run fields: `shape`, `crop`, `cropPadding`, `keepRaw`,
`scrollOffset`, `manifestPath`, `reportPath`.

## In CI

The annotated PNG overwrites the screenshot Cypress took, so it is what
`upload-artifact` collects and what `cypress run --record` sends to Cypress
Cloud. There is no Cloud API involved and nothing extra to configure.

Each run also writes `out/cypress/annotations.json`, one record per annotated
screenshot, and on GitHub Actions appends a table of it to the job summary.

## What this does not do

No LLM is involved in either path above, and no API key is needed. For pointing
a model at a page so it works out what is wrong before anything gets drawn, see
the separate `annotate-agent` package.
