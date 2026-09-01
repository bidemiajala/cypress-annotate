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
| `src/cypress/` | The Cypress plugin. Browser-side measurement plus the Node task. |
| `src/annotate-image.ts`, `src/draw.ts` | The engine. sharp and SVG, no browser, no Cypress. |
| `src/cypress/config.ts` | The `env.annotate` block. One place to add a new option. |
| `cypress/e2e/` | The suites that assert pixels. `theme.cy.ts` covers the config block. |
| `scripts/` | The non-browser suites and the Cypress runner. No test framework, plain scripts. |
| `fixtures/` | Flat-coloured targets the suites scan for. |

Four entry points: the root, and `./cypress/task`, `./cypress/commands`,
`./cypress/failure-hook`. They are listed one by one rather than wildcarded, so
the five other modules under `dist/cypress` stay internal, and the `package
install` CI job asserts that.

`sharp` is the only dependency. `cypress` is an optional peer.

**Do not put a top-level import of an optional peer beside anything the root
barrel re-exports.** That already shipped as a bug once, when `ClaudeReasoner`
sat next to a re-exported utility and made every root import throw
`ERR_MODULE_NOT_FOUND` for the Anthropic SDK, even for callers who never touched
it. An ES module evaluates a whole file's top-level code the moment anything is
imported from it.

The Playwright pipeline and the Claude reasoning layer used to live here. They
are now in the `annotate-agent` repo, which also owns the wider alignment
suites.

## Before you claim something works

This repo's standard is that claims are verified, not assumed. Several comments
say so explicitly, and they mean it.

```bash
npm run typecheck
npm run test:cypress            # 12 cases, real Cypress
npm run test:cypress-failures   # 4 cases end to end, real Cypress
npm run test:failure-selector   # 12 cases, no browser
npm run test:svg-escaping       # 9 cases
```

Eyeballing a screenshot does not prove pixel accuracy. The Cypress suites scan
the image for a target's flat colour, recover its true pixel footprint, and
compare that against the computed rect. Add a case there rather than looking at
an image. The same trick proves the theme reaches the pixels: `theme.cy.ts`
samples the drawn stroke and fails if the config block did nothing.

## Releasing

Bump the version and add its `## <version>` section to `CHANGELOG.md` in the same
commit. The publish job uses that section as the GitHub release body and fails
the release if it is missing.

## Writing

No em dashes or en dashes, in code comments, docs, or commit messages. Use a
spaced hyphen, a comma, or parentheses. CI fails the build on one, with no
exemptions.

Avoid the "it's not X, it's Y" construction, including the compressed trailing
form ("a mechanical pass, no rewording required").
