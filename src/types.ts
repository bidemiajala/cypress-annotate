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
  /** Label pill background. Defaults to `color`, so one value themes both. */
  labelBackground?: string;
  /** CSS font-family for the label. */
  labelFontFamily?: string;
  /** CSS font-weight for the label. */
  labelFontWeight?: string | number;
}
