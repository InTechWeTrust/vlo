import { describe, expect, it } from "vitest";
import {
  computeGlitchPattern,
  GLITCH_SAMPLE_SIZE,
  normalizeGlitchSliceCount,
  resolveGlitchPatternInputs,
} from "../glitchPattern";

const BASE = { seed: 0, slices: 5, minSize: 8, average: false };

function sum(values: Float32Array): number {
  return values.reduce((total, value) => total + value, 0);
}

describe("computeGlitchPattern", () => {
  it("returns identical patterns for identical inputs", () => {
    const first = computeGlitchPattern(BASE);
    const second = computeGlitchPattern({ ...BASE });
    expect(Array.from(first.sizes)).toEqual(Array.from(second.sizes));
    expect(Array.from(first.offsets)).toEqual(Array.from(second.offsets));
  });

  it("changes the pattern when the seed changes, including fractionally", () => {
    const base = computeGlitchPattern(BASE);
    const integer = computeGlitchPattern({ ...BASE, seed: 1 });
    const fractional = computeGlitchPattern({ ...BASE, seed: 0.1 });
    expect(Array.from(integer.offsets)).not.toEqual(Array.from(base.offsets));
    expect(Array.from(fractional.offsets)).not.toEqual(
      Array.from(base.offsets),
    );
    expect(Array.from(fractional.offsets)).not.toEqual(
      Array.from(integer.offsets),
    );
  });

  it.each([false, true])(
    "produces a valid partition with average=%s",
    (average) => {
      for (const slices of [1, 2, 5, 17, 50]) {
        const pattern = computeGlitchPattern({
          ...BASE,
          slices,
          average,
          seed: 42,
        });
        expect(pattern.sizes).toHaveLength(slices);
        expect(pattern.offsets).toHaveLength(slices);
        expect(sum(pattern.sizes)).toBeCloseTo(1, 5);
        for (const offset of pattern.offsets) {
          expect(Math.abs(offset)).toBeLessThanOrEqual(1);
        }
      }
    },
  );

  it("honours the minimum slice size", () => {
    const minSize = 40;
    const pattern = computeGlitchPattern({
      ...BASE,
      slices: 8,
      minSize,
      seed: 3,
    });
    const min = Math.min(minSize / GLITCH_SAMPLE_SIZE, 0.9 / 8);
    // The final slice takes the remainder; every generated slice respects min.
    const generated = Array.from(pattern.sizes).filter(
      (size) => size >= min - 1e-6,
    );
    expect(generated.length).toBeGreaterThanOrEqual(7);
  });

  it("depends on Min Size and Average", () => {
    const base = computeGlitchPattern({ ...BASE, slices: 12, seed: 7 });
    const minSize = computeGlitchPattern({
      ...BASE,
      slices: 12,
      seed: 7,
      minSize: 40,
    });
    const average = computeGlitchPattern({
      ...BASE,
      slices: 12,
      seed: 7,
      average: true,
    });
    expect(Array.from(minSize.sizes)).not.toEqual(Array.from(base.sizes));
    expect(Array.from(average.sizes)).not.toEqual(Array.from(base.sizes));
  });
});

describe("resolveGlitchPatternInputs", () => {
  it("normalizes fractional and invalid slice counts", () => {
    expect(normalizeGlitchSliceCount(4.4)).toBe(4);
    expect(normalizeGlitchSliceCount(4.6)).toBe(5);
    expect(normalizeGlitchSliceCount(0.2)).toBe(1);
    expect(normalizeGlitchSliceCount(Number.NaN)).toBe(5);
    expect(normalizeGlitchSliceCount(undefined)).toBe(5);
    expect(normalizeGlitchSliceCount(1e9)).toBe(GLITCH_SAMPLE_SIZE);
  });

  it("canonicalizes the seed and fills defaults", () => {
    expect(resolveGlitchPatternInputs({ seed: -0 })).toEqual({
      seed: 0,
      slices: 5,
      minSize: 8,
      average: false,
    });
  });
});
