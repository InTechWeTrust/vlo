import { mediaSecondsToTick } from "../../../core/time";
import { frameIndexFromTick, tickFromFrameIndex } from "../../../core/time/frameGrid";

export type RangeEditEdge = "start" | "end" | "move";

/** Work in frame indices so clamping cannot push a snapped edge off its grid. */
export function normalizeRangeBounds(
  startTicks: number,
  endTicks: number,
  durationTicks: number,
  frameTicks: number | null,
  edge?: RangeEditEdge,
): { startSourceTicks: number; endSourceTicks: number } | null {
  const toUnit = (tick: number) =>
    frameTicks ? frameIndexFromTick(tick, frameTicks) : tick;
  const fromUnit = (unit: number) =>
    frameTicks ? tickFromFrameIndex(unit, frameTicks) : unit;
  const max = frameTicks
    ? frameIndexFromTick(durationTicks, frameTicks, "floor")
    : durationTicks;
  const minSpan = frameTicks ? 1 : Math.min(mediaSecondsToTick(0.1), max);
  if (max <= 0) return null;
  const clamp = (value: number, min: number, limit: number) =>
    Math.max(min, Math.min(limit, value));

  let start = toUnit(startTicks);
  let end = toUnit(endTicks);
  if (edge === "move") {
    const span = clamp(toUnit(endTicks - startTicks), minSpan, max);
    start = clamp(start, 0, max - span);
    end = start + span;
  } else if (edge === "start") {
    end = clamp(end, minSpan, max);
    start = clamp(start, 0, end - minSpan);
  } else {
    start = clamp(start, 0, max - minSpan);
    end = clamp(end, start + minSpan, max);
  }
  return { startSourceTicks: fromUnit(start), endSourceTicks: fromUnit(end) };
}
