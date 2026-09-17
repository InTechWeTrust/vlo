// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { RGBSplitFilter } from "pixi-filters";
import type { Filter } from "pixi.js";
import {
  rgbSplitFilterDefinition,
  rgbSplitFilterRuntime,
} from "../filters/rgbSplit";
import { createStatelessFilterRenderContext } from "../renderSampleContext";
import type { ClipTransformTarget } from "../types";

const created: Filter[] = [];

function createRgbSplit(): RGBSplitFilter {
  const filter = rgbSplitFilterRuntime.create(`rgb-split-${created.length}`);
  if (!filter) throw new Error("RGB Split runtime did not create a filter");
  created.push(filter);
  return filter as RGBSplitFilter;
}

function update(
  filter: Filter,
  parameters: Record<string, unknown>,
  target: object = {},
): void {
  const output: Filter[] = [];
  expect(
    rgbSplitFilterRuntime.update(
      filter,
      parameters,
      {
        target: target as ClipTransformTarget,
        transformId: "rgb-split",
        render: createStatelessFilterRenderContext(),
      },
      output,
    ),
  ).toBe(true);
  expect(output).toEqual([filter]);
}

describe("rgbSplitFilterRuntime", () => {
  afterEach(() => {
    for (const filter of created.splice(0))
      rgbSplitFilterRuntime.release(filter);
  });

  it("scales every channel offset with world zoom", () => {
    expect(rgbSplitFilterDefinition.FilterClass).toBeUndefined();
    expect(rgbSplitFilterDefinition.filterRuntime).toBe(rgbSplitFilterRuntime);
    expect(rgbSplitFilterDefinition.filterParameterScale).toEqual({
      redX: "worldUniform",
      redY: "worldUniform",
      greenX: "worldUniform",
      greenY: "worldUniform",
      blueX: "worldUniform",
      blueY: "worldUniform",
    });
  });

  it("pads the filter frame by the largest channel offset", () => {
    const padding = rgbSplitFilterDefinition.filterPadding;
    expect(padding?.({})).toBe(0);
    expect(padding?.({ redX: 0, greenY: 0 })).toBe(0);
    expect(padding?.({ redX: -12.2, greenY: 8, blueX: Number.NaN })).toBe(14);
  });

  it("applies channel offsets and keeps the filter unclipped", () => {
    const filter = createRgbSplit();
    update(filter, {
      redX: 12,
      redY: -3,
      greenX: 4,
      greenY: -8,
      blueX: 1,
      blueY: 2,
    });
    expect(filter.clipToViewport).toBe(false);
    expect(filter.resolution).toBe(1);
    expect([filter.redX, filter.redY]).toEqual([12, -3]);
    expect([filter.greenX, filter.greenY]).toEqual([4, -8]);
    expect([filter.blueX, filter.blueY]).toEqual([1, 2]);
  });

  it("keeps channel offsets isolated per instance", () => {
    const first = createRgbSplit();
    const second = createRgbSplit();
    update(first, { redX: 33, greenY: -4, blueX: 7 });
    expect(first.red).not.toBe(second.red);
    expect([second.redX, second.greenY, second.blueX]).toEqual([-10, 10, 0]);

    // A later instance still starts from the documented defaults.
    const third = createRgbSplit();
    expect([third.redX, third.greenY, third.blueX]).toEqual([-10, 10, 0]);
  });

  it("ignores non-numeric offsets", () => {
    const filter = createRgbSplit();
    update(filter, { redX: 5 });
    update(filter, { redX: Number.NaN, greenY: "7" });
    expect(filter.redX).toBe(5);
    expect(filter.greenY).toBe(10);
  });

  it("lowers resolution only while target bounds exceed the texture limit", () => {
    const filter = createRgbSplit();
    update(filter, {}, { getBounds: () => ({ width: 40000, height: 22500 }) });
    expect(filter.resolution).toBeLessThan(1);
    update(filter, {}, { getBounds: () => ({ width: 1920, height: 1080 }) });
    expect(filter.resolution).toBe(1);
  });
});
