/**
 * The ordering rules a range slider enforces, kept apart from the component so
 * they can be reasoned about (and tested) without a pointer.
 *
 * Ends never swap and never cross: the low end stays at least `minDistance`
 * under the high end. A range whose two values are really separate settings
 * with a relationship between them (a sampling window: start before end) is
 * shown as one control precisely so this rule is visible instead of being an
 * error discovered at run time.
 */

export type RangeEnd = "low" | "high";

export type RangeValue = readonly [low: number, high: number];

export interface RangeEndLimits {
  min?: number;
  max?: number;
}

export interface RangeConstraints {
  min: number;
  max: number;
  /** Smallest allowed `high - low`. 0 lets the range collapse to a point. */
  minDistance?: number;
  /** Tighter bounds for one end, inside the track's own `min`/`max`. */
  low?: RangeEndLimits;
  high?: RangeEndLimits;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function endBounds(
  constraints: RangeConstraints,
  end: RangeEnd,
): [number, number] {
  const limits = constraints[end];
  const min = Math.max(constraints.min, limits?.min ?? constraints.min);
  const max = Math.min(constraints.max, limits?.max ?? constraints.max);
  return [min, Math.max(min, max)];
}

/**
 * Moves one end to `value`, as far as its own limits and the other end allow.
 * The end that is not being moved is never pushed.
 */
export function constrainRangeEnd(
  range: RangeValue,
  end: RangeEnd,
  value: number,
  constraints: RangeConstraints,
): [number, number] {
  const distance = Math.max(0, constraints.minDistance ?? 0);
  const [low, high] = range;
  const [min, max] = endBounds(constraints, end);
  const bounded = clamp(value, min, max);
  if (end === "low") {
    return [Math.min(bounded, high - distance), high];
  }
  return [low, Math.max(bounded, low + distance)];
}

/**
 * The range as the track should draw it. Values that arrive out of order —
 * from a saved state, or an underlying pair of settings that allows it —
 * render collapsed at the low end rather than with the thumbs swapped.
 */
export function normalizeRange(
  range: RangeValue,
  constraints: RangeConstraints,
): [number, number] {
  const [lowMin, lowMax] = endBounds(constraints, "low");
  const [highMin, highMax] = endBounds(constraints, "high");
  const low = clamp(range[0], lowMin, lowMax);
  const high = clamp(Math.max(range[1], low), highMin, highMax);
  return [Math.min(low, high), high];
}

export function isRangeCollapsed(range: RangeValue): boolean {
  return range[1] <= range[0];
}
