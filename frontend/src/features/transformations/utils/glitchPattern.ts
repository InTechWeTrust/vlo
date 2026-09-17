/**
 * Deterministic Glitch displacement pattern.
 *
 * pixi-filters' GlitchFilter generates its slice sizes and offsets with
 * `Math.random()`, so two instances with identical parameters (for example the
 * live preview and a frame capture) draw different bands. This module ports
 * the upstream distribution onto a seeded PRNG so the authored parameters alone
 * determine the pattern.
 */

export const GLITCH_DEFAULT_SLICES = 5;
export const GLITCH_DEFAULT_MIN_SIZE = 8;
export const GLITCH_SAMPLE_SIZE = 512;
/** One band per displacement-map row is the finest meaningful subdivision. */
export const GLITCH_MAX_SLICES = GLITCH_SAMPLE_SIZE;

export interface GlitchPatternInputs {
  readonly seed: number;
  readonly slices: number;
  readonly minSize: number;
  readonly average: boolean;
}

export interface GlitchPattern {
  /** Slice heights as fractions of the displacement map; they sum to 1. */
  readonly sizes: Float32Array;
  /** Per-slice displacement in [-1, 1], scaled by the filter's `offset`. */
  readonly offsets: Float32Array;
}

/**
 * Normalize a possibly interpolated slice count to a valid integer. Splines
 * can resolve fractional values despite the slider's integer step.
 */
export function normalizeGlitchSliceCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return GLITCH_DEFAULT_SLICES;
  }
  return Math.min(GLITCH_MAX_SLICES, Math.max(1, Math.round(value)));
}

function normalizeMinSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return GLITCH_DEFAULT_MIN_SIZE;
  }
  return Math.max(0, value);
}

function normalizeSeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  // -0 and +0 are the same authored value but have different bit patterns.
  return value === 0 ? 0 : value;
}

/** Resolve raw filter parameters into canonical pattern inputs. */
export function resolveGlitchPatternInputs(
  parameters: Readonly<Record<string, unknown>>,
): GlitchPatternInputs {
  return {
    seed: normalizeSeed(parameters.seed),
    slices: normalizeGlitchSliceCount(parameters.slices),
    minSize: normalizeMinSize(parameters.minSize),
    average: parameters.average === true,
  };
}

export function glitchPatternInputsEqual(
  left: GlitchPatternInputs,
  right: GlitchPatternInputs,
): boolean {
  return (
    left.seed === right.seed &&
    left.slices === right.slices &&
    left.minSize === right.minSize &&
    left.average === right.average
  );
}

/**
 * Hash every bit of the float64 seed so fractional seeds (including animated
 * ones) map to distinct, stable PRNG states.
 */
function hashSeed(seed: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, seed);
  let hash = 0x9e3779b9;
  for (const word of [view.getUint32(0), view.getUint32(4)]) {
    hash = Math.imul(hash ^ word, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, and identical across JS engines. */
function createRandom(seed: number): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate the slice sizes and offsets for the given inputs, following the
 * upstream `_randomizeSizes`, `shuffle`, and `_randomizeOffsets` distribution.
 */
export function computeGlitchPattern(
  inputs: GlitchPatternInputs,
  sampleSize: number = GLITCH_SAMPLE_SIZE,
): GlitchPattern {
  const random = createRandom(inputs.seed);
  const count = normalizeGlitchSliceCount(inputs.slices);
  const sizes = new Float32Array(count);
  const offsets = new Float32Array(count);
  const last = count - 1;
  const min = Math.min(
    normalizeMinSize(inputs.minSize) / sampleSize,
    0.9 / count,
  );

  let rest = 1;
  if (inputs.average) {
    for (let i = 0; i < last; i++) {
      const averageWidth = rest / (count - i);
      const width = Math.max(averageWidth * (1 - random() * 0.6), min);
      sizes[i] = width;
      rest -= width;
    }
  } else {
    const ratio = Math.sqrt(1 / count);
    for (let i = 0; i < last; i++) {
      const width = Math.max(ratio * rest * random(), min);
      sizes[i] = width;
      rest -= width;
    }
  }
  sizes[last] = rest;

  for (let i = last; i > 0; i--) {
    const swap = Math.floor(random() * i);
    const temp = sizes[i];
    sizes[i] = sizes[swap];
    sizes[swap] = temp;
  }

  for (let i = 0; i < count; i++) {
    offsets[i] = random() * (random() < 0.5 ? -1 : 1);
  }

  return { sizes, offsets };
}
