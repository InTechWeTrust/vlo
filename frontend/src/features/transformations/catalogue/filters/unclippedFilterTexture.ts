import type { Filter, FilterSystem, RenderSurface, Texture } from "pixi.js";

/**
 * Support for filters that must not be cropped to the render viewport.
 *
 * Pixi fits filter bounds to the viewport by default. Effects whose output
 * depends on the input frame (Glitch bands) or on samples outside the visible
 * area (RGB Split channel offsets) then differ between a zoomed preview and an
 * export whose viewport is the project frame. Disabling that cropping makes a
 * deeply zoomed clip need a filter texture beyond the device limit, where it
 * would render blank; these helpers lower the filter resolution instead.
 */

/**
 * Largest filter texture side the device accepts. Starts conservative and is
 * refined from the renderer on the first apply.
 */
let maxFilterTextureSize = 4096;

interface RendererLimitSource {
  gl?: WebGLRenderingContext | WebGL2RenderingContext;
  gpu?: { device?: { limits?: { maxTextureDimension2D?: number } } };
}

function recordMaxFilterTextureSize(renderer: RendererLimitSource): void {
  const gl = renderer.gl;
  const size = gl
    ? Math.min(
        gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      )
    : renderer.gpu?.device?.limits?.maxTextureDimension2D;
  if (typeof size === "number" && size > 0) maxFilterTextureSize = size;
}

/** Headroom for padding added by other filters sharing the target's chain. */
const FILTER_TEXTURE_HEADROOM = 0.9;

/**
 * Resolution at which unclipped bounds fit the device texture limit. Effects
 * measured against the logical input frame keep their geometry; only sampling
 * density decreases.
 */
export function resolveUnclippedFilterResolution(
  bounds: { width: number; height: number } | null,
  maxTextureSize: number,
): number {
  if (!bounds) return 1;
  const side = Math.max(bounds.width, bounds.height);
  if (!Number.isFinite(side) || side <= 0) return 1;
  return Math.min(1, (maxTextureSize * FILTER_TEXTURE_HEADROOM) / side);
}

function getTargetBounds(
  target: unknown,
): { width: number; height: number } | null {
  const boundsTarget = target as {
    getBounds?: () => { width: number; height: number };
  };
  return typeof boundsTarget.getBounds === "function"
    ? boundsTarget.getBounds()
    : null;
}

/** Disable viewport cropping and fit the filter texture for this target. */
export function configureUnclippedFilter(
  filter: Filter,
  target: unknown,
): void {
  filter.clipToViewport = false;
  filter.resolution = resolveUnclippedFilterResolution(
    getTargetBounds(target),
    maxFilterTextureSize,
  );
}

// Mixin constructors must accept arbitrary arguments.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilterConstructor = abstract new (...args: any[]) => Filter;

/** Record the device texture limit whenever an instance is applied. */
export function withFilterTextureLimitRecording<T extends FilterConstructor>(
  Base: T,
) {
  abstract class TextureLimitRecordingFilter extends Base {
    override apply(
      filterManager: FilterSystem,
      input: Texture,
      output: RenderSurface,
      clearMode: boolean,
    ): void {
      recordMaxFilterTextureSize(filterManager.renderer as RendererLimitSource);
      super.apply(filterManager, input, output, clearMode);
    }
  }
  return TextureLimitRecordingFilter;
}
