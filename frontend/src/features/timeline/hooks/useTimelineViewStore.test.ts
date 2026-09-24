import { describe, it, expect, beforeEach } from "vitest";
import { useTimelineViewStore } from "./useTimelineViewStore";
import {
  TICKS_PER_SECOND,
  PIXELS_PER_SECOND,
  MIN_ZOOM,
  MAX_ZOOM,
} from "../constants";

describe("useTimelineViewStore", () => {
  beforeEach(() => {
    useTimelineViewStore.setState({
      zoomScale: 1,
      minZoomScale: MIN_ZOOM,
    });
  });

  it("initializes with default values", () => {
    const state = useTimelineViewStore.getState();
    expect(state.zoomScale).toBe(1);
  });

  it("updates zoom scale within bounds", () => {
    const store = useTimelineViewStore.getState();

    // Valid update
    store.setZoomScale(2);
    expect(useTimelineViewStore.getState().zoomScale).toBe(2);

    store.setZoomScale(MIN_ZOOM / 2);
    expect(useTimelineViewStore.getState().zoomScale).toBe(MIN_ZOOM);

    store.setZoomScale(MAX_ZOOM * 2);
    expect(useTimelineViewStore.getState().zoomScale).toBe(MAX_ZOOM);
  });

  it("clamps zoom-out to the length-dependent floor", () => {
    const store = useTimelineViewStore.getState();
    store.setMinZoomScale(0.005);

    store.setZoomScale(0.01);
    expect(useTimelineViewStore.getState().zoomScale).toBe(0.01);

    store.setZoomScale(0.001);
    expect(useTimelineViewStore.getState().zoomScale).toBe(0.005);
  });

  it("does not move the current zoom when the floor rises", () => {
    const store = useTimelineViewStore.getState();
    store.setMinZoomScale(0.005);
    store.setZoomScale(0.005);

    store.setMinZoomScale(MIN_ZOOM);
    expect(useTimelineViewStore.getState().zoomScale).toBe(0.005);
  });

  it("calculates ticksToPx correctly based on zoom", () => {
    const store = useTimelineViewStore.getState();
    const ticks = TICKS_PER_SECOND; // 1 second worth of ticks

    // Zoom 1.0 -> Default PPS
    expect(store.ticksToPx(ticks)).toBe(PIXELS_PER_SECOND);

    // Zoom 2.0 -> Double pixels
    store.setZoomScale(2);
    expect(store.ticksToPx(ticks)).toBe(PIXELS_PER_SECOND * 2);

    // Zoom 0.5 -> Half pixels
    store.setZoomScale(0.5);
    expect(store.ticksToPx(ticks)).toBe(PIXELS_PER_SECOND * 0.5);
  });

  it("calculates pxToTicks correctly based on zoom", () => {
    const store = useTimelineViewStore.getState();
    const pixels = PIXELS_PER_SECOND; // 100px

    // Zoom 1.0 -> 100px = 1 second
    expect(store.pxToTicks(pixels)).toBe(TICKS_PER_SECOND);

    // Zoom 2.0 -> 100px = 0.5 seconds (visuals are stretched, so 100px covers less time)
    store.setZoomScale(2);
    expect(store.pxToTicks(pixels)).toBe(TICKS_PER_SECOND / 2);

    // Zoom 0.5 -> 100px = 2 seconds (visuals are shrunk, so 100px covers more time)
    store.setZoomScale(0.5);
    expect(store.pxToTicks(pixels)).toBe(TICKS_PER_SECOND * 2);
  });
});
