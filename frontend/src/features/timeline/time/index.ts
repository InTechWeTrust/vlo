export { getTimelineTime } from "./timelineTime";
export type { TimelineTime, TimelineTimeSnapshot, TimelineTimeQueryOptions, PresentationRange } from "./timelineTime";
export { getLiveTimelineTime, setLiveTimelineTimeSource } from "./liveTimelineTime";
export * from "./authoring";
export * from "../utils/timelineTimeDomains";
export { timelinePresentationRange } from "./timelinePlacementMapper";
export type { TimelinePresentationRange, TimelinePlacementMapper, ProjectedTimelineRegion, ProjectedTimelineClipSegment, CreateTimelinePlacementMapperOptions } from "./timelinePlacementMapper";
export * from "./playheadPlacement";
export {
  resolveClipOffsetForPresentationOffset,
  resolvePresentationOffsetForClipOffset,
  resolvePresentationTickForClipOffset,
  resolveStoredStartForPresentationStart,
  resolveStoredEndForPresentationEnd,
  buildTimelineClipPresentationCollisionView,
  introducesTimelineClipPresentationCollision,
  collectTimelineClipPresentationCollisions,
} from "./clipPresentation";
export type { TimelineClipPresentation, TimelineClipPresentationLookup, ProposedClipTimingChange, TimelineClipPresentationCollision } from "./clipPresentation";

import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import { getTimelineTime, createTimelineTimeSnapshot, type TimelineTimeSnapshot } from "./timelineTime";
import { timelinePresentationRange } from "./timelinePlacementMapper";

export function createTimelinePlacementMapper(snapshot: TimelineTimeSnapshot) {
  return createTimelineTimeSnapshot(snapshot);
}
export interface CollectTimelineRegionClipsOptions extends TimelineTimeSnapshot { start: number; end?: number }
export function collectTimelineRegionClips({ start, end, ...snapshot }: CollectTimelineRegionClipsOptions) {
  return getTimelineTime(snapshot).regionTopology(timelinePresentationRange(start, end ?? start + 1));
}
export function buildTimelineClipPresentationIndex(tracks: readonly TimelineTrack[], clips: readonly TimelineClip[], fps: number) {
  const lookup = getTimelineTime({ tracks, clips, fps }).renderLookup();
  return new Map(clips.flatMap((clip) => {
    const entry = lookup.getPresentation(clip.id);
    return entry ? [[clip.id, entry] as const] : [];
  }));
}
export function buildTimelineClipPresentationLookup(tracks: readonly TimelineTrack[], clips: readonly TimelineClip[], fps: number) {
  return getTimelineTime({ tracks, clips, fps }).renderLookup();
}
export function computeFurthestPresentationEnd(tracks: readonly TimelineTrack[], clips: readonly TimelineClip[], fps: number, subset: readonly TimelineClip[] = clips) {
  const time = getTimelineTime({ tracks, clips, fps });
  return Math.round(subset.reduce((end, clip) => Math.max(end, time.footprint(clip.id)?.end ?? 0), 0));
}
export function resolveClipEffectiveTrackTick(tracks: readonly TimelineTrack[], clips: readonly TimelineClip[], fps: number, clip: TimelineClip, tick: number) {
  return getTimelineTime({ tracks, clips, fps }).renderLookup().resolveEffectiveTrackTickWithinClip(clip, tick);
}
export function resolveClipPresentation(tracks: readonly TimelineTrack[], clips: readonly TimelineClip[], fps: number, clip: TimelineClip) {
  return getTimelineTime({ tracks, clips, fps }).renderLookup().getPresentation(clip.id);
}
export { projectTimelineSelection, convertLegacyTimelineSelection, inferSelectionTracks, updateTimelineSelection, timelineSelectionFromRegion } from "./selection";
