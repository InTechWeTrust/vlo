import { convertLegacyTimelineSelection, getTimelineTime, timelinePresentationRange } from "..";
import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND } from "../../../../core/time/constants";
import type {
  AdjustmentRetimingMode,
  AdjustmentTimelineClip,
  TimelineClip,
  TimelineTrack,
  VideoTimelineClip,
} from "../../../../types/TimelineTypes";
import {
  ADJUSTMENT_RETIMING_RIPPLE,
  ADJUSTMENT_RETIMING_STATIC,
} from "../../../../types/TimelineTypes";
import {
  findRegionPlacementDrift,
} from "../../../../testUtils/regionPlacementParity";

/**
 * Contract for every builder that captures a region of a live timeline (the
 * `capture` entries of the registry in `selectionBuilderRegistryGuard`): a
 * capture renders detached, so it must place each clip where the timeline
 * shows it and show the same source content — including when the retiming
 * that places those clips sits outside the captured range.
 *
 * Adding a capture builder: add it to BUILDERS below and to the registry.
 * Adding a retiming shape the builders must survive: add it to SCENARIOS.
 */

const FPS = 30;
const SECOND = TICKS_PER_SECOND;

function track(id: string, type: TimelineTrack["type"]): TimelineTrack {
  return { id, type, label: id, isVisible: true, isMuted: false, isLocked: false };
}

function video(id: string, trackId: string, start: number, duration: number): VideoTimelineClip {
  return {
    id,
    type: "video",
    name: id,
    assetId: "asset",
    trackId,
    start,
    timelineDuration: duration,
    sourceDuration: duration,
    croppedSourceDuration: duration,
    transformedDuration: duration,
    transformedOffset: 0,
    offset: 0,
    transformations: [],
  };
}

function speedAdjustment(
  id: string,
  trackId: string,
  retimingMode: AdjustmentRetimingMode,
  options: { start?: number; depth?: AdjustmentTimelineClip["depth"] } = {},
): AdjustmentTimelineClip {
  return {
    id,
    type: "adjustment",
    name: id,
    trackId,
    start: options.start ?? 0,
    timelineDuration: SECOND,
    sourceDuration: 2 * SECOND,
    croppedSourceDuration: 2 * SECOND,
    transformedDuration: SECOND,
    transformedOffset: 0,
    offset: 0,
    transformations: [
      { id: `${id}-speed`, type: "speed", isEnabled: true, parameters: { factor: 2 } },
    ],
    depth: options.depth ?? 1,
    retimingMode,
  };
}

interface Scenario {
  name: string;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  range: { start: number; end: number };
  /** True when the retiming sits outside the range (the naive capture fails). */
  contextOutsideRange: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: "a ripple adjustment ending before the range",
    tracks: [track("adj", "adjustment"), track("visual", "visual")],
    clips: [
      speedAdjustment("ripple", "adj", ADJUSTMENT_RETIMING_RIPPLE),
      video("shifted", "visual", 2 * SECOND, 2 * SECOND),
    ],
    range: { start: SECOND, end: 2 * SECOND },
    contextOutsideRange: true,
  },
  {
    name: "a static adjustment over the head of a clip",
    tracks: [track("adj", "adjustment"), track("visual", "visual")],
    clips: [
      speedAdjustment("static", "adj", ADJUSTMENT_RETIMING_STATIC),
      video("long", "visual", 0, 4 * SECOND),
    ],
    range: { start: 2 * SECOND, end: 3 * SECOND },
    contextOutsideRange: true,
  },
  {
    name: "a ripple adjustment overlapping the range",
    tracks: [track("adj", "adjustment"), track("visual", "visual")],
    clips: [
      speedAdjustment("ripple", "adj", ADJUSTMENT_RETIMING_RIPPLE),
      video("under", "visual", 0, 4 * SECOND),
    ],
    range: { start: SECOND / 2, end: 2 * SECOND },
    contextOutsideRange: false,
  },
  {
    name: "nested ripple and static adjustments before the range",
    tracks: [
      track("outer", "adjustment"),
      track("inner", "adjustment"),
      track("visual", "visual"),
    ],
    clips: [
      speedAdjustment("outer-ripple", "outer", ADJUSTMENT_RETIMING_RIPPLE, {
        depth: "all",
      }),
      speedAdjustment("inner-static", "inner", ADJUSTMENT_RETIMING_STATIC, {
        start: 2 * SECOND,
      }),
      video("first", "visual", 0, 2 * SECOND),
      video("second", "visual", 2 * SECOND, 4 * SECOND),
    ],
    range: { start: 3 * SECOND, end: 4 * SECOND },
    contextOutsideRange: true,
  },
];

describe("projected region contract", () => {
  for (const scenario of SCENARIOS) {
    it(`preserves placement and source frames with ${scenario.name}`, () => {
      const context = { tracks: scenario.tracks, clips: scenario.clips, fps: FPS };
      const projected = getTimelineTime(context).projectRegion(timelinePresentationRange(scenario.range.start, scenario.range.end));
      expect(findRegionPlacementDrift({ clips: projected.clips, tracks: scenario.tracks, origin: scenario.range.start }, context, { range: scenario.range, requireAllInRange: true })).toEqual([]);
    });
  }
});

describe("legacy selection replay", () => {
  for (const scenario of SCENARIOS) {
    it(`replays saved ${scenario.name} from its own topology`, () => {
      const legacy = JSON.parse(JSON.stringify({
        ...scenario.range, clips: scenario.clips, tracks: scenario.tracks, fps: FPS,
      }));
      const converted = convertLegacyTimelineSelection(legacy);
      expect(converted.version).toBe(2);
      expect(converted.anchor).toBe(scenario.range.start);
      expect(findRegionPlacementDrift({
        clips: converted.region.clips, tracks: converted.region.tracks!, origin: converted.anchor,
      }, { tracks: scenario.tracks, clips: scenario.clips, fps: FPS }, { range: scenario.range, requireAllInRange: true })).toEqual([]);
      expect(convertLegacyTimelineSelection(converted)).toBe(converted);
    });
  }

  it("preserves the old output when a legacy snapshot omitted earlier retiming", () => {
    const scenario = SCENARIOS[0];
    const clips = scenario.clips.filter((clip) => clip.type !== "adjustment");
    const legacy = { ...scenario.range, clips, tracks: scenario.tracks, fps: FPS };
    const converted = convertLegacyTimelineSelection(legacy);
    expect(findRegionPlacementDrift({ clips: converted.region.clips, tracks: scenario.tracks, origin: converted.anchor }, { clips, tracks: scenario.tracks, fps: FPS }, { range: scenario.range })).toEqual([]);
    expect(converted.region.clips).toEqual([]);
  });
});
