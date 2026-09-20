import type { TimelineClip } from "../../../types/TimelineTypes";
import { getTimelineTime, type TimelineTime, type TimelineTimeSnapshot } from "./timelineTime";
import { presentationTick, sourceTick } from "../utils/timelineTimeDomains";

export type ClipPresentationContext = TimelineTimeSnapshot;

/** Compatibility boundary for detached authoring snapshots. */
export function presentationToClipSourceTime(ctx: ClipPresentationContext | TimelineTime, clip: TimelineClip, tick: number): number {
  const source = resolveTime(ctx).sourceAt(clip.id, presentationTick(tick));
  if (source === null) throw new Error(`Clip ${clip.id} is missing from the timing snapshot`);
  return source;
}

export function clipSourceTimeToPresentation(ctx: ClipPresentationContext | TimelineTime, clip: TimelineClip, tick: number): number {
  const presentation = resolveTime(ctx).presentationOf(clip.id, sourceTick(tick));
  if (presentation === null) throw new Error(`Clip ${clip.id} is missing from the timing snapshot`);
  return presentation;
}

export function clipPresentationFootprint(ctx: ClipPresentationContext | TimelineTime, clip: TimelineClip) {
  const range = resolveTime(ctx).footprint(clip.id);
  if (!range) throw new Error(`Clip ${clip.id} is missing from the timing snapshot`);
  return range;
}

/** Clamp in presentation time before converting to source-owned authoring time. */
export function clampedClipSourceTime(ctx: ClipPresentationContext | TimelineTime, clip: TimelineClip, tick: number): number {
  const time = resolveTime(ctx);
  const clamped = time.clampToFootprint(clip.id, tick);
  const source = clamped === null ? null : time.sourceAt(clip.id, clamped);
  if (source === null) throw new Error(`Clip ${clip.id} is missing from the timing snapshot`);
  return source;
}

export function clampedClipVisualTime(ctx: ClipPresentationContext | TimelineTime, clip: TimelineClip, tick: number): number {
  const time = resolveTime(ctx);
  const clamped = time.clampToFootprint(clip.id, tick);
  const stored = clamped === null ? null : time.toStored(clip.id, clamped);
  if (stored === null) throw new Error(`Clip ${clip.id} is missing from the timing snapshot`);
  return stored - clip.start;
}

function resolveTime(context: ClipPresentationContext | TimelineTime): TimelineTime {
  return "renderLookup" in context ? context : getTimelineTime(context);
}
