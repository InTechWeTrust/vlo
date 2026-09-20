import { calculateClipTime, mapSourceTimeToVisualTime } from "../../transformations/utils/timeCalculation";
import type { TimelineClip } from "../../../types/TimelineTypes";
import { getTimelineTime, type TimelineTime, type TimelineTimeSnapshot } from "./timelineTime";
import { presentationTick, sourceTick } from "../utils/timelineTimeDomains";

export type ClipPresentationContext = TimelineTimeSnapshot;

/** Compatibility boundary for detached authoring snapshots. */
export function presentationToClipSourceTime(ctx: ClipPresentationContext | TimelineTime, clip: TimelineClip, tick: number): number {
  const source = resolveTime(ctx).sourceAt(clip.id, presentationTick(tick));
  return source ?? calculateClipTime(clip, tick - clip.start, true);
}

export function clipSourceTimeToPresentation(ctx: ClipPresentationContext | TimelineTime, clip: TimelineClip, tick: number): number {
  const presentation = resolveTime(ctx).presentationOf(clip.id, sourceTick(tick));
  return presentation ?? clip.start + mapSourceTimeToVisualTime(clip, tick);
}

export function clipPresentationFootprint(ctx: ClipPresentationContext | TimelineTime, clip: TimelineClip) {
  const range = resolveTime(ctx).footprint(clip.id);
  return range ?? { start: presentationTick(clip.start), end: presentationTick(clip.start + clip.timelineDuration) };
}

/** Clamp in presentation time before converting to source-owned authoring time. */
export function clampedClipSourceTime(ctx: ClipPresentationContext | TimelineTime, clip: TimelineClip, tick: number): number {
  const time = resolveTime(ctx);
  const clamped = time.clampToFootprint(clip.id, tick);
  const source = clamped === null ? null : time.sourceAt(clip.id, clamped);
  return source ?? calculateClipTime(clip, Math.max(0, Math.min(clip.timelineDuration, tick - clip.start)), true);
}

export function clampedClipVisualTime(ctx: ClipPresentationContext | TimelineTime, clip: TimelineClip, tick: number): number {
  const time = resolveTime(ctx);
  const clamped = time.clampToFootprint(clip.id, tick);
  const stored = clamped === null ? null : time.toStored(clip.id, clamped);
  return stored === null
    ? Math.max(0, Math.min(clip.timelineDuration, tick - clip.start))
    : stored - clip.start;
}

function resolveTime(context: ClipPresentationContext | TimelineTime): TimelineTime {
  return "renderLookup" in context ? context : getTimelineTime(context);
}
