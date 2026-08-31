# How this works underneath

The rules the coordinate engine follows, how they are verified, and what to know
before working on the repo. For using the plugin, see the
[README](../README.md).

## The coordinate rules

Four things have to line up, and each one is a separate opportunity to be a few
pixels off.

**1. `getBoundingClientRect()` is viewport-relative and post-transform.**
It already accounts for CSS transforms, internally scrolled ancestors, and
sub-pixel layout. It does *not* account for page scroll or iframes.

**2. Scroll offset applies only to a full-page capture, and only for elements
that scroll.** A viewport screenshot is in the same space the rect is already in,
so adding scroll there is the classic off-by-a-scroll bug. A full-page screenshot
is document space, so `rect + scrollX/scrollY`. A `position: fixed` element has
no document position at all, which the trap below covers.

**3. Device pixel ratio scales CSS px to image px, but verify it rather than
trusting it.** `resolveScale()` in
[src/annotate-image.ts](../src/annotate-image.ts) checks the produced image
against `cssWidth × devicePixelRatio`; if they disagree by more than 2px it
derives the real scale from the image and records a warning. Stroke widths, font
sizes and padding are all specified in CSS px and multiplied by that same scale,
so annotations look identical at dpr 1, 2 and 3.

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
for those elements, and emits a warning so the caller knows why. Capturing the
viewport, which is the default, sidesteps the problem entirely.

## How alignment is verified

Eyeballing a screenshot does not prove pixel accuracy, so nothing here relies on
it.

Every target in [fixtures/test-page.html](../fixtures/test-page.html) is painted a
flat, unique colour with no radius, border or shadow, so the pixels it paints are
exactly its border box. The Cypress suite scans the un-annotated capture for that
colour, recovers the element's true pixel footprint, and compares it against the
rect the engine computed. Three checks close the loop on every case: the box
centre must not be page background, the painted region must match the drawn rect,
and the painted region's CSS size must match the element's own
`getBoundingClientRect()` read independently through jQuery. Tolerance is 2px.

The same technique proves theming reaches the pixels.
[cypress/e2e/theme.cy.ts](../cypress/e2e/theme.cy.ts) samples the drawn stroke
out of the finished image rather than trusting the options object it was built
from, so a config block that silently does nothing fails the suite.

Residual drift is sub-pixel and comes from scanner quantisation. `#target-top`
sits at y=147.375 CSS px, so its top edge falls on device pixel 294.75 and the
partially covered row 294 fails the colour test. Its x is an integer and the
horizontal delta is exactly 0.00. That 0.5-device-pixel signature shows up on
every case, always on the axis with a fractional coordinate.

The wider alignment suites, which drive a browser directly and cover dpr 1/2/3,
rescaled captures and the percentage-region fallback, live in
[annotate-agent](https://github.com/bidemiajala/annotate-agent) along with the
Playwright pipeline they were written for.

## Working on this repo

```bash
npm install
npm run test:cypress            # cy.annotate and theming, 12 cases, real Cypress 15
npm run test:cypress-failures   # failed-test capture end to end, 4 cases, real Cypress 15
npm run test:failure-selector   # failed-test selector recovery, 12 cases, no browser
npm run test:svg-escaping       # SVG injection regression suite, 9 cases
npm run typecheck
```

CI runs the two Cypress suites on Electron, Chrome and Firefox. Firefox is the
one that can falsify the Chromium-specific claims in the coordinate rules, which
is why it is there.

**A pitfall if you write your own chai assertions against `err.expected` and
`err.actual`:** they hold chai's own quoted rendering of the value rather than
the raw value. `.should('have.text', 'X')` puts `'X'` into `err.expected` with
the quote marks included. An early version of the failure hook got that wrong,
and it was fixed by running a real Cypress failure and inspecting the field.

**If Cypress fails to start with "bad option: --no-sandbox"**, something in your
environment has set `ELECTRON_RUN_AS_NODE=1`, which VS Code's extension host
does. Cypress's binary is Electron, so it starts as plain Node and rejects
Chromium flags. `npm run test:cypress` goes through
[scripts/run-cypress.ts](../scripts/run-cypress.ts), which strips that variable.

**Worth knowing for any visual assertion in Cypress:** Electron's macOS capture
applies a colour-profile shift. A fixture painted `#FF00E4` comes back as
`rgb(234,51,221)`. Exact-colour assertions against your stylesheet will fail, so
the suite samples the rendered colour out of the image and compares by distance.

## Publishing and packaging

**The build runs automatically on install.** This repo ships TypeScript source
and `dist/` is gitignored, so npm's `prepare` script runs `tsc` on install.
Confirmed by installing the packed tarball into an empty project and importing
each entry point, which is what the `package install` CI job does on every run.

`cypress` is an optional peer, so npm installs nothing for you and stays quiet
about it. `sharp` is the only hard dependency.

That separation was worth proving. An early version put `ClaudeReasoner` in the
same file as several utility functions the root barrel re-exported, so importing
anything at all from `'cypress-annotate'`, even `annotateImage`, threw
`ERR_MODULE_NOT_FOUND` for `@anthropic-ai/sdk` whether or not you ever touched
the reasoner. Reading the code would never have shown it, because an ES module
evaluates a whole file's top-level code the moment anything is imported from it,
peer-optional or otherwise. What caught it was installing the built package into
an isolated scratch project with no peers present and importing each entry point
for real. CI now does that on every push, and the `./cypress/*` exports are
listed one by one rather than wildcarded, so the five internal modules under
`dist/cypress` stay unreachable.

Publishing is npm trusted publishing over OIDC, guarded on the version in
`package.json` being new, so an ordinary merge that does not bump the version is
a no-op. The trusted publisher names this repo and this workflow file, `ci.yml`,
so renaming that file breaks publishing until the npm setting is updated.
