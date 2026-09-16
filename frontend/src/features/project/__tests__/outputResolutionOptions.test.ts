import { describe, expect, it } from "vitest";
import { normalizeProjectOutputResolution } from "../outputResolutionOptions";

describe("normalizeProjectOutputResolution", () => {
  it.each([480, 768, 1080, 2160])("accepts an even short edge: %s", (value) => {
    expect(normalizeProjectOutputResolution(value)).toBe(value);
  });

  it.each([null, "768", 0, 769, 9000, Number.NaN])(
    "rejects an unusable short edge: %s",
    (value) => {
      expect(normalizeProjectOutputResolution(value)).toBeNull();
    },
  );
});
