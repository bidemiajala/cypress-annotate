// Paste this into whichever browser MCP is live, as the evaluate function:
//
//   Playwright MCP     browser_evaluate({ function: "<this>", filename: "measure.json" })
//   Chrome DevTools    evaluate_script({ pageId, function: "<this>", filePath: "measure.json" })
//
// Edit the SELECTORS line, and nothing else. The result is the exact JSON that
// `annotate-shot --measurement` expects.
//
// It deliberately does not scroll, click, or change anything: every rectangle it
// returns is only valid for the scroll position the page is in right now, so
// the screenshot must be taken immediately after this runs, with no navigation
// in between.

() => {
  const SELECTORS = ['#place-order'];

  const doc = document.documentElement;
  const body = document.body;

  const metrics = {
    devicePixelRatio: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    // innerWidth/Height rather than documentElement.clientWidth/Height: on a
    // page with no doctype (quirks mode) the root element reports the content
    // size, not the viewport.
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
    documentHeight: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
  };

  const targets = SELECTORS.map((selector) => {
    let matches;
    try {
      matches = document.querySelectorAll(selector);
    } catch (e) {
      return { selector, found: false, error: 'invalid selector: ' + e.message };
    }
    if (matches.length === 0) return { selector, found: false, error: 'no element matched' };

    const el = matches[0];
    const r = el.getBoundingClientRect();

    // An element inside a fixed subtree does not move with document scroll, so
    // it has no meaningful document-space position.
    let isFixed = false;
    for (let node = el; node; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') {
        isFixed = true;
        break;
      }
    }

    return {
      selector,
      found: true,
      matchCount: matches.length,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      isFixed,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      inViewport:
        r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
    };
  });

  return { metrics, targets };
}
