export type AspectRatio = `${number}:${number}`;

export type PresetAspectRatio = "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export const PROJECT_ASPECT_RATIOS: readonly PresetAspectRatio[] = [
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
];

export const MAX_ASPECT_RATIO_PART = 10_000;
export const MIN_ASPECT_RATIO_VALUE = 1 / 4;
export const MAX_ASPECT_RATIO_VALUE = 4;

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export function normalizeAspectRatio(value: unknown): AspectRatio | null {
  if (typeof value !== "string") return null;

  const match = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(value);
  if (!match) return null;

  const widthPart = Number(match[1]);
  const heightPart = Number(match[2]);
  if (
    !Number.isSafeInteger(widthPart) ||
    !Number.isSafeInteger(heightPart) ||
    widthPart < 1 ||
    heightPart < 1 ||
    widthPart > MAX_ASPECT_RATIO_PART ||
    heightPart > MAX_ASPECT_RATIO_PART ||
    widthPart / heightPart < MIN_ASPECT_RATIO_VALUE ||
    widthPart / heightPart > MAX_ASPECT_RATIO_VALUE
  ) {
    return null;
  }

  const divisor = greatestCommonDivisor(widthPart, heightPart);
  return `${widthPart / divisor}:${heightPart / divisor}`;
}

export function parseAspectRatio(
  value: unknown,
): { widthPart: number; heightPart: number } | null {
  const normalized = normalizeAspectRatio(value);
  if (!normalized) return null;
  const [widthPart, heightPart] = normalized.split(":").map(Number);
  return { widthPart, heightPart };
}

export function isPresetAspectRatio(
  value: AspectRatio,
): value is PresetAspectRatio {
  return (PROJECT_ASPECT_RATIOS as readonly string[]).includes(value);
}
