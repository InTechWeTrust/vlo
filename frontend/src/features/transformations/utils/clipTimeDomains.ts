import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import {
  resolveClipEffectiveTrackTick,
  resolveClipPresentation,
} from "../../timeline/utils/clipPresentation";
import {
  calculateClipTime,
  mapSourceTimeToVisualTime,
} from "./timeCalculation";

/**
 * Clip time-domain boundary.
 *
 * Everything here is expressed in project ticks. "Source time" means
 * source-media time encoded in the project tick unit (`sourceTimeTicks`), not a
 * native asset/frame unit.
 *
 * Keyframe times are stored in source-media time, independent of where any speed
 * transform sits in the stack. Speed is treated as a visual<->source clock remap:
 * it changes when source content is presented, never what values belong to that
 * source content.
 *
 * Low-level V<->S math lives in `timeCalculation`; feature code should prefer
 * this boundary so source-time, clip-local visual time, presentation time, and
 * adjustment-effective time are named at the call site.
 */

export interface ClipPresentationContext {
  tracks: readonly TimelineTrack[];
  clips: readonly TimelineClip[];
  fps: number;
}

/**
 * Convert a clip-local visual tick (e.g. the playhead, relative to the clip's
 * visual start) to source-media time in project ticks. Pulls through the clip's
 * full speed stack.
 */
export function clipVisualToSourceTime(
  clip: TimelineClip,
  clipLocalVisualTicks: number,
): number {
  return calculateClipTime(clip, clipLocalVisualTicks, true);
}

/**
 * Inverse of {@link clipVisualToSourceTime}: map stored source-media time back
 * to clip-local visual time. Pushes through the clip's full speed stack.
 */
export function clipSourceTimeToVisual(
  clip: TimelineClip,
  sourceTimeTicks: number,
): number {
  return mapSourceTimeToVisualTime(clip, sourceTimeTicks);
}

/**
 * The source-time window a clip's keyframes live in. Doubles as the spline
 * editor's data domain (linear, source-native), over which endpoint-locking and
 * clamping operate.
 */
export function clipSourceTimeWindow(clip: TimelineClip): {
  minTime: number;
  duration: number;
} {
  return {
    minTime: clip.offset,
    duration: Math.max(0, clip.croppedSourceDuration || 0),
  };
}

/**
 * Resolve the source-media time currently displayed for `clip` at a global
 * presentation/playhead tick.
 *
 * Chain:
 * presentationTick -> effectiveTrackTick (adjustment retiming)
 * effectiveTrackTick - clip.start -> clip-local visual ticks
 * clip-local visual ticks -> sourceTimeTicks (clip speed/crop)
 *
 * `presentationTick` is a global timeline tick, not a clip offset and not an
 * already-rebased effective tick.
 */
export function presentationToClipSourceTime(
  ctx: ClipPresentationContext,
  clip: TimelineClip,
  presentationTick: number,
): number {
  const effectiveTrackTick = resolveClipEffectiveTrackTick(
    ctx.tracks,
    ctx.clips,
    ctx.fps,
    clip,
    presentationTick,
  );
  return clipVisualToSourceTime(clip, effectiveTrackTick - clip.start);
}

/**
 * Inverse of {@link presentationToClipSourceTime}: the global presentation tick
 * at which `clip` shows `sourceTimeTicks`. Use it to seed presentation-time UI
 * (the selection overlay, markers) from source-owned data such as range masks
 * — `clip.start + clipSourceTimeToVisual(...)` is a *stored* tick, which
 * adjustment retiming can move away from where the clip is drawn.
 */
export function clipSourceTimeToPresentation(
  ctx: ClipPresentationContext,
  clip: TimelineClip,
  sourceTimeTicks: number,
): number {
  const clipOffset = clipSourceTimeToVisual(clip, sourceTimeTicks);
  const presentation = resolveClipPresentation(
    ctx.tracks,
    ctx.clips,
    ctx.fps,
    clip,
  );
  return presentation
    ? presentation.start + presentation.mapClipOffsetToPresentationOffset(clipOffset)
    : clip.start + clipOffset;
}

/**
 * Where `clip` is drawn and rendered, in global presentation ticks: the
 * frame-quantized footprint the timeline, selection and renderer all share.
 * Compare presentation-time ranges (selections, the playhead) against this,
 * never against `clip.start`/`clip.timelineDuration`, which are stored ticks.
 */
export function clipPresentationFootprint(
  ctx: ClipPresentationContext,
  clip: TimelineClip,
): { start: number; end: number } {
  const presentation = resolveClipPresentation(
    ctx.tracks,
    ctx.clips,
    ctx.fps,
    clip,
  );
  return presentation
    ? { start: presentation.start, end: presentation.end }
    : { start: clip.start, end: clip.start + clip.timelineDuration };
}

/**
 * A spline-editor X axis. The graph keeps its point data in source-media time
 * (`sourceMin`..`sourceMin + sourceDuration`, encoded in project ticks) and
 * maps to/from a normalized `[0, 1]` screen position through `sourceToNorm` /
 * `normToSource`. The mapping is linear when there is no speed (or a single
 * constant factor) and curves under a speed ramp. That curvature is the warped
 * axis we want, applied as a rendering transform without moving stored times.
 */
export interface GraphTimeAxis {
  sourceMin: number;
  sourceDuration: number;
  /** sourceTimeTicks -> normalized [0, 1] position along the warped axis. */
  sourceToNorm(sourceTimeTicks: number): number;
  /** Normalized [0, 1] position -> sourceTimeTicks. */
  normToSource(norm: number): number;
}

/**
 * Build the warped axis for a *value* transform on `clip`, using the clip's OWN
 * speed stack only (adjustment-layer speed is intentionally excluded — the panel
 * shows the clip-local domain). The speed transform's own factor graph must NOT
 * use this (it would self-warp); give it {@link buildLinearGraphTimeAxis}.
 */
export function buildClipGraphTimeAxis(clip: TimelineClip): GraphTimeAxis {
  const { minTime: sourceMin, duration: sourceDuration } =
    clipSourceTimeWindow(clip);
  const sourceMax = sourceMin + sourceDuration;

  // Visual (clip-local) bounds of the source window. `visSpan` guards against a
  // zero-length window collapsing the normalization.
  const visMin = mapSourceTimeToVisualTime(clip, sourceMin);
  const visMax = mapSourceTimeToVisualTime(clip, sourceMax);
  const visSpan = visMax - visMin || 1;

  return {
    sourceMin,
    sourceDuration,
    sourceToNorm: (sourceTimeTicks) =>
      (mapSourceTimeToVisualTime(clip, sourceTimeTicks) - visMin) / visSpan,
    normToSource: (norm) =>
      calculateClipTime(clip, visMin + norm * visSpan, true),
  };
}

/**
 * Linear, un-warped axis over a source window. Used for the speed factor graph
 * (authored in source time) and as the backtrack/fallback path.
 */
export function buildLinearGraphTimeAxis(
  minTime: number,
  duration: number,
): GraphTimeAxis {
  const span = duration || 1;
  return {
    sourceMin: minTime,
    sourceDuration: duration,
    sourceToNorm: (t) => (t - minTime) / span,
    normToSource: (norm) => minTime + norm * span,
  };
}
