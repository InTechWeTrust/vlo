import { describe, expect, it } from "vitest";
import {
  collectHowToHeadingIds,
  createHeadingSlugger,
  howToAnchorTargetId,
  slugifyHeading,
} from "../howToHeadings";

describe("slugifyHeading", () => {
  it.each([
    ["Mask crop mode", "mask-crop-mode"],
    ["What comes back?", "what-comes-back"],
    ["Step 1: `crop_mode`", "step-1-crop_mode"],
    ["Café & Crème", "café--crème"],
    ["  Spaced  ", "spaced"],
  ])("%s -> %s", (text, slug) => {
    expect(slugifyHeading(text)).toBe(slug);
  });
});

describe("createHeadingSlugger", () => {
  it("suffixes repeated headings and names empty ones", () => {
    const slug = createHeadingSlugger();
    expect([slug("Tips"), slug("Tips"), slug("tips!"), slug("???")]).toEqual([
      "tips",
      "tips-1",
      "tips-2",
      "section",
    ]);
  });
});

describe("collectHowToHeadingIds", () => {
  it("assigns ids in document order and dedupes across fragments", () => {
    const ids = collectHowToHeadingIds([
      "# Guide\n\n## Tips\n\n> ### Quoted\n",
      null,
      "Setext\n======\n\n## Tips ![icon](i.png)\n\n```\n# not a heading\n```\n",
    ]);

    expect(ids).toEqual([
      ["howto-guide", "howto-tips", "howto-quoted"],
      [],
      ["howto-setext", "howto-tips-1"],
    ]);
  });
});

describe("howToAnchorTargetId", () => {
  it("maps authored fragments onto prefixed heading ids", () => {
    expect(howToAnchorTargetId("#mask-crop-mode")).toBe("howto-mask-crop-mode");
    expect(howToAnchorTargetId("#Inputs")).toBe("howto-inputs");
    expect(howToAnchorTargetId("#caf%C3%A9")).toBe("howto-café");
    expect(howToAnchorTargetId("#tips-1")).toBe("howto-tips-1");
    expect(howToAnchorTargetId("#")).toBeNull();
    expect(howToAnchorTargetId("#%ZZ")).toBeNull();
  });
});
