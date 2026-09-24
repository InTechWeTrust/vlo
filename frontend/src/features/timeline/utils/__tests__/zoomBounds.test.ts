import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  PIXELS_PER_SECOND,
  TICKS_PER_SECOND,
} from "../../constants";
import {
  ABSOLUTE_MIN_ZOOM,
  clampZoomScale,
  resolveMinZoomScale,
  zoomScaleAfterWheel,
} from "../zoomBounds";

const HOUR_TICKS = 3600 * TICKS_PER_SECOND;

describe("resolveMinZoomScale", () => {
  it("keeps the default floor for a timeline that already fits", () => {
    expect(resolveMinZoomScale(60 * TICKS_PER_SECOND, 1000)).toBe(MIN_ZOOM);
  });

  it("lets a long timeline zoom out until its whole duration fits", () => {
    const viewportPx = 1200;
    const minZoom = resolveMinZoomScale(HOUR_TICKS, viewportPx);

    expect(minZoom).toBeLessThan(MIN_ZOOM);
    expect(3600 * PIXELS_PER_SECOND * minZoom).toBeCloseTo(viewportPx);
  });

  it("never drops below the absolute floor", () => {
    expect(resolveMinZoomScale(1000 * HOUR_TICKS, 100)).toBe(ABSOLUTE_MIN_ZOOM);
  });

  it("falls back to the default floor before the viewport is measured", () => {
    expect(resolveMinZoomScale(HOUR_TICKS, 0)).toBe(MIN_ZOOM);
    expect(resolveMinZoomScale(HOUR_TICKS, -80)).toBe(MIN_ZOOM);
    expect(resolveMinZoomScale(0, 1000)).toBe(MIN_ZOOM);
  });
});

describe("clampZoomScale", () => {
  it("clamps between the given floor and MAX_ZOOM", () => {
    expect(clampZoomScale(0.001, 0.01)).toBe(0.01);
    expect(clampZoomScale(0.5, 0.01)).toBe(0.5);
    expect(clampZoomScale(MAX_ZOOM * 2, 0.01)).toBe(MAX_ZOOM);
  });
});

describe("zoomScaleAfterWheel", () => {
  it("changes zoom by the same proportion at every scale", () => {
    const nearRatio = zoomScaleAfterWheel(1, 100) / 1;
    const farRatio = zoomScaleAfterWheel(0.001, 100) / 0.001;
    expect(farRatio).toBeCloseTo(nearRatio);
    expect(nearRatio).toBeLessThan(1);
  });

  it("is reversible: one notch out then in returns to the start", () => {
    expect(zoomScaleAfterWheel(zoomScaleAfterWheel(0.02, 100), -100)).toBeCloseTo(
      0.02,
    );
  });
});
