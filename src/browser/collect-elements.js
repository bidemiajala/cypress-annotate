// This file is read as text and evaluated inside the page - it is never
// imported or bundled. Keeping it out of the TypeScript build is deliberate:
// esbuild's keepNames transform injects a `__name` helper into any function it
// compiles, and that helper does not exist in the browser, so a serialized
// TypeScript function throws `__name is not defined` on evaluation.
//
// The whole file is therefore a single arrow-function expression.
//
// Tags every candidate element with a ref attribute and returns a description
// of it. Tagging rather than deriving a selector afterwards is deliberate: a
// selector we injected always resolves, whereas a path built from classes can
// be invalidated by anything that re-renders between measuring and annotating.

(function (options) {
  var prefix = options.prefix;
  var refAttr = options.refAttr;
  var minSize = options.minSize;
  var viewportOnly = options.viewportOnly;

  var INTERACTIVE = ['a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'option'];
  var STRUCTURAL = ['header', 'nav', 'main', 'footer', 'aside', 'form', 'table', 'img', 'svg', 'video', 'dialog'];
  var HEADING = /^h[1-6]$/;
  var testAttrs = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

  function readableSelector(el) {
    // Prefer whatever a developer would actually paste into devtools.
    var id = el.getAttribute('id');
    if (id && /^[A-Za-z][\w-]*$/.test(id) && el.ownerDocument.querySelectorAll('#' + id).length === 1) {
      return '#' + id;
    }

    for (var i = 0; i < testAttrs.length; i++) {
      var value = el.getAttribute(testAttrs[i]);
      if (value) {
        var candidate = '[' + testAttrs[i] + '="' + value + '"]';
        if (el.ownerDocument.querySelectorAll(candidate).length === 1) return candidate;
      }
    }

    var parts = [];
    var node = el;
    for (var depth = 0; node && depth < 4; depth++) {
      var tag = node.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;

      var nodeId = node.getAttribute('id');
      if (nodeId && /^[A-Za-z][\w-]*$/.test(nodeId)) {
        parts.unshift('#' + nodeId);
        break;
      }

      var parent = node.parentElement;
      var part = tag;
      if (parent) {
        var siblings = [];
        for (var c = 0; c < parent.children.length; c++) {
          if (parent.children[c].tagName === node.tagName) siblings.push(parent.children[c]);
        }
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);

      var joined = parts.join(' > ');
      try {
        if (el.ownerDocument.querySelectorAll(joined).length === 1) return joined;
      } catch (e) {
        // An unusual tag name can produce an invalid selector; keep walking.
      }
      node = parent;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  function accessibleName(el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    var alt = el.getAttribute('alt');
    if (alt) return alt.trim();
    var placeholder = el.getAttribute('placeholder');
    if (placeholder) return 'placeholder: ' + placeholder.trim();
    if (el.tagName === 'INPUT' && typeof el.value === 'string' && el.value) {
      return 'value: ' + el.value.trim();
    }
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  // An element a developer deliberately named is worth listing even when it is
  // just a wrapper - a misaligned or overflowing container is exactly the kind
  // of target whose children, not itself, carry the text.
  function hasStableName(el) {
    if (el.hasAttribute('id')) return true;
    for (var i = 0; i < testAttrs.length; i++) {
      if (el.hasAttribute(testAttrs[i])) return true;
    }
    return false;
  }

  // Text-bearing leaf: has its own text but no child element that also has text.
  function isTextLeaf(el) {
    if (!(el.textContent || '').trim()) return false;
    for (var i = 0; i < el.children.length; i++) {
      if ((el.children[i].textContent || '').trim()) return false;
    }
    return true;
  }

  // Clear handles left by an earlier pass. Counters restart at 1 each time, so
  // without this a stale e5 from a previous scroll position still matches
  // [data-annot-ref="e5"] and the annotation can land on the wrong element.
  var stale = document.querySelectorAll('[' + refAttr + ']');
  for (var s = 0; s < stale.length; s++) stale[s].removeAttribute(refAttr);

  var results = [];
  var counter = 0;
  var all = document.querySelectorAll('*');

  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link') continue;

    var style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (parseFloat(style.opacity) < 0.05) continue;

    var rect = el.getBoundingClientRect();
    if (rect.width < minSize || rect.height < minSize) continue;

    var intersects =
      rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;
    if (viewportOnly && !intersects) continue;

    var interesting =
      INTERACTIVE.indexOf(tag) !== -1 ||
      STRUCTURAL.indexOf(tag) !== -1 ||
      HEADING.test(tag) ||
      el.hasAttribute('role') ||
      hasStableName(el) ||
      isTextLeaf(el);
    if (!interesting) continue;

    var ref = prefix + ++counter;
    el.setAttribute(refAttr, ref);

    results.push({
      ref: ref,
      reportSelector: readableSelector(el),
      tag: tag,
      role: el.getAttribute('role'),
      name: accessibleName(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      inViewport: intersects,
    });
  }

  return results;
})
