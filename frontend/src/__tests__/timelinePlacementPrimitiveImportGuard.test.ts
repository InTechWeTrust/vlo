import { describe, expect, it } from "vitest";

const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

describe("timeline time boundary", () => {
  it("keeps all placement engines inside timeline/time with no exceptions", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(RAW_FILES)) {
      if (path.includes("__tests__") || path.includes(".test.") || path.includes("/timeline/time/")) continue;
      const imports = source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g);
      for (const match of imports) {
        if (/(?:^|\/)(clipPresentation|resolveTrackTime|timelinePlacementMapper|playheadPlacement)$/.test(match[1])) {
          offenders.push(`${path} -> ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
