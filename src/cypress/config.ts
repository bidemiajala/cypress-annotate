/// <reference types="cypress" />
import type { AnnotationStyle, ShapeKind } from '../types.js';

/**
 * Project-wide defaults, read from `env.annotate` in cypress.config.
 *
 *   export default defineConfig({
 *     env: {
 *       annotate: {
 *         style: { color: '#7C3AED', strokeWidth: 4 },
 *       },
 *     },
 *   });
 *
 * Cypress serialises `env` into the browser, so one block reaches cy.annotate()
 * and the failure hook alike, and `CYPRESS_annotate='{"style":{...}}'` overrides
 * it for a single CI job without a second mechanism to learn.
 *
 * Everything here is also settable per call, and the per-call value wins.
 */
export interface AnnotateEnvConfig {
  style?: AnnotationStyle;
  shape?: ShapeKind;
  /** Crop to the annotated element rather than keeping the whole viewport. */
  crop?: boolean;
  cropPadding?: number;
  /** Write `<name>.raw.png` beside every annotated shot, for diffing. */
  keepRaw?: boolean;
  /** Leave this many CSS px above an element that had to be scrolled to. */
  scrollOffset?: number;
  /** One JSON record per annotated screenshot. Default out/cypress/annotations.json. */
  manifestPath?: string;
  /** Where failure records accumulate. Default out/cypress/failures.json. */
  reportPath?: string;
}

export const DEFAULT_MANIFEST_PATH = 'out/cypress/annotations.json';
export const DEFAULT_REPORT_PATH = 'out/cypress/failures.json';

const STYLE_KEYS: Record<keyof Required<AnnotationStyle>, 'string' | 'number' | 'string|number'> = {
  color: 'string',
  strokeWidth: 'number',
  padding: 'number',
  radius: 'number',
  dimOutside: 'number',
  labelFontSize: 'number',
  labelColor: 'string',
  labelBackground: 'string',
  labelFontFamily: 'string',
  labelFontWeight: 'string|number',
};

const TOP_LEVEL_KEYS: Record<keyof Required<AnnotateEnvConfig>, string> = {
  style: 'object',
  shape: 'string',
  crop: 'boolean',
  cropPadding: 'number',
  keepRaw: 'boolean',
  scrollOffset: 'number',
  manifestPath: 'string',
  reportPath: 'string',
};

const SHAPES: ShapeKind[] = ['box', 'circle', 'arrow'];

// One warning per distinct problem per run. An afterEach hook would otherwise
// repeat the same typo once per test, which buries the run's real output.
const warned = new Set<string>();

function warn(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  // Cypress.log is unavailable outside a test body, so console is the floor.
  if (typeof Cypress !== 'undefined' && typeof Cypress.log === 'function') {
    Cypress.log({ name: 'annotate', message: `! ${message}` });
  }
  console.warn(`cypress-annotate: ${message}`);
}

function typeOf(value: unknown): string {
  return Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
}

function validateStyle(raw: Record<string, unknown>): AnnotationStyle {
  const style: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const expected = STYLE_KEYS[key as keyof AnnotationStyle];
    if (!expected) {
      warn(`env.annotate.style.${key} is not a style option and was ignored. Valid: ${Object.keys(STYLE_KEYS).join(', ')}.`);
      continue;
    }
    const actual = typeOf(value);
    if (expected === 'string|number' ? actual !== 'string' && actual !== 'number' : actual !== expected) {
      warn(`env.annotate.style.${key} should be a ${expected} but was a ${actual}; ignored.`);
      continue;
    }
    if (key === 'dimOutside' && ((value as number) < 0 || (value as number) > 1)) {
      warn(`env.annotate.style.dimOutside should be between 0 and 1 but was ${String(value)}; ignored.`);
      continue;
    }
    if (expected === 'number' && (value as number) < 0) {
      warn(`env.annotate.style.${key} should not be negative but was ${String(value)}; ignored.`);
      continue;
    }
    style[key] = value;
  }
  return style as AnnotationStyle;
}

/**
 * Reads and validates `Cypress.env('annotate')`. A typo is reported rather than
 * silently dropped, because a theme that quietly does nothing is worse than one
 * that says why.
 */
export function readAnnotateConfig(): AnnotateEnvConfig {
  const raw: unknown = typeof Cypress === 'undefined' ? undefined : Cypress.env('annotate');
  if (raw === undefined || raw === null) return {};
  if (typeOf(raw) !== 'object') {
    warn(`env.annotate should be an object but was a ${typeOf(raw)}; ignored.`);
    return {};
  }

  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const expected = TOP_LEVEL_KEYS[key as keyof AnnotateEnvConfig];
    if (!expected) {
      warn(`env.annotate.${key} is not an option and was ignored. Valid: ${Object.keys(TOP_LEVEL_KEYS).join(', ')}.`);
      continue;
    }
    if (typeOf(value) !== expected) {
      warn(`env.annotate.${key} should be a ${expected} but was a ${typeOf(value)}; ignored.`);
      continue;
    }
    if (key === 'style') {
      config.style = validateStyle(value as Record<string, unknown>);
      continue;
    }
    if (key === 'shape' && !SHAPES.includes(value as ShapeKind)) {
      warn(`env.annotate.shape should be one of ${SHAPES.join(', ')} but was "${String(value)}"; ignored.`);
      continue;
    }
    config[key] = value;
  }
  return config as AnnotateEnvConfig;
}
