import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND } from "../../../../core/time/constants";
import type {
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
  collectTimelineRegionClips,
  createTimelinePlacementMapper,
  timelinePresentationRange,
  type TimelinePresentationRange,
} from "../../time";
import {
  presentationTick,
  storedTrackTick,
  timelineTimeValue,
} from "../timelineTimeDomains";

const FPS = 30;
const HALF_SECOND = TICKS_PER_SECOND / 2;

function track(id: string, type: TimelineTrack["type"]): TimelineTrack {
  return {
    id,
    type,
    label: id,
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
}

function video(start: number, duration = TICKS_PER_SECOND): VideoTimelineClip {
  return {
    id: "video",
    type: "video",
    name: "Video",
    assetId: "asset",
    trackId: "visual",
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

function rippleAdjustment(): AdjustmentTimelineClip {
  return {
    id: "ripple",
    type: "adjustment",
    name: "Ripple",
    trackId: "adjustment",
    start: 0,
    timelineDuration: TICKS_PER_SECOND,
    sourceDuration: 2 * TICKS_PER_SECOND,
    croppedSourceDuration: 2 * TICKS_PER_SECOND,
    transformedDuration: TICKS_PER_SECOND,
    transformedOffset: 0,
    offset: 0,
    transformations: [
      {
        id: "speed",
        type: "speed",
        isEnabled: true,
        parameters: { factor: 2 },
      },
    ],
    depth: 1,
    retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
  };
}

function mapper(clips: TimelineClip[]) {
  return createTimelinePlacementMapper({
    tracks: [track("adjustment", "adjustment"), track("visual", "visual")],
    clips,
    fps: FPS,
  });
}

describe("timelinePlacementMapper", () => {
  it("round-trips presentation and stored ticks without adjustments", () => {
    const source = video(TICKS_PER_SECOND);
    const placement = mapper([source]);

    for (const tick of [
      TICKS_PER_SECOND,
      TICKS_PER_SECOND + HALF_SECOND,
      2 * TICKS_PER_SECOND,
    ]) {
      const stored = placement.mapPresentationTickToStoredTick(
        source.id,
        presentationTick(tick),
      );
      expect(stored).not.toBeNull();
      expect(
        placement.mapStoredTickToPresentationTick(source.id, stored!),
      ).toBeCloseTo(tick, 6);
    }
  });

  it("maps and round-trips a clip shifted by a completed ripple adjustment", () => {
    const adjustment = rippleAdjustment();
    const source = video(2 * TICKS_PER_SECOND);
    const placement = mapper([adjustment, source]);

    expect(placement.getPresentationFootprint(source.id)).toEqual({
      start: TICKS_PER_SECOND,
      end: 2 * TICKS_PER_SECOND,
    });
    expect(
      placement.mapPresentationTickToStoredTick(
        source.id,
        presentationTick(TICKS_PER_SECOND + HALF_SECOND),
      ),
    ).toBe(2 * TICKS_PER_SECOND + HALF_SECOND);
    expect(
      placement.mapStoredTickToPresentationTick(
        source.id,
        storedTrackTick(2 * TICKS_PER_SECOND + HALF_SECOND),
      ),
    ).toBe(TICKS_PER_SECOND + HALF_SECOND);
  });

  it("projects a presentation range into correctly cropped local clips", () => {
    const adjustment = rippleAdjustment();
    const source = video(2 * TICKS_PER_SECOND);
    const placement = mapper([adjustment, source]);
    const range = timelinePresentationRange(
      TICKS_PER_SECOND + HALF_SECOND,
      2 * TICKS_PER_SECOND,
    );

    const segment = placement.intersectClipWithPresentationRange(
      source.id,
      range,
    );
    expect(segment).toEqual(
      expect.objectContaining({
        presentationStart: range.start,
        presentationEnd: range.end,
        storedStart: 2 * TICKS_PER_SECOND + HALF_SECOND,
        storedEnd: 3 * TICKS_PER_SECOND,
        localPresentationStart: 0,
      }),
    );

    const projected = placement.projectRegionToLocalTimeline(range, [source.id]);
    expect(projected.clips).toEqual([
      expect.objectContaining({
        id: source.id,
        start: 0,
        timelineDuration: HALF_SECOND,
        offset: HALF_SECOND,
        transformedOffset: HALF_SECOND,
        croppedSourceDuration: HALF_SECOND,
      }),
    ]);
  });

  it("retains an overlapping ripple adjustment in the projected local stack", () => {
    const adjustment = rippleAdjustment();
    const source = video(TICKS_PER_SECOND);
    const placement = mapper([adjustment, source]);
    const range = timelinePresentationRange(HALF_SECOND, TICKS_PER_SECOND);

    const projected = placement.projectRegionToLocalTimeline(range, [
      adjustment.id,
      source.id,
    ]);
    const localPlacement = mapper(projected.clips);

    expect(projected.clips).toContainEqual(
      expect.objectContaining({
        id: adjustment.id,
        start: 0,
        timelineDuration: HALF_SECOND,
        transformedOffset: HALF_SECOND,
        sourceDuration: TICKS_PER_SECOND,
      }),
    );
    expect(localPlacement.getPresentationFootprint(source.id)).toEqual({
      start: 0,
      end: HALF_SECOND,
    });
  });

  it("pins mappings to the construction snapshot", () => {
    const source = video(TICKS_PER_SECOND);
    const placement = mapper([source]);
    source.start = 5 * TICKS_PER_SECOND;

    expect(placement.getPresentationFootprint(source.id)).toEqual({
      start: TICKS_PER_SECOND,
      end: 2 * TICKS_PER_SECOND,
    });
  });
});

const TRACKS = [track("adjustment", "adjustment"), track("visual", "visual")];

function blurAdjustment(start: number): AdjustmentTimelineClip {
  return {
    ...rippleAdjustment(),
    id: "blur",
    start,
    sourceDuration: TICKS_PER_SECOND,
    croppedSourceDuration: TICKS_PER_SECOND,
    transformations: [
      {
        id: "blur",
        type: "filter",
        isEnabled: true,
        filterName: "BlurFilter",
        parameters: { strength: 4 },
      } as AdjustmentTimelineClip["transformations"][number],
    ],
  };
}

/**
 * The selection invariant: a region captured with `collectTimelineRegionClips`
 * and rendered detached must place every clip in the range exactly where the
 * full timeline does. Returns the in-range clip ids it checked.
 */
function expectDetachedRegionParity(
  clips: TimelineClip[],
  range: TimelinePresentationRange,
): string[] {
  const full = createTimelinePlacementMapper({ tracks: TRACKS, clips, fps: FPS });
  const detached = createTimelinePlacementMapper({
    tracks: TRACKS,
    clips: collectTimelineRegionClips({
      tracks: TRACKS,
      clips,
      fps: FPS,
      start: range.start,
      end: range.end,
    }),
    fps: FPS,
  });
  const inRange = full
    .getClipIdsInPresentationRange(range)
    .filter((id) => clips.find((clip) => clip.id === id)?.type !== "adjustment");
  for (const clipId of inRange) {
    expect(detached.getPresentationFootprint(clipId)).toEqual(
      full.getPresentationFootprint(clipId),
    );
    const segment = full.intersectClipWithPresentationRange(clipId, range)!;
    const segmentStart = timelineTimeValue(segment.presentationStart);
    const segmentEnd = timelineTimeValue(segment.presentationEnd);
    for (const fraction of [0, 0.25, 0.5, 0.75]) {
      const tick = presentationTick(
        segmentStart + fraction * (segmentEnd - segmentStart),
      );
      expect(detached.mapPresentationTickToStoredTick(clipId, tick)).toBeCloseTo(
        full.mapPresentationTickToStoredTick(clipId, tick)!,
        6,
      );
    }
  }
  return inRange;
}

describe("detached region topology", () => {
  it("carries a ripple adjustment that ends before the range", () => {
    const adjustment = rippleAdjustment();
    const source = video(2 * TICKS_PER_SECOND);
    const clips = [adjustment, source];
    const range = timelinePresentationRange(TICKS_PER_SECOND, 2 * TICKS_PER_SECOND);

    // The adjustment is not in the range, yet it is what places the clip there.
    expect(mapper(clips).getClipIdsInPresentationRange(range)).toEqual([source.id]);
    expect(
      collectTimelineRegionClips({
        tracks: TRACKS,
        clips,
        fps: FPS,
        start: range.start,
        end: range.end,
      }).map((clip) => clip.id),
    ).toEqual([adjustment.id, source.id]);
    expect(expectDetachedRegionParity(clips, range)).toEqual([source.id]);
    // Without it the clip falls back to its stored tick, outside the range.
    expect(mapper([source]).getPresentationFootprint(source.id)).toEqual({
      start: 2 * TICKS_PER_SECOND,
      end: 3 * TICKS_PER_SECOND,
    });
  });

  it("carries a static adjustment covering the head of a clip in the range", () => {
    const adjustment: AdjustmentTimelineClip = {
      ...rippleAdjustment(),
      retimingMode: ADJUSTMENT_RETIMING_STATIC,
    };
    const source = video(0, 4 * TICKS_PER_SECOND);
    const clips = [adjustment, source];
    const footprint = mapper(clips).getPresentationFootprint(source.id)!;
    const footprintEnd = timelineTimeValue(footprint.end);
    const range = timelinePresentationRange(
      footprintEnd - TICKS_PER_SECOND,
      footprintEnd,
    );

    expect(mapper(clips).getClipIdsInPresentationRange(range)).toEqual([source.id]);
    expect(expectDetachedRegionParity(clips, range)).toEqual([source.id]);
    // Without it the tail of the clip maps to different source content.
    expect(
      mapper([source]).mapPresentationTickToStoredTick(source.id, range.start),
    ).not.toBeCloseTo(
      mapper(clips).mapPresentationTickToStoredTick(source.id, range.start)!,
      0,
    );
  });

  it("leaves out adjustments that cannot reach the range", () => {
    const before = blurAdjustment(0);
    const after: AdjustmentTimelineClip = {
      ...rippleAdjustment(),
      id: "after",
      start: 3 * TICKS_PER_SECOND,
    };
    const source = video(TICKS_PER_SECOND);
    const clips = [before, after, source];

    expect(
      collectTimelineRegionClips({
        tracks: TRACKS,
        clips,
        fps: FPS,
        start: TICKS_PER_SECOND,
        end: 2 * TICKS_PER_SECOND,
      }).map((clip) => clip.id),
    ).toEqual([source.id]);
  });

  it("captures the retiming context for a single-frame region", () => {
    const adjustment = rippleAdjustment();
    const source = video(2 * TICKS_PER_SECOND);

    expect(
      collectTimelineRegionClips({
        tracks: TRACKS,
        clips: [adjustment, source],
        fps: FPS,
        start: TICKS_PER_SECOND + HALF_SECOND,
      }).map((clip) => clip.id),
    ).toEqual([adjustment.id, source.id]);
  });
});

