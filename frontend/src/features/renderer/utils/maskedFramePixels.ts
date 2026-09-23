/**
 * Premultiplied values further apart than this are genuinely different
 * content; within it they are the same colour seen through 8-bit rounding.
 */
const PREMULTIPLIED_TOLERANCE = 1;

function premultiply(value: number, alpha: number): number {
  return Math.round((value * alpha) / 255);
}

/**
 * Combines a masked frame with the same frame rendered without masks, so the
 * pixels a mask hides keep their colour underneath zero alpha.
 *
 * Both inputs are straight (non-premultiplied) RGBA of the same size.
 *
 * 1. Fully transparent pixels take their colour from the unmasked render;
 *    their alpha stays 0, so the alpha channel is still the mask.
 * 2. Partially visible pixels (soft mask edges) take the unmasked colour only
 *    when it premultiplies to the same value as the masked one. At low alpha
 *    the renderer's 8-bit premultiplied storage leaves the straight colour
 *    noisy; the unmasked colour is the same content without that noise.
 * 3. Otherwise the masked pixel is kept — e.g. where a lower clip shows
 *    through the mask — so anything that honours alpha reproduces the masked
 *    composite.
 */
export function mergeMaskedFramePixels(
  masked: Uint8Array | Uint8ClampedArray,
  unmasked: Uint8Array | Uint8ClampedArray,
): Uint8ClampedArray {
  if (masked.length !== unmasked.length) {
    throw new Error(
      `Masked (${masked.length} bytes) and unmasked (${unmasked.length} bytes) frames differ in size`,
    );
  }
  const merged = new Uint8ClampedArray(masked);
  for (let i = 0; i < merged.length; i += 4) {
    const alpha = merged[i + 3];
    if (alpha === 255) continue;
    if (alpha > 0) {
      let sameContent = true;
      for (let c = 0; c < 3; c += 1) {
        if (
          Math.abs(
            premultiply(merged[i + c], alpha) -
              premultiply(unmasked[i + c], alpha),
          ) > PREMULTIPLIED_TOLERANCE
        ) {
          sameContent = false;
          break;
        }
      }
      if (!sameContent) continue;
    }
    merged[i] = unmasked[i];
    merged[i + 1] = unmasked[i + 1];
    merged[i + 2] = unmasked[i + 2];
  }
  return merged;
}

/** True when some pixel is fully transparent, i.e. there is colour to recover. */
export function hasFullyTransparentPixel(
  pixels: Uint8Array | Uint8ClampedArray,
): boolean {
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] === 0) return true;
  }
  return false;
}
