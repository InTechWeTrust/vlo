import { ticksToPx } from "../../../core/time/pixelGrid";
import { MIN_ZOOM, MAX_ZOOM } from "../constants";

/**
 * Hard floor under the length-dependent minimum. Only reached by pathological
 * timelines (fitting ~27 hours into 1000px); it keeps the zoom finite and
 * positive whatever the content length.
 */
export const ABSOLUTE_MIN_ZOOM = 1e-4;

/**
 * The furthest the timeline may zoom out. `MIN_ZOOM` is enough for short
 * timelines. A timeline too long to fit in the viewport at `MIN_ZOOM` may zoom
 * out further, until its whole duration fits in `viewportContentWidthPx`.
 */
export function resolveMinZoomScale(
  contentDurationTicks: number,
  viewportContentWidthPx: number,
): number {
  const contentWidthAtUnitZoom = ticksToPx(contentDurationTicks, 1);
  if (!(viewportContentWidthPx > 0) || !(contentWidthAtUnitZoom > 0)) {
    return MIN_ZOOM;
  }

  const fitZoom = viewportContentWidthPx / contentWidthAtUnitZoom;
  return Math.max(ABSOLUTE_MIN_ZOOM, Math.min(MIN_ZOOM, fitZoom));
}

export function clampZoomScale(scale: number, minZoomScale: number): number {
  return Math.max(minZoomScale, Math.min(scale, MAX_ZOOM));
}

/**
 * Wheel zoom is multiplicative so each notch changes the scale by the same
 * proportion at every zoom. An additive step would jump from the far zoom-out
 * range straight to 1x in a single notch.
 */
const WHEEL_ZOOM_RATE = 0.006;

export function zoomScaleAfterWheel(scale: number, deltaY: number): number {
  return scale * Math.exp(-deltaY * WHEEL_ZOOM_RATE);
}
