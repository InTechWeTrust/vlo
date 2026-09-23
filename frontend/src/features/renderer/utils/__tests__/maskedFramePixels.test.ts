import { describe, expect, it } from "vitest";
import {
  hasFullyTransparentPixel,
  mergeMaskedFramePixels,
} from "../maskedFramePixels";

describe("mergeMaskedFramePixels", () => {
  it("fills only fully transparent pixels from the unmasked render", () => {
    // prettier-ignore
    const masked = new Uint8ClampedArray([
      200, 10, 10, 255,   // inside the mask
      0, 0, 0, 0,         // hidden by the mask
      120, 60, 30, 40,    // soft mask edge
    ]);
    // prettier-ignore
    const unmasked = new Uint8ClampedArray([
      1, 1, 1, 255,
      30, 140, 250, 255,
      9, 9, 9, 255,
    ]);

    const merged = mergeMaskedFramePixels(masked, unmasked);

    expect([...merged]).toEqual([
      200, 10, 10, 255,
      // Colour recovered; alpha still says "outside the mask".
      30, 140, 250, 0,
      // Partially visible pixels stay exactly as composited.
      120, 60, 30, 40,
    ]);
    // Inputs are left untouched.
    expect(masked[4]).toBe(0);
  });

  it("replaces low-alpha rounding noise with the unmasked colour", () => {
    // At alpha 4 the masked straight colour is 8-bit premultiplication noise:
    // both colours premultiply to the same values.
    const masked = new Uint8ClampedArray([200, 100, 50, 4]);
    const unmasked = new Uint8ClampedArray([190, 110, 60, 255]);

    expect([...mergeMaskedFramePixels(masked, unmasked)]).toEqual([
      190, 110, 60, 4,
    ]);
  });

  it("keeps a soft edge where different content shows through", () => {
    // A lower clip shows through the mask: the premultiplied values differ.
    const masked = new Uint8ClampedArray([250, 10, 10, 128]);
    const unmasked = new Uint8ClampedArray([10, 10, 250, 255]);

    expect([...mergeMaskedFramePixels(masked, unmasked)]).toEqual([
      250, 10, 10, 128,
    ]);
  });

  it("rejects frames of different sizes", () => {
    expect(() =>
      mergeMaskedFramePixels(new Uint8ClampedArray(4), new Uint8ClampedArray(8)),
    ).toThrow(/differ in size/);
  });
});

describe("hasFullyTransparentPixel", () => {
  it("detects zero alpha only", () => {
    expect(
      hasFullyTransparentPixel(new Uint8ClampedArray([0, 0, 0, 1, 5, 5, 5, 255])),
    ).toBe(false);
    expect(
      hasFullyTransparentPixel(new Uint8ClampedArray([5, 5, 5, 255, 5, 5, 5, 0])),
    ).toBe(true);
  });
});
