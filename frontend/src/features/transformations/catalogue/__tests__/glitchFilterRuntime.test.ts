// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlitchFilter } from "pixi-filters";
import type { Filter } from "pixi.js";
import {
  glitchFilterDefinition,
  glitchFilterRuntime,
  patchGlitchShaderSource,
  resolveGlitchFilterResolution,
} from "../filters/glitch";
import { createStatelessFilterRenderContext } from "../renderSampleContext";
import type { ClipTransformTarget } from "../types";
import { computeGlitchPattern } from "../../utils/glitchPattern";

const PARAMS = {
  slices: 6,
  offset: 120,
  direction: 15,
  seed: 3.5,
  minSize: 8,
  average: false,
};

let transformCounter = 0;
const created: Filter[] = [];

function createGlitch(): GlitchFilter {
  transformCounter += 1;
  const filter = glitchFilterRuntime.create(`glitch-${transformCounter}`);
  if (!filter) throw new Error("Glitch runtime did not create a filter");
  created.push(filter);
  return filter as GlitchFilter;
}

function update(
  filter: Filter,
  parameters: Record<string, unknown>,
  target: object = {},
): void {
  const output: Filter[] = [];
  const updated = glitchFilterRuntime.update(
    filter,
    parameters,
    {
      target: target as ClipTransformTarget,
      transformId: "glitch",
      render: createStatelessFilterRenderContext(),
    },
    output,
  );
  expect(updated).toBe(true);
  expect(output).toEqual([filter]);
}

function snapshot(filter: GlitchFilter) {
  return {
    sizes: Array.from(filter.sizes),
    offsets: Array.from(filter.offsets),
  };
}

describe("glitchFilterRuntime", () => {
  let redraws = 0;

  beforeEach(() => {
    redraws = 0;
    // jsdom has no 2D canvas; the upstream redraw only needs these calls.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        ({
          clearRect: () => {
            redraws += 1;
          },
          fillRect: () => undefined,
          fillStyle: "",
        }) as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
    );
  });

  afterEach(() => {
    for (const filter of created.splice(0)) glitchFilterRuntime.release(filter);
    vi.restoreAllMocks();
  });

  it("uses the runtime, scales offset, and disables viewport clipping", () => {
    expect(glitchFilterDefinition.FilterClass).toBeUndefined();
    expect(glitchFilterDefinition.filterRuntime).toBe(glitchFilterRuntime);
    expect(glitchFilterDefinition.filterParameterScale).toEqual({
      offset: "worldUniform",
    });
    expect(createGlitch().clipToViewport).toBe(false);
  });

  it("draws the same pattern in independent instances", () => {
    const first = createGlitch();
    const second = createGlitch();
    update(first, PARAMS);
    update(second, PARAMS);

    const expected = computeGlitchPattern({
      seed: 3.5,
      slices: 6,
      minSize: 8,
      average: false,
    });
    expect(snapshot(first)).toEqual(snapshot(second));
    expect(snapshot(first)).toEqual({
      sizes: Array.from(expected.sizes),
      offsets: Array.from(expected.offsets),
    });
    expect(first.offset).toBe(120);
    expect(first.direction).toBeCloseTo(15);
  });

  it("is independent of parameter order", () => {
    const first = createGlitch();
    const second = createGlitch();
    update(first, PARAMS);
    update(second, Object.fromEntries(Object.entries(PARAMS).reverse()));
    expect(snapshot(first)).toEqual(snapshot(second));
  });

  it("rebuilds for Seed, Min Size, and Average but not Offset or Direction", () => {
    const filter = createGlitch();
    update(filter, PARAMS);
    const base = snapshot(filter);
    const drawsAfterFirst = redraws;

    update(filter, { ...PARAMS, offset: 10, direction: -90 });
    expect(redraws).toBe(drawsAfterFirst);
    expect(snapshot(filter)).toEqual(base);

    update(filter, { ...PARAMS, seed: 4 });
    expect(snapshot(filter)).not.toEqual(base);

    update(filter, { ...PARAMS, minSize: 60 });
    const withMinSize = snapshot(filter);
    expect(withMinSize).not.toEqual(base);

    update(filter, { ...PARAMS, average: true });
    expect(snapshot(filter)).not.toEqual(withMinSize);
  });

  it("returns to the same pattern after seeking away and back", () => {
    const filter = createGlitch();
    update(filter, PARAMS);
    const base = snapshot(filter);

    update(filter, { ...PARAMS, slices: 11.3, seed: 90 });
    update(filter, { ...PARAMS, slices: 2 });
    update(filter, PARAMS);
    expect(snapshot(filter)).toEqual(base);

    update(filter, PARAMS);
    expect(snapshot(filter)).toEqual(base);
  });

  it("normalizes fractional animated slice counts", () => {
    const filter = createGlitch();
    update(filter, { ...PARAMS, slices: 5.6 });
    expect(filter.slices).toBe(6);

    const reference = createGlitch();
    update(reference, PARAMS);
    expect(snapshot(filter)).toEqual(snapshot(reference));
  });

  it("lowers filter resolution only while target bounds exceed the texture limit", () => {
    const filter = createGlitch();
    update(filter, PARAMS, {
      getBounds: () => ({ width: 1920, height: 1080 }),
    });
    expect(filter.resolution).toBe(1);

    update(filter, PARAMS, {
      getBounds: () => ({ width: 40000, height: 22500 }),
    });
    expect(filter.resolution).toBeLessThan(1);

    update(filter, PARAMS, {
      getBounds: () => ({ width: 1920, height: 1080 }),
    });
    expect(filter.resolution).toBe(1);
  });

  it("reproduces the pattern after release and recreation", () => {
    const first = createGlitch();
    update(first, PARAMS);
    const base = snapshot(first);
    glitchFilterRuntime.release(first);
    created.splice(created.indexOf(first), 1);

    const recreated = createGlitch();
    update(recreated, PARAMS);
    expect(snapshot(recreated)).toEqual(base);
  });
});

