import { beforeEach, describe, expect, it } from "vitest";
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
import { useProjectStore } from "../../../project";
import {
  collectTimelineRegionClips,
  getTimelineClips,
  getTimelineClipsInPresentationRange,
} from "../../../timeline";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import {
  findRegionPlacementDrift,
  type CapturedRegion,
} from "../../../../testUtils/regionPlacementParity";
import {
  createPointTimelineSelection,
  createTimelineSelection,
  createTimelineSelectionFromClipIds,
} from "../createTimelineSelection";
import { selectionToCompositeContent } from "../composite";

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

interface Capture {
  region: CapturedRegion;
  range: { start: number; end: number };
  requireAllInRange: boolean;
}

interface Builder {
  /** The symbol the registry's `capture` entries name as their contract. */
  builder: string;
  capture(scenario: Scenario): Capture;
}

const absolute = (
  selection: { clips: TimelineClip[]; tracks?: TimelineTrack[] },
  scenario: Scenario,
): CapturedRegion => ({
  clips: selection.clips,
  tracks: selection.tracks ?? scenario.tracks,
  origin: 0,
});

const BUILDERS: Builder[] = [
  {
    builder: "createTimelineSelection",
    capture: (scenario) => ({
      region: absolute(
        createTimelineSelection(scenario.range.start, scenario.range.end),
        scenario,
      ),
      range: scenario.range,
      requireAllInRange: true,
    }),
  },
  {
    builder: "createPointTimelineSelection",
    capture: (scenario) => {
      const tick = scenario.range.start;
      return {
        region: absolute(createPointTimelineSelection(tick), scenario),
        range: { start: tick, end: tick + 1 },
        requireAllInRange: true,
      };
    },
  },
  {
    builder: "createTimelineSelectionFromClipIds",
    capture: (scenario) => {
      const clipIds = getTimelineClipsInPresentationRange(
        scenario.range.start,
        scenario.range.end,
      )
        .filter((clip) => clip.type !== "adjustment")
        .map((clip) => clip.id);
      const selection = createTimelineSelectionFromClipIds({ clipIds })!;
      return {
        region: absolute(selection, scenario),
        range: { start: selection.start, end: selection.end! },
        requireAllInRange: false,
      };
    },
  },
  {
    // Range export and the e2e export probe build their selection clips with it.
    builder: "collectTimelineRegionClips",
    capture: (scenario) => ({
      region: {
        clips: collectTimelineRegionClips({
          tracks: scenario.tracks,
          clips: scenario.clips,
          fps: FPS,
          ...scenario.range,
        }),
        tracks: scenario.tracks,
        origin: 0,
      },
      range: scenario.range,
      requireAllInRange: true,
    }),
  },
  {
    // What groupSelectionIntoComposite does: the in-range clips, projected to
    // local time against the full timeline.
    builder: "selectionToCompositeContent",
    capture: (scenario) => {
      const content = selectionToCompositeContent(
        {
          ...scenario.range,
          clips: getTimelineClipsInPresentationRange(
            scenario.range.start,
            scenario.range.end,
          ),
          tracks: scenario.tracks,
        },
        FPS,
        getTimelineClips(),
      );
      return {
        region: {
          clips: content.clips,
          tracks: content.tracks ?? scenario.tracks,
          origin: scenario.range.start,
        },
        range: scenario.range,
        requireAllInRange: true,
      };
    },
  },
];

function load(scenario: Scenario): void {
  useProjectStore.setState((state) => ({ config: { ...state.config, fps: FPS } }));
  useTimelineStore.getState().replaceTimelineSnapshot({
    tracks: structuredClone(scenario.tracks),
    clips: structuredClone(scenario.clips),
  });
}

const context = (scenario: Scenario) => ({
  tracks: scenario.tracks,
  clips: scenario.clips,
  fps: FPS,
});

describe("selection builder contract", () => {
  beforeEach(() => {
    useTimelineStore.getState().replaceTimelineSnapshot({ tracks: [], clips: [] });
  });

  for (const scenario of SCENARIOS) {
    describe(`with ${scenario.name}`, () => {
      for (const { builder, capture } of BUILDERS) {
        it(`${builder} captures what the timeline shows`, () => {
          load(scenario);
          const { region, range, requireAllInRange } = capture(scenario);

          expect(
            region.clips.some((clip) => clip.type !== "adjustment"),
            "the capture holds the clips in the range",
          ).toBe(true);
          expect(
            findRegionPlacementDrift(region, context(scenario), {
              range,
              requireAllInRange,
            }),
          ).toEqual([]);
        });
      }

      if (scenario.contextOutsideRange) {
        it("breaks a naive capture of only the in-range clips", () => {
          load(scenario);
          const naive = getTimelineClipsInPresentationRange(
            scenario.range.start,
            scenario.range.end,
          );
          expect(
            findRegionPlacementDrift(
              { clips: naive, tracks: scenario.tracks, origin: 0 },
              context(scenario),
              { range: scenario.range },
            ),
          ).not.toEqual([]);
        });
      }
    });
  }
});
