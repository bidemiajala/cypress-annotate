# Changelog

Notable changes to `cypress-annotate`. Each release's section here becomes the
body of its GitHub release.

## 1.0.0

The package shipped two products under one name. `cy.annotate()` and the failure
hook measure in the browser and composite in Node, with `sharp` as the only
thing that installs. Alongside them sat a Playwright-driven bug hunt with a
Claude reasoning layer, two optional peers and its own CLI, none of which ever
touched Cypress. Someone arriving from npm saw `playwright`, `ai`, `llm` and
`claude` in the keywords of a Cypress screenshot plugin.

That half now lives in
[annotate-agent](https://github.com/bidemiajala/annotate-agent), under the same
names. An install of this package is `sharp` and nothing else.

### Breaking

Everything here fails at import time rather than misbehaving at runtime.

- The `cypress-annotate` binary is gone. It drove the Playwright pipeline.
- `cypress-annotate/reasoner` is no longer exported.
- Twelve root exports moved out: `annotate`, `captureAnnotated`, `runBugHunt`,
  `measureElement`, `measureRegion`, `readPageMetrics`, `collectInventory`,
  `renderInventory`, `findingsToAnnotations`, `gatherReasonerInput`,
  `ReplayReasoner`, `SEVERITY_COLORS`. What remains is `annotateImage`,
  `resolveScale`, `resolveStyle`, `buildOverlaySvg` and `compositeOverlay`.
- These types moved out with them: `Annotation`, `Region`, `ScreenshotMode`,
  `AnnotateOptions`, `AnnotateResult`, `MeasuredElement`.
- `src/browser/*.js`, the copy-pasteable MCP snippets, no longer ship here.
- `playwright` and `@anthropic-ai/sdk` are no longer peer dependencies.

**Migrating.** If you only use `cy.annotate()`, the failure hook, or
`annotateImage()`, upgrade and change nothing. If you use anything in the list
above, `npm install annotate-agent` and change the import path.

### Added

- **Theming from `cypress.config`.** An `env.annotate` block sets colours and
  everything else once for the project, instead of repeating them at every call.
  Cypress serialises `env` into the browser, so the one block reaches
  `cy.annotate()` and the failure hook alike, and
  `CYPRESS_annotate='{"style":{...}}'` overrides it for a single CI job. Layers
  merge lowest first: built-in defaults, the config block, the options passed to
  one call, then a per-target style. A misspelled key warns once per run rather
  than being silently ignored.
- **Three style fields** that were hardcoded in `draw.ts`: `labelFontFamily`,
  `labelFontWeight`, and `labelBackground`, which falls back to `color` so one
  value still themes the outline and the label pill together.
- **A run manifest** at `out/cypress/annotations.json`, one record per annotated
  screenshot with the spec and test it came from, the labels, the image paths,
  the drawn rects and any warnings. `manifestPath` moves it.
- **A GitHub Actions job summary.** When `GITHUB_STEP_SUMMARY` is set, a table
  of the manifest is appended to it, so what a run produced is readable on the
  job page without downloading the artifact.
- `registerAnnotateTasks(on, config)` takes the Cypress config as an optional
  second argument. The single-argument form still works.

### Changed

- Default appearance is unchanged, and `AnnotationStyle`'s new fields are
  additive, so nothing that worked before looks different.
- The docs split. The README is half its previous length and leads with the
  failure hook; the coordinate rules, the traps and the verification notes moved
  to [DOCS/internals.md](DOCS/internals.md).

### Fixed

- `registerAnnotateTasks` no longer registers `before:run` or `after:run`.
  Cypress allows one handler per run event and silently keeps the last one
  registered, so taking them would have stopped a project's own handler from
  firing, with no error and nothing in the output to explain it. Caught before
  release by testing both registration orderings against a real run. The
  manifest and the summary are driven from the task instead, which composes with
  anything already in `setupNodeEvents`.
- `appendFailureRecord` creates the report's parent directory instead of failing
  when it does not exist.

## 0.4.0

Shipped `src/cli.ts` as a `bin`, so it was reachable from an install rather than
only from inside the repo.

Running it without `playwright`, an optional peer nobody installing the Cypress
plugin would have, printed `ERR_MODULE_NOT_FOUND` naming an internal dist path,
which tells the reader nothing. `captureAnnotated` now catches that specific case
and names the two commands that fix it, so library callers get the better message
too. Both halves are covered in CI: `--help` works with no peers at all, and a
real invocation without playwright exits non-zero and explains itself.

## 0.3.0

`cy.annotate()` on an element inside an iframe measured against the wrong origin
and drew the box somewhere else on the page. The core engine had handled frames
from the beginning, with a documented rule about content origins, but
`src/cypress/measure-dom.ts` had no iframe handling at all. Cypress apps embed
checkout and payment frames constantly, so this was the most likely next bug
report.

A target can now be `{ frame, selector }`, with `frame` a single selector or an
array for nesting, outermost first. A bare string still means the top document
and an array of targets still means several at once, so nothing existing changed.
The offset used is the frame's content origin, `rect.left + borderLeftWidth +
paddingLeft`, so a frame with its own border and padding lands correctly, and a
frame scrolled internally needs no correction.

## 0.2.0

The `./cypress/*` wildcard made all eight files in `dist/cypress` public API when
only three are documented. Renaming any internal would technically have been a
breaking change. Replaced with three explicit subpaths, so the public surface is
now the three things the README tells people to import.

That also made the entry points visible to tooling, which uncovered a second
problem: node10 type resolution failed for every subpath. That is TypeScript's
older `moduleResolution: "node"`, which ignores exports maps entirely, and plenty
of Cypress projects still use it. `typesVersions` fixes it.

## 0.1.2

The exports map declared only an `import` condition, so `require()` of any entry
point failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`. That breaks the documented
Cypress setup outright, because Cypress's stock webpack and Babel preprocessor
compiles the static import in `cypress/support/e2e.js` down to a `require`.
Reported from real use, and it affected the root and `./reasoner` as well as
`./cypress/*`.

## 0.1.1

Documented `annotateImage()`, which was the only export with no example anywhere.
The type names alone are not enough to call it: the arguments are positional
rather than an options bag, targets take `viewportRect` rather than `rect`, and
`PageMetrics` wants `viewportWidth`/`viewportHeight`/`documentWidth`/
`documentHeight` rather than a width and a height. All three were easy to get
wrong, which is what prompted the example.

## 0.1.0

First release. `cy.annotate()`, the automatic failure hook, and the coordinate
engine behind both.
