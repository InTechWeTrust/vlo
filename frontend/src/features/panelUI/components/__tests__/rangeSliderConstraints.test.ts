import { describe, expect, it } from "vitest";
import {
  constrainRangeEnd,
  isRangeCollapsed,
  normalizeRange,
  type RangeConstraints,
} from "../rangeSliderConstraints";

// A 20-step sampling window: the start must be a step the sampler still runs.
const window: RangeConstraints = {
  min: 0,
  max: 20,
  low: { max: 19 },
};

describe("range slider constraints", () => {
  it("stops the low end at the high end without pushing it", () => {
    expect(constrainRangeEnd([2, 5], "low", 9, window)).toEqual([5, 5]);
  });

  it("stops the high end at the low end without pushing it", () => {
    expect(constrainRangeEnd([6, 10], "high", 1, window)).toEqual([6, 6]);
  });

  it("keeps the requested gap between the ends", () => {
    expect(
      constrainRangeEnd([2, 5], "low", 9, { ...window, minDistance: 1 }),
    ).toEqual([4, 5]);
    expect(
      constrainRangeEnd([6, 10], "high", 1, { ...window, minDistance: 2 }),
    ).toEqual([6, 8]);
  });

  it("applies each end's own limits inside the track", () => {
    expect(constrainRangeEnd([1, 20], "low", 20, window)).toEqual([19, 20]);
    expect(constrainRangeEnd([1, 4], "high", 99, window)).toEqual([1, 20]);
    expect(constrainRangeEnd([3, 4], "low", -5, window)).toEqual([0, 4]);
  });

  it("draws an out-of-order pair collapsed at the low end", () => {
    expect(normalizeRange([6, 3], window)).toEqual([6, 6]);
    expect(isRangeCollapsed([6, 6])).toBe(true);
    expect(isRangeCollapsed([6, 7])).toBe(false);
  });

  it("pulls values that overshoot the track back inside it", () => {
    expect(normalizeRange([25, 30], window)).toEqual([19, 20]);
    expect(normalizeRange([-3, 4], window)).toEqual([0, 4]);
  });
});
