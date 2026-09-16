import {
  DEFAULT_PROJECT_OUTPUT_RESOLUTION,
  normalizeProjectOutputResolution,
} from "../../project/outputResolutionOptions";
// Deep import, like `renderer/utils/mediaTime` elsewhere in this feature:
// `dimensions` is a leaf module, while the renderer front door pulls in the
// feature graph and would put this file inside a large import cycle.
import { resolveRenderOutputDimensions } from "../../renderer/utils/dimensions";
import type { AspectRatio } from "../../project/useProjectStore";

export interface SelectionResolutionSources {
  /**
   * What the user picked on the selection, or `null` to follow the project.
   * May be a preset or the project's validated custom short edge.
   */
  override?: number | null;
  /**
   * What the workflow asks for. Loses to an explicit override, and is
   * deliberately *not* restricted to the rungs: a workflow's own target is
   * whatever its rules declare (832, 1024, …), and rounding it to a rung would
   * defeat the point of rendering at the size the workflow will use.
   */
  recommended?: number | null;
  /** The project's own output resolution. */
  project?: number | null;
}

const isPositiveShortEdge = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * The short edge a selection should render at.
 *
 * Precedence is the same one the fps and frame-step settings use: an explicit
 * choice on the selection wins, then the workflow's recommendation, then the
 * project.
 */
export function resolveSelectionRenderResolution(
  sources: SelectionResolutionSources,
): number {
  const override = normalizeProjectOutputResolution(sources.override);
  if (override !== null) {
    return override;
  }
  if (isPositiveShortEdge(sources.recommended)) {
    return Math.round(sources.recommended);
  }
  if (isPositiveShortEdge(sources.project)) {
    return Math.round(sources.project);
  }
  return DEFAULT_PROJECT_OUTPUT_RESOLUTION;
}

/**
 * Output pixel size for a selection render — the resolution above, resolved
 * against the project's aspect ratio through the one shared resolver, so a
 * selection and a project export of the same ratio agree exactly.
 */
export function resolveSelectionRenderDimensions(
  aspectRatio: AspectRatio,
  sources: SelectionResolutionSources,
): { width: number; height: number } {
  return resolveRenderOutputDimensions(
    aspectRatio,
    resolveSelectionRenderResolution(sources),
  );
}

/**
 * The short edge a region should render at, given what the region already
 * carries. Mirrors {@link resolveSelectionFps}: the value stored on the region
 * was resolved when it was created, so it is taken as-is (any positive short
 * edge, since a workflow's target need not be one of the offered rungs) and
 * only an absent one falls back to the project.
 */
export function resolveRegionRenderResolution(
  region: { resolution?: number | null } | null | undefined,
  projectResolution: number | null | undefined,
): number {
  if (isPositiveShortEdge(region?.resolution)) {
    return Math.round(region.resolution);
  }
  return isPositiveShortEdge(projectResolution)
    ? Math.round(projectResolution)
    : DEFAULT_PROJECT_OUTPUT_RESOLUTION;
}

/** Output pixel size for {@link resolveRegionRenderResolution}. */
export function resolveRegionRenderDimensions(
  aspectRatio: AspectRatio,
  region: { resolution?: number | null } | null | undefined,
  projectResolution: number | null | undefined,
): { width: number; height: number } {
  return resolveRenderOutputDimensions(
    aspectRatio,
    resolveRegionRenderResolution(region, projectResolution),
  );
}
