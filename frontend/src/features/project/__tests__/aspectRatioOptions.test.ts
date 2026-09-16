import { describe, expect, it } from "vitest";
import {
  isPresetAspectRatio,
  normalizeAspectRatio,
  parseAspectRatio,
} from "../aspectRatioOptions";

describe("normalizeAspectRatio", () => {
  it.each([
    ["16:9", "16:9"],
    [" 1344 : 768 ", "7:4"],
    ["1024:1024", "1:1"],
  ])("canonicalizes %s", (value, expected) => {
    expect(normalizeAspectRatio(value)).toBe(expected);
  });

  it.each([null, 1, "", "wide", "0:1", "1:0", "1.5:1", "100:1"])(
    "rejects %s",
    (value) => {
      expect(normalizeAspectRatio(value)).toBeNull();
    },
  );

  it("parses a canonical ratio", () => {
    expect(parseAspectRatio("14:8")).toEqual({ widthPart: 7, heightPart: 4 });
  });
});

describe("isPresetAspectRatio", () => {
  it("distinguishes preset and custom ratios", () => {
    expect(isPresetAspectRatio("16:9")).toBe(true);
    expect(isPresetAspectRatio("7:4")).toBe(false);
  });
});