describe("Glitch shader patch", () => {
  it("converts vertical displacement through the input texture size in both backends", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        ({
          clearRect: () => undefined,
          fillRect: () => undefined,
          fillStyle: "",
        }) as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
    );
    const filter = glitchFilterRuntime.create("glitch-shader") as GlitchFilter;
    try {
      for (const source of [
        filter.glProgram.fragment,
        filter.gpuProgram.fragment?.source,
      ]) {
        expect(source).toContain(
          "sinDir * displacement * uInputSize.x * uInputSize.w",
        );
        expect(source).not.toContain("sinDir * displacement * uAspect");
      }
      // Instances share one compiled program pair.
      const second = glitchFilterRuntime.create(
        "glitch-shader-2",
      ) as GlitchFilter;
      expect(second.glProgram).toBe(filter.glProgram);
      expect(second.gpuProgram).toBe(filter.gpuProgram);
      glitchFilterRuntime.release(second);
    } finally {
      glitchFilterRuntime.release(filter);
      vi.restoreAllMocks();
    }
  });

  it("fails loudly if the upstream shader no longer matches", () => {
    expect(() => patchGlitchShaderSource("void main() {}", "GLSL")).toThrow(
      /Unexpected pixi-filters Glitch GLSL shader/,
    );
  });
});

describe("resolveGlitchFilterResolution", () => {
  it("keeps full resolution while the filter texture fits", () => {
    expect(resolveGlitchFilterResolution(null, 8192)).toBe(1);
    expect(
      resolveGlitchFilterResolution({ width: 1920, height: 1080 }, 8192),
    ).toBe(1);
    expect(resolveGlitchFilterResolution({ width: 0, height: 0 }, 8192)).toBe(
      1,
    );
  });

  it("lowers resolution so deeply zoomed bounds fit the device limit", () => {
    const resolution = resolveGlitchFilterResolution(
      { width: 19200, height: 10800 },
      16384,
    );
    expect(resolution).toBeLessThan(1);
    expect(19200 * resolution).toBeLessThanOrEqual(16384);
  });
});
