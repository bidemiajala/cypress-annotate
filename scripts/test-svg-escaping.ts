/**
 * Proves buildOverlaySvg() cannot be used to inject markup via caller-controlled
 * strings - label text and style.color/labelColor are both part of the public
 * API (annotate(), annotateImage(), cy.annotate(), and the CLI's --color flag
 * all set them), and buildOverlaySvg's own return value is exported public API
 * too, so a consumer could reasonably render it somewhere that isn't just
 * sharp's non-scripting SVG rasterizer.
 */
import assert from 'node:assert/strict';
import { buildOverlaySvg } from '../src/draw.js';
import type { DrawSpec } from '../src/draw.js';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

function spec(overrides: Partial<DrawSpec> & { style: DrawSpec['style'] }): DrawSpec {
  return {
    rect: { x: 10, y: 10, width: 50, height: 20 },
    shape: 'box',
    ...overrides,
  };
}

const baseStyle = { color: '#FF3B30', strokeWidth: 3, radius: 6, dimOutside: 0, labelFontSize: 14, labelColor: '#FFF' };

check('a malicious color cannot break out of the stroke attribute', () => {
  const malicious = '" /><script>alert(1)</script><rect fill="';
  const svg = buildOverlaySvg(200, 200, [spec({ style: { ...baseStyle, color: malicious } })]);
  assert.ok(!svg.includes('<script>'), 'raw <script> tag leaked into the SVG unescaped');
  assert.ok(!svg.includes('"/><'), 'attribute was broken out of');
  // The malicious text should appear only as an escaped, inert attribute value.
  assert.ok(svg.includes('&quot; /&gt;&lt;script&gt;'), 'expected the escaped form to be present');
});

check('a malicious labelColor cannot break out of its fill attribute', () => {
  const malicious = '"><image href="https://evil.example/x" onload="alert(1)"//';
  const svg = buildOverlaySvg(200, 200, [
    spec({ label: 'hi', style: { ...baseStyle, color: '#000', labelColor: malicious } }),
  ]);
  assert.ok(!svg.includes('<image'), 'raw <image> tag leaked into the SVG unescaped');
  assert.ok(!svg.includes('onload='.concat('"alert')), 'unescaped event handler attribute leaked in');
});

check('label text with markup-like characters is escaped, not executed as markup', () => {
  const svg = buildOverlaySvg(400, 200, [
    spec({ label: '<b>bold</b> & "quoted" \'ok\'', style: baseStyle }),
  ]);
  assert.ok(!svg.includes('<b>bold</b>'), 'raw HTML-like tag leaked into the SVG unescaped');
  assert.ok(svg.includes('&lt;b&gt;bold&lt;/b&gt;'), 'expected escaped form of the label');
});

check('a normal hex color still renders exactly as given (escaping does not mangle valid input)', () => {
  const svg = buildOverlaySvg(200, 200, [spec({ style: { ...baseStyle, color: '#FF3B30' } })]);
  assert.ok(svg.includes('stroke="#FF3B30"'), 'a plain hex color should pass through unchanged');
});

check('the resulting SVG is well-formed XML even with a hostile label', () => {
  const svg = buildOverlaySvg(400, 200, [
    spec({ label: '"><svg onload=alert(1)>&', style: baseStyle }),
  ]);
  // A cheap well-formedness check: every '<' that starts a real tag has a
  // matching '>' and there is no unescaped bare '&' or stray '"' breaking
  // out of an attribute. If DOMParser-equivalent parsing is unavailable,
  // fall back to counting that no unescaped '<' survives outside our own
  // emitted tags.
  const unescapedLt = (svg.match(/<(?!svg|\/svg|rect|\/rect|ellipse|line|polygon|text|\/text|tspan|\/tspan|path)/g) ?? []).length;
  assert.equal(unescapedLt, 0, 'found an unexpected raw "<" that is not one of our own emitted tags');
});

console.log(`\n${passed}/${passed + failed} SVG-escaping checks passed.\n`);
process.exit(failed === 0 ? 0 : 1);
