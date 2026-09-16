import {
  normalizeAspectRatio,
  parseAspectRatio,
  type AspectRatio,
} from "./aspectRatioOptions";
import {
  normalizeProjectOutputResolution,
  type ProjectOutputResolution,
} from "./outputResolutionOptions";

export const MAX_PROJECT_OUTPUT_EDGE = 8192;
export const MAX_PROJECT_OUTPUT_PIXELS = 3840 * 2160;

export interface ProjectOutputDimensions {
  width: number;
  height: number;
}

export function getProjectOutputDimensionsError(
  dimensions: ProjectOutputDimensions,
): string | null {
  if (
    dimensions.width > MAX_PROJECT_OUTPUT_EDGE ||
    dimensions.height > MAX_PROJECT_OUTPUT_EDGE
  ) {
    return `${dimensions.width} × ${dimensions.height} exceeds the ${MAX_PROJECT_OUTPUT_EDGE}px maximum edge.`;
  }
  if (dimensions.width * dimensions.height > MAX_PROJECT_OUTPUT_PIXELS) {
    return `${dimensions.width} × ${dimensions.height} exceeds the ${MAX_PROJECT_OUTPUT_PIXELS.toLocaleString()}-pixel maximum output area.`;
  }
  return null;
}

const toEven = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export function resolveProjectOutputDimensions(
  aspectRatio: AspectRatio,
  shortEdge: ProjectOutputResolution,
): ProjectOutputDimensions {
  const parsed = parseAspectRatio(aspectRatio);
  if (!parsed) {
    return { width: 1920, height: 1080 };
  }

  const ratio = parsed.widthPart / parsed.heightPart;
  return ratio >= 1
    ? { width: toEven(shortEdge * ratio), height: toEven(shortEdge) }
    : { width: toEven(shortEdge), height: toEven(shortEdge / ratio) };
}

export function getProjectOutputGeometryError(
  aspectRatio: unknown,
  shortEdge: unknown,
): string | null {
  const normalizedRatio = normalizeAspectRatio(aspectRatio);
  if (!normalizedRatio) {
    return "Enter a ratio from 1:4 to 4:1.";
  }

  const normalizedShortEdge = normalizeProjectOutputResolution(shortEdge);
  if (normalizedShortEdge === null) {
    return "Enter a supported even short edge.";
  }

  const dimensions = resolveProjectOutputDimensions(
    normalizedRatio,
    normalizedShortEdge,
  );
  return getProjectOutputDimensionsError(dimensions);
}

export function isValidProjectOutputGeometry(
  aspectRatio: unknown,
  shortEdge: unknown,
): boolean {
  return getProjectOutputGeometryError(aspectRatio, shortEdge) === null;
}
