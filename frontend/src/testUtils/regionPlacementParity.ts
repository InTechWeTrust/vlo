import type { TimelineClip, TimelineTrack } from "../types/TimelineTypes";
import {
  createTimelinePlacementMapper,
  presentationTick,
  timelineTimeValue,
  type TimelinePlacementMapper,
} from "../features/timeline";
import { clipVisualToSourceTime } from "../features/transformations";

export interface RegionPlacementContext {
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineClip[];
  /** Project fps: presentation quantizes on the project grid. */
  fps: number;
}

export interface CapturedRegion {
  clips: readonly TimelineClip[];
  tracks: readonly TimelineTrack[];
  /**
   * Context tick that is the region's tick 0: 0 for an absolute-time
   * `TimelineSelection`, the selection start for composite-local content.
   */
  origin: number;
}

export interface RegionPlacementParityOptions {
  /** Presentation range of the capture, in context ticks. */
  range: { start: number; end: number };
  /**
   * Also require every visual clip the context shows in `range` to be in the
   * region. Off for builders that deliberately pick their own clips (by id).
   */
  requireAllInRange?: boolean;
}

type Span = { start: number; end: number };

function footprint(mapper: TimelinePlacementMapper, clipId: string): Span | null {
  const range = mapper.getPresentationFootprint(clipId);
  return range
    ? { start: timelineTimeValue(range.start), end: timelineTimeValue(range.end) }
    : null;
}

function overlap(span: Span | null, range: Span): Span | null {
  if (!span) return null;
  const start = Math.max(span.start, range.start);
  const end = Math.min(span.end, range.end);
  return start < end ? { start, end } : null;
}

function sourceTimeAt(
  mapper: TimelinePlacementMapper,
  clip: TimelineClip,
  tick: number,
): number | null {
  const stored = mapper.mapPresentationTickToStoredTick(
    clip.id,
    presentationTick(tick),
  );
  if (stored === null) return null;
  return clipVisualToSourceTime(clip, timelineTimeValue(stored) - clip.start);
}

const shift = (span: Span | null, by: number): Span | null =>
  span ? { start: span.start + by, end: span.end + by } : null;

/**
 * The selection invariant, for contract tests: a captured region renders
 * detached, from its own clips and tracks, so within the captured range every
 * clip it carries must be shown over the same span and show the same source
 * content as in the timeline it was captured from. Returns one message per
 * violation (empty when the capture is faithful).
 *
 * Clips are matched to the context by id; region clips may be cropped and
 * moved to local time (composite content), which is why the comparison is on
 * presentation spans and source time rather than stored fields.
 */
export function findRegionPlacementDrift(
  region: CapturedRegion,
  context: RegionPlacementContext,
  { range, requireAllInRange = false }: RegionPlacementParityOptions,
): string[] {
  const attached = createTimelinePlacementMapper(context);
  const detached = createTimelinePlacementMapper({
    tracks: region.tracks,
    clips: region.clips,
    fps: context.fps,
  });
  const contextById = new Map(context.clips.map((clip) => [clip.id, clip]));
  const regionIds = new Set(region.clips.map((clip) => clip.id));
  const drift: string[] = [];

  for (const clip of region.clips) {
    if (clip.type === "mask") continue;
    const contextClip = contextById.get(clip.id);
    if (!contextClip) continue;

    const shown = overlap(footprint(attached, clip.id), range);
    const rendered = overlap(shift(footprint(detached, clip.id), region.origin), range);
    if (!shown && !rendered) continue;
    if (
      !shown ||
      !rendered ||
      shown.start !== rendered.start ||
      shown.end !== rendered.end
    ) {
      drift.push(
        `${clip.id}: shown over ${JSON.stringify(shown)} in the timeline, rendered over ${JSON.stringify(rendered)}`,
      );
      continue;
    }

    // Same span can still show different source (a static adjustment over the
    // head of the clip), so compare the source time too.
    for (const fraction of [0, 0.5]) {
      const tick = shown.start + fraction * (shown.end - shown.start);
      const expected = sourceTimeAt(attached, contextClip, tick);
      const actual = sourceTimeAt(detached, clip, tick - region.origin);
      if (expected === null || actual === null || Math.abs(expected - actual) > 0.5) {
        drift.push(
          `${clip.id}: at tick ${tick} the timeline shows source ${expected}, the region renders ${actual}`,
        );
        break;
      }
    }
  }

  if (requireAllInRange) {
    for (const clip of context.clips) {
      if (clip.type === "mask" || clip.type === "adjustment") continue;
      if (regionIds.has(clip.id)) continue;
      if (overlap(footprint(attached, clip.id), range)) {
        drift.push(`${clip.id}: shown in the range but missing from the region`);
      }
    }
  }
  return drift;
}
