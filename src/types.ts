/** A rectangle in CSS pixels, relative to the top-level viewport. */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle in image pixels, relative to the screenshot's top-left corner. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the page looked like at the moment of measurement. */
export interface PageMetrics {
  /** window.devicePixelRatio, as the page itself reports it. */
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  /** Layout viewport, CSS px. */
  viewportWidth: number;
  viewportHeight: number;
  /** Full scrollable document, CSS px. */
  documentWidth: number;
  documentHeight: number;
}

/**
 * Fallback target for when the agent cannot name a clean selector: a rectangle
 * given as percentages, so it is independent of viewport size.
 */
export interface Region {
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  /** Percentages of the viewport (default) or of the whole document. */
  basis?: 'viewport' | 'document';
}

export interface MeasuredElement {
  /** Human-readable description of what was targeted. */
  selector: string;
  /** Whether this came from a selector match or a percentage region. */
  source: 'selector' | 'region';
  /** Viewport-relative, CSS px, including any ancestor-iframe offsets. */
  viewportRect: CssRect;
  /** Document-relative, CSS px (viewportRect + scroll, except for fixed elements). */
  documentRect: CssRect;
  /** True if the element or an ancestor is position:fixed, so it does not scroll. */
  isFixed: boolean;
  /** True if any part of the element is inside the current viewport. */
  inViewport: boolean;
  /** Extra frames the element was found inside, outermost first. */
  framePath: string[];
  tagName: string;
  /** How many elements the selector matched. Anything above 1 is ambiguous. */
  matchCount: number;
}

export type ShapeKind = 'box' | 'circle' | 'arrow';

export interface AnnotationStyle {
  /** CSS colour for the outline and label background. */
  color?: string;
  /** Outline width in CSS px; scaled by devicePixelRatio when drawn. */
  strokeWidth?: number;
  /** Grow the shape outwards by this many CSS px so it does not sit on the element's edge. */
  padding?: number;
  /** Corner radius in CSS px. */
  radius?: number;
  /** Darken everything outside the annotated regions. 0 disables. */
  dimOutside?: number;
  labelFontSize?: number;
  labelColor?: string;
}

export interface Annotation {
  /**
   * CSS selector, or a frame chain like ["iframe#checkout", ".pay-button"].
   * Mutually exclusive with `region`; exactly one must be set.
   */
  selector?: string | string[];
  /** Percentage-based fallback when no selector is available. */
  region?: Region;
  label?: string;
  shape?: ShapeKind;
  style?: AnnotationStyle;
}

export type ScreenshotMode = 'viewport' | 'fullPage' | 'element';

export interface AnnotateOptions {
  /** Where to screenshot: the viewport, the whole document, or a crop around the element. */
  mode?: ScreenshotMode;
  /** For mode 'element', how much context to keep around the element, in CSS px. */
  cropPadding?: number;
  /**
   * Scroll to the top before capturing a full-page screenshot. Chromium renders
   * fixed elements once, at whatever scroll offset the capture starts from, so
   * starting at the top is the only offset where fixed and static elements agree.
   */
  scrollToTop?: boolean;
  /** Bring the first annotated element into view before a viewport capture. */
  scrollIntoView?: boolean;
  style?: AnnotationStyle;
}

export interface AnnotateResult {
  image: Buffer;
  /** The same capture without the overlay, cropped identically. For verification. */
  rawImage: Buffer;
  /** Pixel dimensions of the returned image. */
  width: number;
  height: number;
  metrics: PageMetrics;
  elements: MeasuredElement[];
  /** Final drawn rectangles, in image pixels. Useful for asserting alignment. */
  drawnRects: PixelRect[];
  warnings: string[];
}
