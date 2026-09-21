import { describe, expect, expectTypeOf, it } from "vitest";
import * as timelineTime from "../features/timeline/time";

const RAW_FILES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

/**
 * The placement engines answer "where is this drawn, and what does it show".
 * Consumers ask that question through `TimelineTime`, so the engines stay
 * module-private and their behaviour reaches call sites as named methods.
 *
 * Two rules, because either one alone is escapable: the path rule stops a deep
 * import of an engine module, and the surface rule stops the same symbols being
 * re-exported from the boundary index (which is how the allowlist that this
 * guard replaced came back the first time).
 */
const ENGINE_MODULES =
  /(?:^|\/)(clipPresentation|resolveTrackTime|timelinePlacementMapper|playheadPlacement)$/;

/** Primitives whose job `TimelineTime` now names; see the method in brackets. */
const RESTRICTED_EXPORTS = [
  "buildTimelineClipPresentationIndex", // presentationIndex()
  "resolveClipOffsetForPresentationOffset", // toClipOffset()
  "resolvePresentationOffsetForClipOffset", // toPresentationOffset()
  "resolvePresentationTickForClipOffset", // presentationTickForClipOffset()
  "resolveStoredStartForPresentationStart", // resolveStoredStart()
  "resolveStoredEndForPresentationEnd", // resolveStoredEnd()
  "buildTimelineClipPresentationCollisionView", // collisionView()
  "introducesTimelineClipPresentationCollision", // introducesCollision()
  "collectTimelineClipPresentationCollisions", // collisionView() + caller's own diff
];

describe("timeline time boundary", () => {
  it("keeps all placement engines inside timeline/time with no exceptions", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(RAW_FILES)) {
      if (path.includes("__tests__") || path.includes(".test.") || path.includes("/timeline/time/")) continue;
      const imports = source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g);
      for (const match of imports) {
        if (ENGINE_MODULES.test(match[1])) {
          offenders.push(`${path} -> ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not re-export the placement primitives from the boundary index", () => {
    const surface = new Set(Object.keys(timelineTime));
    const leaked = RESTRICTED_EXPORTS.filter((name) => surface.has(name));
    expect(
      leaked,
      `Ask TimelineTime for these instead of re-exporting the primitive:\n${leaked.join("\n")}`,
    ).toEqual([]);
  });

  it("answers each restricted primitive with a TimelineTime method", () => {
    const time = timelineTime.getTimelineTime({ tracks: [], clips: [], fps: 30 });
    type PresentationEntry = ReturnType<
      typeof time.presentationIndex
    > extends ReadonlyMap<string, infer Entry>
      ? Entry
      : never;
    type LeakedMappingMethod = Extract<
      keyof PresentationEntry,
      | "mapPresentationOffsetToClipOffset"
      | "mapClipOffsetToPresentationOffset"
    >;
    expectTypeOf<LeakedMappingMethod>().toEqualTypeOf<never>();

    for (const method of [
      "presentationIndex",
      "toClipOffset",
      "toPresentationOffset",
      "presentationTickForClipOffset",
      "resolveStoredStart",
      "resolveStoredEnd",
      "collisionView",
      "introducesCollision",
    ]) {
      expect(time, `TimelineTime.${method} is the replacement surface`).toHaveProperty(method);
    }
  });
});
