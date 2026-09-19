import type {
  MaskTimelineClip,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import {
  buildTimelineClipPresentationIndex,
  resolveStoredStartForPresentationStart,
  type TimelineClipPresentation,
} from "./clipPresentation";
import { getResizedClipLeft, getResizedClipRight } from "./clipMath";
import { hasEnabledSpeedTransform } from "../../renderer/utils/deriveAdjustmentGroups";
import {
  clipOffsetTick,
  presentationTick,
  storedTrackTick,
  timelineTimeValue,
  type ClipOffsetTick,
  type PresentationTick,
  type StoredTrackTick,
} from "./timelineTimeDomains";

export interface TimelinePresentationRange {
  start: PresentationTick;
  end: PresentationTick;
}

export function timelinePresentationRange(
  start: number,
  end: number,
): TimelinePresentationRange {
  return { start: presentationTick(start), end: presentationTick(end) };
}

export interface ProjectedTimelineClipSegment {
  clipId: string;
  presentationStart: PresentationTick;
  presentationEnd: PresentationTick;
  storedStart: StoredTrackTick;
  storedEnd: StoredTrackTick;
  storedStartOffset: ClipOffsetTick;
  storedEndOffset: ClipOffsetTick;
  localPresentationStart: PresentationTick;
}

export interface ProjectedTimelineRegion {
  range: TimelinePresentationRange;
  clips: TimelineClip[];
  segmentsByClipId: ReadonlyMap<string, ProjectedTimelineClipSegment>;
}

export interface TimelinePlacementMapper {
  getPresentationFootprint(
    clipId: string,
  ): TimelinePresentationRange | null;
  mapPresentationTickToStoredTick(
    clipId: string,
    presentationTick: PresentationTick,
  ): StoredTrackTick | null;
  mapStoredTickToPresentationTick(
    clipId: string,
    storedTick: StoredTrackTick,
  ): PresentationTick | null;
  resolveStoredStart(
    trackId: string,
    presentationStart: PresentationTick,
  ): StoredTrackTick;
  intersectClipWithPresentationRange(
    clipId: string,
    range: TimelinePresentationRange,
  ): ProjectedTimelineClipSegment | null;
  getClipIdsAtPresentationTick(presentationTick: PresentationTick): string[];
  getClipIdsInPresentationRange(range: TimelinePresentationRange): string[];
  /**
   * Clip ids a detached copy of `range` (a `TimelineSelection`) must carry to
   * reproduce this snapshot's presentation of it: the clips in the range
   * (`getClipIdsInPresentationRange`) plus every retiming adjustment whose
   * footprint starts before the range ends, with their mask children.
   *
   * A selection is rendered by rebuilding presentation from its own clips, and
   * adjustment retiming is carried forward past the adjustment's window: a
   * ripple adjustment that ends before the range still shifts every later clip,
   * and a static one covering the head of a clip still offsets that clip's
   * source mapping. Dropping them re-places the range's clips at their stored
   * ticks. Adjustments starting at or after the range end cannot reach it.
   */
  getRegionTopologyClipIds(range: TimelinePresentationRange): string[];
  /**
   * The retiming half of `getRegionTopologyClipIds`: adjustments with an
   * enabled speed transform whose footprint starts before `range` ends, plus
   * their mask children. For builders that pick their own clips (by id) but
   * still render detached.
   */
  getTimingContextClipIds(range: TimelinePresentationRange): string[];
  projectRegionToLocalTimeline(
    range: TimelinePresentationRange,
    clipIds: readonly string[],
  ): ProjectedTimelineRegion;
}

export interface CreateTimelinePlacementMapperOptions {
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineClip[];
  fps: number;
}

function cropClipToStoredOffsets(
  clip: TimelineClip,
  startOffset: number,
  endOffset: number,
): TimelineClip | null {
  const boundedStart = Math.max(0, Math.min(clip.timelineDuration, startOffset));
  const boundedEnd = Math.max(0, Math.min(clip.timelineDuration, endOffset));
  if (boundedStart >= boundedEnd) return null;

  const cropped = structuredClone(clip);
  if (boundedStart > 0) {
    Object.assign(cropped, getResizedClipLeft(cropped, boundedStart));
  }

  const targetDuration = boundedEnd - boundedStart;
  if (targetDuration < cropped.timelineDuration) {
    Object.assign(
      cropped,
      getResizedClipRight(
        cropped,
        targetDuration - cropped.timelineDuration,
      ),
    );
  }

  if (cropped.type === "adjustment") {
    cropped.sourceDuration = cropped.croppedSourceDuration;
  }
  return cropped;
}

function resolveMaskParentId(clip: TimelineClip): string | null {
  if (clip.type !== "mask") return null;
  return (clip as MaskTimelineClip).parentClipId ?? null;
}

/**
 * Pins all stored/presentation mappings to one immutable timeline snapshot.
 * Callers can safely perform a multi-step mutation from its projections
 * without later steps observing partially edited adjustment topology.
 */
export function createTimelinePlacementMapper({
  tracks,
  clips,
  fps,
}: CreateTimelinePlacementMapperOptions): TimelinePlacementMapper {
  const snapshotTracks = structuredClone(tracks) as TimelineTrack[];
  const snapshotClips = structuredClone(clips) as TimelineClip[];
  const clipsById = new Map(
    snapshotClips.map((clip) => [clip.id, clip] as const),
  );
  const presentationById = buildTimelineClipPresentationIndex(
    snapshotTracks,
    snapshotClips,
    fps,
  );

  const resolvePresentation = (
    clip: TimelineClip,
  ): TimelineClipPresentation | undefined => {
    if (clip.type !== "mask") return presentationById.get(clip.id);
    const parentId = resolveMaskParentId(clip);
    return parentId ? presentationById.get(parentId) : undefined;
  };

  const getPresentationFootprint = (
    clipId: string,
  ): TimelinePresentationRange | null => {
    const clip = clipsById.get(clipId);
    if (!clip) return null;
    const presentation = resolvePresentation(clip);
    return presentation
      ? timelinePresentationRange(presentation.start, presentation.end)
      : timelinePresentationRange(
          clip.start,
          clip.start + clip.timelineDuration,
        );
  };

  const mapPresentationTickToStoredTick = (
    clipId: string,
    targetPresentationTick: PresentationTick,
  ): StoredTrackTick | null => {
    const clip = clipsById.get(clipId);
    if (!clip) return null;
    const presentation = resolvePresentation(clip);
    if (!presentation) {
      return storedTrackTick(
        clip.start + (timelineTimeValue(targetPresentationTick) - clip.start),
      );
    }
    return storedTrackTick(
      clip.start +
      presentation.mapPresentationOffsetToClipOffset(
        timelineTimeValue(targetPresentationTick) - presentation.start,
      ),
    );
  };

  const mapStoredTickToPresentationTick = (
    clipId: string,
    targetStoredTick: StoredTrackTick,
  ): PresentationTick | null => {
    const clip = clipsById.get(clipId);
    if (!clip) return null;
    const presentation = resolvePresentation(clip);
    if (!presentation) return presentationTick(targetStoredTick);
    return presentationTick(
      presentation.start +
      presentation.mapClipOffsetToPresentationOffset(
        timelineTimeValue(targetStoredTick) - clip.start,
      ),
    );
  };

  const intersectClipWithPresentationRange = (
    clipId: string,
    range: TimelinePresentationRange,
  ): ProjectedTimelineClipSegment | null => {
    const clip = clipsById.get(clipId);
    const footprint = getPresentationFootprint(clipId);
    if (!clip || !footprint || range.end <= range.start) return null;

    const presentationStart = Math.max(footprint.start, range.start);
    const presentationEnd = Math.min(footprint.end, range.end);
    if (presentationStart >= presentationEnd) return null;

    const mappedStart = mapPresentationTickToStoredTick(
      clipId,
      presentationTick(presentationStart),
    );
    const mappedEnd = mapPresentationTickToStoredTick(
      clipId,
      presentationTick(presentationEnd),
    );
    if (mappedStart === null || mappedEnd === null) return null;

    const storedStart = Math.max(
      clip.start,
      Math.min(clip.start + clip.timelineDuration, Math.round(mappedStart)),
    );
    const storedEnd = Math.max(
      clip.start,
      Math.min(clip.start + clip.timelineDuration, Math.round(mappedEnd)),
    );
    if (storedStart >= storedEnd) return null;

    return {
      clipId,
      presentationStart: presentationTick(presentationStart),
      presentationEnd: presentationTick(presentationEnd),
      storedStart: storedTrackTick(storedStart),
      storedEnd: storedTrackTick(storedEnd),
      storedStartOffset: clipOffsetTick(storedStart - clip.start),
      storedEndOffset: clipOffsetTick(storedEnd - clip.start),
      localPresentationStart: presentationTick(
        presentationStart - timelineTimeValue(range.start),
      ),
    };
  };

  const getClipIdsInPresentationRange = (
    range: TimelinePresentationRange,
  ): string[] => {
    const selectedParentIds = new Set(
      snapshotClips
        .filter(
          (clip) =>
            clip.type !== "mask" &&
            intersectClipWithPresentationRange(clip.id, range) !== null,
        )
        .map((clip) => clip.id),
    );
    return snapshotClips
      .filter((clip) => {
        if (selectedParentIds.has(clip.id)) return true;
        const parentId = resolveMaskParentId(clip);
        return parentId !== null && selectedParentIds.has(parentId);
      })
      .map((clip) => clip.id);
  };

  const getTimingContextClipIds = (
    range: TimelinePresentationRange,
  ): string[] => {
    const timingParentIds = new Set(
      snapshotClips
        .filter((clip) => {
          if (clip.type !== "adjustment") return false;
          if (!hasEnabledSpeedTransform(clip.transformations)) return false;
          const footprint = getPresentationFootprint(clip.id);
          return footprint !== null && footprint.start < range.end;
        })
        .map((clip) => clip.id),
    );
    return snapshotClips
      .filter((clip) => {
        if (timingParentIds.has(clip.id)) return true;
        const parentId = resolveMaskParentId(clip);
        return parentId !== null && timingParentIds.has(parentId);
      })
      .map((clip) => clip.id);
  };

  const getRegionTopologyClipIds = (
    range: TimelinePresentationRange,
  ): string[] => {
    const topologyIds = new Set([
      ...getClipIdsInPresentationRange(range),
      ...getTimingContextClipIds(range),
    ]);
    return snapshotClips
      .filter((clip) => topologyIds.has(clip.id))
      .map((clip) => clip.id);
  };

  const getClipIdsAtPresentationTick = (
    targetPresentationTick: PresentationTick,
  ): string[] => {
    const selectedParentIds = new Set(
      snapshotClips
        .filter((clip) => {
          if (clip.type === "mask") return false;
          const footprint = getPresentationFootprint(clip.id);
          return (
            footprint !== null &&
            footprint.start <= targetPresentationTick &&
            targetPresentationTick < footprint.end
          );
        })
        .map((clip) => clip.id),
    );
    return snapshotClips
      .filter((clip) => {
        if (selectedParentIds.has(clip.id)) return true;
        const parentId = resolveMaskParentId(clip);
        return parentId !== null && selectedParentIds.has(parentId);
      })
      .map((clip) => clip.id);
  };

  const projectRegionToLocalTimeline = (
    range: TimelinePresentationRange,
    clipIds: readonly string[],
  ): ProjectedTimelineRegion => {
    const selectedIds = new Set(clipIds);
    const segmentsByClipId = new Map<string, ProjectedTimelineClipSegment>();
    const projectedClips = snapshotClips.flatMap((clip) => {
      if (!selectedIds.has(clip.id)) return [];
      const segment = intersectClipWithPresentationRange(clip.id, range);
      if (!segment) return [];
      const projected = cropClipToStoredOffsets(
        clip,
        segment.storedStartOffset,
        segment.storedEndOffset,
      );
      if (!projected) return [];
      segmentsByClipId.set(clip.id, segment);
      return [projected];
    });

    const trackPositionById = new Map(
      snapshotTracks.map((track, index) => [track.id, index] as const),
    );
    const adjustments = projectedClips
      .filter((clip) => clip.type === "adjustment")
      .sort(
        (left, right) =>
          (trackPositionById.get(left.trackId) ?? Number.MAX_SAFE_INTEGER) -
          (trackPositionById.get(right.trackId) ?? Number.MAX_SAFE_INTEGER),
      );
    const positionClip = (clip: TimelineClip): void => {
      const segment = segmentsByClipId.get(clip.id);
      if (!segment) return;
      clip.start = resolveStoredStartForPresentationStart(
        snapshotTracks,
        projectedClips,
        clip.trackId,
        segment.localPresentationStart,
      );
    };
    adjustments.forEach(positionClip);
    projectedClips
      .filter((clip) => clip.type !== "adjustment" && clip.type !== "mask")
      .forEach(positionClip);

    const projectedById = new Map(
      projectedClips.map((clip) => [clip.id, clip] as const),
    );
    projectedClips.forEach((clip) => {
      const parentId = resolveMaskParentId(clip);
      if (!parentId) return;
      const parent = projectedById.get(parentId);
      if (parent) clip.start = parent.start;
    });

    return {
      range: { ...range },
      clips: projectedClips,
      segmentsByClipId,
    };
  };

  return {
    getPresentationFootprint,
    mapPresentationTickToStoredTick,
    mapStoredTickToPresentationTick,
    resolveStoredStart(trackId, targetPresentationStart) {
      return storedTrackTick(resolveStoredStartForPresentationStart(
        snapshotTracks,
        snapshotClips,
        trackId,
        targetPresentationStart,
      ));
    },
    intersectClipWithPresentationRange,
    getClipIdsAtPresentationTick,
    getClipIdsInPresentationRange,
    getRegionTopologyClipIds,
    getTimingContextClipIds,
    projectRegionToLocalTimeline,
  };
}

export interface CollectTimelineRegionClipsOptions
  extends CreateTimelinePlacementMapperOptions {
  start: number;
  /** Omitted for a single-frame (point) region at `start`. */
  end?: number;
}

/**
 * The clips a `TimelineSelection` over a presentation range must capture: its
 * render topology (see `getRegionTopologyClipIds`), in snapshot order and by
 * reference. Every selection builder goes through this, so a selection always
 * renders the same frames the timeline shows for its range.
 */
export function collectTimelineRegionClips({
  tracks,
  clips,
  fps,
  start,
  end,
}: CollectTimelineRegionClipsOptions): TimelineClip[] {
  const mapper = createTimelinePlacementMapper({ tracks, clips, fps });
  const topologyIds = new Set(
    mapper.getRegionTopologyClipIds(
      timelinePresentationRange(start, end ?? start + 1),
    ),
  );
  return clips.filter((clip) => topologyIds.has(clip.id));
}
