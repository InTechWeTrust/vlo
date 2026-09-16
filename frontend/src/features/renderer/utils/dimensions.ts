import type { AspectRatio } from "../../project/useProjectStore";
import { parseAspectRatio } from "../../project/aspectRatioOptions";
import {
  getProjectOutputDimensionsError,
  resolveProjectOutputDimensions,
} from "../../project/projectOutputGeometry";

const FIXED_VERTICAL_RESOLUTION = 1080;

/**
 * Default short edge for render outputs until the project carries its own
 * (phase 2). Matches the export dialog's default and today's landscape sizes.
 */
export const DEFAULT_RENDER_SHORT_EDGE = 1080;

/**
 * The project's *logical coordinate space* — a fixed-height (1080) stage that
 * stored spatial values (clip positions, paths, group filter geometry) are
 * expressed in. This is not an output resolution: for that, use
 * {@link resolveRenderOutputDimensions}, which pins the short edge instead.
 */
export const getProjectDimensions = (ratio: AspectRatio) => {
  const parsed = parseAspectRatio(ratio);
  if (!parsed) {
    return { width: 1920, height: FIXED_VERTICAL_RESOLUTION };
  }

  return {
    width: Math.round(
      (FIXED_VERTICAL_RESOLUTION * parsed.widthPart) / parsed.heightPart,
    ),
    height: FIXED_VERTICAL_RESOLUTION,
  };
};

export const deriveTrueDimensionsFromShortEdge = (
  ratio: AspectRatio,
  resolution: number,
) => {
  const parsed = parseAspectRatio(ratio);
  if (!parsed) {
    return { width: 1920, height: FIXED_VERTICAL_RESOLUTION };
  }

  const aspectRatio = parsed.widthPart / parsed.heightPart;
  if (aspectRatio >= 1) {
    return {
      width: Math.round(resolution * aspectRatio),
      height: resolution,
    };
  }

  return {
    width: resolution,
    height: Math.round(resolution / aspectRatio),
  };
};

/**
 * Output pixel size for a render: short edge pinned, long edge from the ratio,
 * both even. The one resolver every render-input builder calls, so selection
 * extraction, project export and frame capture cannot drift apart.
 */
export const resolveRenderOutputDimensions = (
  ratio: AspectRatio,
  shortEdge: number = DEFAULT_RENDER_SHORT_EDGE,
) => {
  const dimensions = resolveProjectOutputDimensions(ratio, shortEdge);
  const error = getProjectOutputDimensionsError(dimensions);
  if (error) throw new RangeError(error);
  return dimensions;
};
