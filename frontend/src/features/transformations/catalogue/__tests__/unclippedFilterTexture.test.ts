import { describe, expect, it, vi } from "vitest";
import type { Filter, FilterSystem, RenderSurface, Texture } from "pixi.js";
import {
  configureUnclippedFilter,
  resolveUnclippedFilterResolution,
  withFilterTextureLimitRecording,
} from "../filters/unclippedFilterTexture";

const baseApply = vi.fn();

class BaseFilter {
  clipToViewport = true;
  resolution = 1;
  apply(...args: unknown[]): void {
    baseApply(...args);
  }
}

function boundsTarget(width: number, height: number) {
  return { getBounds: () => ({ width, height }) };
}

describe("resolveUnclippedFilterResolution", () => {
  it("keeps full resolution while the filter texture fits", () => {
    expect(resolveUnclippedFilterResolution(null, 8192)).toBe(1);
    expect(
      resolveUnclippedFilterResolution({ width: 1920, height: 1080 }, 8192),
    ).toBe(1);
    expect(
      resolveUnclippedFilterResolution({ width: 0, height: 0 }, 8192),
    ).toBe(1);
  });

  it("lowers resolution so deeply zoomed bounds fit the device limit", () => {
    const resolution = resolveUnclippedFilterResolution(
      { width: 19200, height: 10800 },
      16384,
    );
    expect(resolution).toBeLessThan(1);
    expect(19200 * resolution).toBeLessThanOrEqual(16384);
  });
});

describe("configureUnclippedFilter", () => {
  it("disables viewport clipping and uses the limit recorded on apply", () => {
    const RecordingFilter = withFilterTextureLimitRecording(
      BaseFilter as unknown as abstract new () => Filter,
    );
    const filter = new (RecordingFilter as unknown as new () => Filter)();

    // Before any apply, the conservative default limit is used.
    configureUnclippedFilter(filter, boundsTarget(6000, 3000));
    expect(filter.clipToViewport).toBe(false);
    expect(filter.resolution).toBeLessThan(1);

    const gl = {
      MAX_TEXTURE_SIZE: 1,
      MAX_RENDERBUFFER_SIZE: 2,
      getParameter: () => 16384,
    };
    filter.apply(
      { renderer: { gl } } as unknown as FilterSystem,
      {} as Texture,
      {} as RenderSurface,
      false,
    );

    expect(baseApply).toHaveBeenCalledTimes(1);

    configureUnclippedFilter(filter, boundsTarget(6000, 3000));
    expect(filter.resolution).toBe(1);

    configureUnclippedFilter(filter, boundsTarget(40000, 22500));
    expect(filter.resolution).toBeLessThan(1);
    expect(40000 * (filter.resolution as number)).toBeLessThanOrEqual(16384);
  });
});
