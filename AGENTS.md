# Notes for coding agents

`cypress-annotate` draws a pixel-accurate box on exactly what's wrong in a
Cypress screenshot. If you are adding it to someone's Cypress suite, read
`skills/cypress-annotate/SKILL.md`, which is written for that job and covers the
setup, the options, and the traps.

This file is for working inside this repo.

## The one rule that matters

Measure, then screenshot, with no navigation, scroll, or click in between. A
rectangle is only valid for the scroll position it was measured at. Everything
else in the pipeline can recover from being wrong. This it cannot.

## Layout

| Path | What it is |
| --- | --- |
| `src/cypress/` | The Cypress plugin. Needs no browser automation library. |
| `src/annotate-image.ts`, `src/draw.ts` | The shared engine. sharp and SVG, no browser. |
| `src/annotate.ts`, `src/measure.ts`, `src/pipeline.ts`, `src/finder.ts` | The Playwright pipeline. |
| `src/claude-reasoner.ts` | The optional reasoning layer. |
| `scripts/` | Every suite, plus the CLIs. No test framework, they are plain scripts. |
| `fixtures/` | Flat-coloured targets the alignment suite scans for. |

Three entry points, deliberately independent: the root, `./reasoner`, and
`./cypress/*`. `playwright`, `@anthropic-ai/sdk` and `cypress` are all optional
peer dependencies.

**Do not import `ClaudeReasoner` into anything the root barrel re-exports.** That
already shipped as a bug once. An ES module evaluates a whole file's top-level
code the moment anything is imported from it, so putting the reasoner beside a
re-exported utility made every root import throw `ERR_MODULE_NOT_FOUND` for the
Anthropic SDK, even for callers who never touched it. The `package install` CI
job exists to catch a repeat.

## Before you claim something works

This repo's standard is that claims are verified, not assumed. Several comments
say so explicitly, and they mean it.

```bash
npm run typecheck
npm run test:cypress            # 7 cases, real Cypress
npm run test:failure-selector   # 12 cases, no browser
npm run test:cypress-failures   # 4 cases end to end, real Cypress
npm run test:svg-escaping       # 5 cases
npm run verify                  # alignment, 20 cases, needs playwright chromium
npm run verify:image            # 10 cases, needs playwright chromium
```

Eyeballing a screenshot does not prove pixel accuracy. `scripts/verify.ts` scans
for a target's flat colour, recovers its true pixel footprint, and compares that
against the computed rect. Add a case there rather than looking at an image.

## Writing

No em dashes or en dashes, in code comments, docs, or commit messages. Use a
spaced hyphen, a comma, or parentheses. CI fails the build on one. The single
exemption is the element-inventory separator in `src/inventory.ts`, which is
program output that goes into a model's prompt.

Avoid the "it's not X, it's Y" construction, including the compressed trailing
form ("a mechanical pass, no rewording required").
