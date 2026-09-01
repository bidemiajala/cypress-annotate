/**
 * The driver-agnostic half of the plugin.
 *
 * Everything here works on a PNG somebody else captured, so it never opens a
 * browser and never touches Cypress. The Cypress task goes through it, and so
 * can anything else that can produce a screenshot, the page metrics that were
 * true when it was taken, and rectangles in CSS pixels.
 */
export {
  annotateImage,
  resolveScale,
  resolveStyle,
  type AnnotateImageOptions,
  type AnnotateImageResult,
  type MeasuredTarget,
} from './annotate-image.js';
export { buildOverlaySvg, compositeOverlay } from './draw.js';
export type * from './types.js';
