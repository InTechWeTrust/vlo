import type { TimelineClip } from "../../../types/TimelineTypes";
import { calculateClipTime, mapSourceTimeToVisualTime } from "../../transformations/utils/timeCalculation";
import { buildTimelineClipPresentationLookup, type TimelineClipPresentationLookup } from "./clipPresentation";
import {
  createTimelinePlacementMapper,
  type CreateTimelinePlacementMapperOptions,
  type TimelinePresentationRange,
  type TimelinePlacementMapper,
  type ProjectedTimelineRegion,
} from "./timelinePlacementMapper";
import { presentationTick, sourceTick, storedTrackTick, timelineTimeValue, type PresentationTick, type SourceTick } from "../utils/timelineTimeDomains";

export type TimelineTimeSnapshot = CreateTimelinePlacementMapperOptions;
export type PresentationRange = TimelinePresentationRange;
export interface TimelineTimeQueryOptions {
  includeMaskChildren?: boolean;
  trackIds?: readonly string[];
}

export interface TimelineTime extends TimelinePlacementMapper {
  footprint: TimelinePlacementMapper["getPresentationFootprint"];
  toStored: TimelinePlacementMapper["mapPresentationTickToStoredTick"];
  toPresentation: TimelinePlacementMapper["mapStoredTickToPresentationTick"];
  clipsAt(tick: PresentationTick, options?: TimelineTimeQueryOptions): TimelineClip[];
  clipsIn(range: PresentationRange, options?: TimelineTimeQueryOptions): TimelineClip[];
  sourceAt(clipId: string, tick: PresentationTick): SourceTick | null;
  presentationOf(clipId: string, source: SourceTick): PresentationTick | null;
  clampToFootprint(clipId: string, tick: number): PresentationTick | null;
  regionTopology(range: PresentationRange): TimelineClip[];
  projectRegion(range: PresentationRange, clipIds?: readonly string[], origin?: PresentationTick): ProjectedTimelineRegion;
  renderLookup(): TimelineClipPresentationLookup;
  snapshot(): TimelineTime;
}

function createTimelineTime(snapshot: TimelineTimeSnapshot): TimelineTime {
  const { tracks, clips, fps } = snapshot;
  const lookup = buildTimelineClipPresentationLookup(tracks, clips, fps);
  const mapper = createTimelinePlacementMapper(snapshot, lookup);
  const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  const select = (ids: readonly string[], options: TimelineTimeQueryOptions = {}) => {
    const selected = new Set(ids);
    return clips.filter((clip) => selected.has(clip.id) &&
      (options.includeMaskChildren !== false || clip.type !== "mask") &&
      (!options.trackIds || options.trackIds.includes(clip.trackId)));
  };
  return {
    ...mapper,
    footprint: mapper.getPresentationFootprint,
    toStored: mapper.mapPresentationTickToStoredTick,
    toPresentation: mapper.mapStoredTickToPresentationTick,
    clipsAt(tick: PresentationTick, options?: TimelineTimeQueryOptions): TimelineClip[] {
      return select(mapper.getClipIdsAtPresentationTick(tick), options);
    },
    clipsIn(range: PresentationRange, options?: TimelineTimeQueryOptions): TimelineClip[] {
      return select(mapper.getClipIdsInPresentationRange(range), options);
    },
    sourceAt(clipId: string, tick: PresentationTick): SourceTick | null {
      const clip = clipsById.get(clipId);
      const stored = mapper.mapPresentationTickToStoredTick(clipId, tick);
      return clip && stored !== null
        ? sourceTick(calculateClipTime(clip, timelineTimeValue(stored) - clip.start, true))
        : null;
    },
    presentationOf(clipId: string, source: SourceTick): PresentationTick | null {
      const clip = clipsById.get(clipId);
      return clip ? mapper.mapStoredTickToPresentationTick(clipId,
        storedTrackTick(clip.start + mapSourceTimeToVisualTime(clip, source))) : null;
    },
    clampToFootprint(clipId: string, tick: number): PresentationTick | null {
      const range = mapper.getPresentationFootprint(clipId);
      return range ? presentationTick(Math.max(range.start, Math.min(range.end, tick))) : null;
    },
    regionTopology(range: PresentationRange): TimelineClip[] {
      return select(mapper.getRegionTopologyClipIds(range));
    },
    projectRegion(range: PresentationRange, clipIds?: readonly string[], origin?: PresentationTick) {
      return mapper.projectRegionToLocalTimeline(range, clipIds ?? mapper.getRegionTopologyClipIds(range), origin);
    },
    renderLookup: () => lookup,
    /** Isolate a multi-step mutation of an otherwise mutable draft. */
    snapshot(): TimelineTime {
      return createTimelineTimeSnapshot(snapshot);
    },
  };
}



/** Make an isolated clock from the current contents of a mutable draft, bypassing the cache. */
export function createTimelineTimeSnapshot(snapshot: TimelineTimeSnapshot): TimelineTime {
  return createTimelineTime(structuredClone(snapshot));
}

// One bounded identity cache, shared by UI, authoring and render snapshots.
let cached: { snapshot: TimelineTimeSnapshot; time: TimelineTime } | undefined;
/**
 * Read an immutable state snapshot. Replace clips/tracks arrays when their contents
 * change. Mutable transactions must use createTimelinePlacementMapper (an isolated
 * snapshot) rather than reusing this identity-cached view after in-place edits.
 */
export function getTimelineTime(snapshot: TimelineTimeSnapshot): TimelineTime {
  if (!cached || cached.snapshot.tracks !== snapshot.tracks ||
      cached.snapshot.clips !== snapshot.clips || cached.snapshot.fps !== snapshot.fps) {
    cached = { snapshot: { ...snapshot }, time: createTimelineTime(snapshot) };
  }
  return cached.time;
}
