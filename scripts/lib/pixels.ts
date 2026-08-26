import sharp from 'sharp';
import type { PixelRect } from '../../src/types.js';

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Bounding box of every pixel matching `hex`, in image pixels.
 *
 * This is the ground truth the whole alignment suite rests on: fixture targets
 * are painted a flat unique colour with no radius or border, so the pixels they
 * paint are exactly their border box.
 *
 * `tolerance` needs to be generous for a rescaled image, where resampling
 * blends the target's edge pixels with the background.
 */
export async function scanForColor(
  image: Buffer,
  hex: string,
  tolerance = 24,
): Promise<PixelRect | null> {
  const [tr, tg, tb] = hexToRgb(hex);
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (
        Math.abs((data[i] ?? 0) - tr) <= tolerance &&
        Math.abs((data[i + 1] ?? 0) - tg) <= tolerance &&
        Math.abs((data[i + 2] ?? 0) - tb) <= tolerance
      ) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Median colour of a small patch, as rendered.
 *
 * Needed because a screenshot's pixels are not necessarily the colour the CSS
 * asked for: Electron's macOS capture applies a colour-profile shift, turning
 * #FF00E4 into rgb(234,51,221). Sampling the image rather than trusting the
 * stylesheet keeps the scan exact without loosening tolerances to the point
 * where two different fixture colours become confusable.
 */
export async function sampleColor(
  image: Buffer,
  x: number,
  y: number,
  radius = 2,
): Promise<[number, number, number]> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const channels: [number[], number[], number[]] = [[], [], []];

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = Math.min(Math.max(x + dx, 0), info.width - 1);
      const py = Math.min(Math.max(y + dy, 0), info.height - 1);
      const i = (py * info.width + px) * info.channels;
      channels[0].push(data[i] ?? 0);
      channels[1].push(data[i + 1] ?? 0);
      channels[2].push(data[i + 2] ?? 0);
    }
  }

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  return [median(channels[0]), median(channels[1]), median(channels[2])];
}

export function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function clampToImage(rect: PixelRect, width: number, height: number): PixelRect {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  return {
    x,
    y,
    width: Math.min(rect.x + rect.width, width) - x,
    height: Math.min(rect.y + rect.height, height) - y,
  };
}

/** Signed edge deltas between a computed rect and the pixels actually painted. */
export function edgeDeltas(computed: PixelRect, painted: PixelRect) {
  return {
    left: computed.x - painted.x,
    top: computed.y - painted.y,
    right: computed.x + computed.width - (painted.x + painted.width),
    bottom: computed.y + computed.height - (painted.y + painted.height),
  };
}
