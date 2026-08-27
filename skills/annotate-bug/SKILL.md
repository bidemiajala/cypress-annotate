---
name: annotate-bug
description: Draw an accurate box on a screenshot of the live page to show exactly where a visual bug is. Use after finding a layout or rendering defect during browser testing, when the bug report needs to point at a specific element rather than attach a raw screenshot. Works with whichever browser MCP backend is connected — Playwright MCP or Chrome DevTools MCP.
---

# Annotating a bug on a live page

Turns "the Apply button escapes its card" into a screenshot with a box drawn
around that exact element.

This skill does **not** open a browser. It annotates a screenshot that the
browser backend already connected to this session has captured. That matters:
the live session is the one that is logged in, and a separately launched browser
would land on the SSO login page instead of the page under test.

## Setup

Set `ANNOTATE_REPO` to wherever the tool is checked out (it needs
`npm install` once):

```
ANNOTATE_REPO=/path/to/cypress-annotate
```

## The protocol

Four steps, in this order. The ordering is the whole discipline: a rectangle is
only valid for the scroll position it was measured at.

### 1. Choose the element

Pick the single element that *is* wrong — not its container, and not the element
it collides with. If a page snapshot gave you an element ref, resolve it to a CSS
selector; prefer `#id` or `[data-testid=…]` over a structural path.

### 2. Measure it

Read `$ANNOTATE_REPO/src/browser/measure-target.js`, replace the `SELECTORS`
line with your selector(s), and evaluate the whole function in the page. Save the
result to a file.

**Playwright MCP:**
```
browser_evaluate({ function: "<the edited snippet>", filename: "/abs/path/measure.json" })
```

**Chrome DevTools MCP:**
```
evaluate_script({ pageId: <id>, function: "<the edited snippet>", filePath: "/abs/path/measure.json" })
```

Check the result: each target has `found: true` and a `rect`. If `found` is
false, the selector is wrong — fix it rather than proceeding, or fall back to a
region (below). If `matchCount` is above 1, the selector is ambiguous and the
first match gets annotated, which may not be the one you mean.

### 3. Screenshot immediately

Take the screenshot **without navigating, scrolling, clicking, or waiting for a
re-render in between**. Anything that moves the page invalidates the rectangles
from step 2 and the box will be drawn in the wrong place.

**Playwright MCP:**
```
browser_take_screenshot({ filename: "/abs/path/shot.png" })
```

**Chrome DevTools MCP:**
```
take_screenshot({ pageId: <id>, filePath: "/abs/path/shot.png", format: "png" })
```

Viewport capture is the default and is what you want. If you pass `fullPage`,
pass `--capture fullPage` in step 4 as well, or every box below the fold will be
misplaced.

### 4. Draw the box

```bash
cd $ANNOTATE_REPO && npm run annotate-shot -- \
  --image /abs/path/shot.png \
  --measurement /abs/path/measure.json \
  --label "Apply button escapes its card" \
  --out /abs/path/annotated.png
```

One `--label` per target, in the same order as `SELECTORS`. Useful extras:

- `--crop` — close-up of the element with the rest dimmed. Best for a ticket.
- `--capture fullPage` — required if the screenshot was a full-page capture.
- `--shape arrow` — point at it instead of boxing it.
- `--color '#FF6A00'` — e.g. colour by severity.

Then attach `annotated.png` to the report and say what is wrong in words as well.

## When there is no element to point at

If the defect is *absent* content — blank space where something should render —
there is no selector to measure. Skip step 2 and give a rectangle as percentages
of the viewport:

```bash
npm run annotate-shot -- --image shot.png --region 10,50,30,8 \
  --label "Delivery estimate missing" --out annotated.png
```

`--region` is `x,y,width,height` in percent. Use it only as a fallback: a
selector is measured, a region is guessed.

## Checks worth reading

The command prints warnings. Two are worth acting on:

- *"matched N elements; annotated the first"* — the selector is ambiguous. Make
  it specific and re-run.
- *"the image was probably rescaled"* — not a problem. Both backends can resize
  screenshots, so the true scale is measured from the image rather than trusted
  from `devicePixelRatio`. The box is still correct.

If the box lands in the wrong place, the cause is almost always that the page
moved between steps 2 and 3. Redo both, back to back.
