import { collectTemporalRenderingRequirements } from "../../transformations/catalogue/temporalRenderingRequirements";
import { mediaSecondsToTickExact } from "../../../core/time/mediaTime";
import type { LegacyTimelineSelection, TimelineSelection, TimelineTrack, TimelineRegionData } from "../../../types/TimelineTypes";
import { ticksPerFrame } from "../../../core/time/frameGrid";
import { getTimelineTime, type TimelineTimeSnapshot } from "./timelineTime";
import { presentationTick } from "../utils/timelineTimeDomains";
import { timelinePresentationRange } from "./timelinePlacementMapper";

export function inferSelectionTracks(selection: LegacyTimelineSelection): TimelineTrack[] {
  if (selection.tracks) return selection.tracks;
  const ids = [...new Set(selection.clips.map((clip) => clip.trackId))];
  return ids.map((id) => ({
    id, label: "Saved selection", isVisible: true, isMuted: false, isLocked: false,
    type: selection.clips.some((clip) => clip.trackId === id && clip.type === "adjustment") ? "adjustment" :
      selection.clips.some((clip) => clip.trackId === id && clip.type === "audio") ? "audio" : selection.clips.every((clip) => clip.trackId !== id || clip.type === "mask") ? "mask" : "visual",
  }));
}

/** Capture against the full source snapshot; only the projected region is persisted. */
export function projectTimelineSelection(
  selection: LegacyTimelineSelection,
  snapshot: TimelineTimeSnapshot,
): TimelineSelection {
  // Callers may pass a v2 object alongside legacy capture fields. Geometry and
  // point intent must be derived afresh rather than leaking through the spread.
  const { start, end, clips, tracks: _tracks, transitions, ...rest } = selection;
  const hints = { ...rest } as Record<string, unknown>;
  for (const key of ["version", "anchor", "durationTicks", "region", "isPoint", "gridFps"]) delete hints[key];
  const time = getTimelineTime(snapshot);
  const stop = end ?? start + ticksPerFrame(snapshot.fps);
  const ids = new Set(clips.map((clip) => clip.id));
  // Include adjustment context for projection even when the caller selected ids.
  for (const id of time.getTimingContextClipIds(timelinePresentationRange(start, stop))) ids.add(id);
  // A detached timeline also owns the frames history effects need before its
  // first output sample. Keep that bounded pre-roll at negative local ticks.
  const history = collectTemporalRenderingRequirements(snapshot.clips.filter((clip) => ids.has(clip.id)).map((clip) => clip.transformations ?? [])).maxHistorySeconds;
  const earliest = snapshot.clips.reduce((tick, clip) => Math.min(tick, time.footprint(clip.id)?.start ?? tick), start);
  const projectionStart = Math.max(earliest, start - Math.ceil(mediaSecondsToTickExact(history)));
  const projected = time.projectRegion(timelinePresentationRange(projectionStart, stop), [...ids], presentationTick(start));
  const projectedIds = new Set(projected.clips.map((clip) => clip.id));
  const regionTransitions = transitions?.filter((transition) =>
    projectedIds.has(transition.outgoingClipId) && projectedIds.has(transition.incomingClipId));
  return {
    ...structuredClone(hints),
    version: 2,
    anchor: presentationTick(start),
    durationTicks: Math.max(0, stop - start),
    ...(end === undefined ? { isPoint: true as const } : {}),
    region: {
      clips: projected.clips,
      tracks: structuredClone(snapshot.tracks) as TimelineTrack[],
      ...(regionTransitions?.length ? { transitions: structuredClone(regionTransitions) } : {}),
      gridFps: snapshot.fps,
      ...(selection.fps ? { fps: selection.fps } : {}),
    },
  };
}

/** Dual-read, single-write: legacy replay uses only its own saved topology. */
export function convertLegacyTimelineSelection(
  selection: TimelineSelection | LegacyTimelineSelection,
  fallbackFps = 30,
): TimelineSelection {
  if ("version" in selection && selection.version === 2) return selection;
  const legacy = selection as LegacyTimelineSelection;
  const snapshot = {
    tracks: inferSelectionTracks(legacy), clips: legacy.clips,
    fps: legacy.gridFps ?? fallbackFps,
  };
  // Old exports without an end ran to the furthest visible clip. Preserve that
  // replay window, while retaining point intent for frame/provenance consumers.
  const time = getTimelineTime(snapshot);
  const end = legacy.end ?? legacy.clips.reduce((end, clip) =>
    Math.max(end, time.footprint(clip.id)?.end ?? clip.start + clip.timelineDuration), legacy.start);
  const projected = projectTimelineSelection({ ...legacy, end }, snapshot);
  return legacy.end === undefined ? { ...projected, isPoint: true } : projected;
}

/** Geometry changes stay in the same boundary as selection construction. */
export function updateTimelineSelection(
  selection: TimelineSelection,
  update: { anchor?: TimelineSelection["anchor"]; region?: TimelineSelection["region"] },
): TimelineSelection {
  return { ...selection, ...update };
}

/** Wrap an already-local region without projecting or quantizing it again. */
export function timelineSelectionFromRegion(region: TimelineRegionData, durationTicks: number): TimelineSelection {
  return {
    version: 2,
    anchor: presentationTick(0),
    durationTicks,
    region: structuredClone(region),
    ...(region.fps ? { fps: region.fps } : {}),
    ...(region.frameStep ? { frameStep: region.frameStep } : {}),
    ...(region.frameOffset ? { frameOffset: region.frameOffset } : {}),
    ...(region.includedTrackIds ? { includedTrackIds: region.includedTrackIds.slice() } : {}),
  };
}
