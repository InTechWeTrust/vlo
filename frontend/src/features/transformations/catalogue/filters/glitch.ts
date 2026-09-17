import { GlitchFilter } from "pixi-filters";
import {
  GlProgram,
  GpuProgram,
  type Filter,
  type FilterSystem,
  type RenderSurface,
  type Texture,
} from "pixi.js";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";
import { createTransformationFilterRuntime } from "../filterRuntime";
import {
  computeGlitchPattern,
  GLITCH_SAMPLE_SIZE,
  glitchPatternInputsEqual,
  resolveGlitchPatternInputs,
  type GlitchPatternInputs,
} from "../../utils/glitchPattern";

/**
 * Upstream scales the vertical displacement by the frame aspect (`uAspect`),
 * but applies it in input-texture UVs. Pixi pools filter textures at
 * power-of-two sizes, so for a non-square frame with a nonzero Direction the
 * displacement changed with zoom and output size. Converting through the input
 * texture's own dimensions keeps it at `offset` pixels along Direction.
 * `uAspect` still shapes the bands, so this cannot be corrected by uniforms.
 */
const UPSTREAM_Y_DISPLACEMENT = "sinDir * displacement * uAspect";
const STABLE_Y_DISPLACEMENT =
  "sinDir * displacement * uInputSize.x * uInputSize.w";

export function patchGlitchShaderSource(
  source: string,
  language: string,
): string {
  if (source.split(UPSTREAM_Y_DISPLACEMENT).length !== 2) {
    throw new Error(
      `Unexpected pixi-filters Glitch ${language} shader; re-check the vertical displacement patch.`,
    );
  }
  return source.replace(UPSTREAM_Y_DISPLACEMENT, STABLE_Y_DISPLACEMENT);
}

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
 * Viewport clipping is disabled, so a deeply zoomed clip would need a filter
 * texture beyond the device limit, and the clip would render blank. Lowering
 * the filter resolution instead keeps the bands and displacement in place:
 * both are measured against the logical input frame, not its pixel count.
 */
export function resolveGlitchFilterResolution(
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

class StableGlitchFilter extends GlitchFilter {
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

let stablePrograms: { glProgram: GlProgram; gpuProgram: GpuProgram } | null =
  null;

function createStableGlitchFilter(): GlitchFilter {
  const filter = new StableGlitchFilter({ sampleSize: GLITCH_SAMPLE_SIZE });
  if (!stablePrograms) {
    const { glProgram, gpuProgram } = filter;
    if (
      !glProgram.vertex ||
      !glProgram.fragment ||
      !gpuProgram.vertex ||
      !gpuProgram.fragment
    ) {
      throw new Error(
        "pixi-filters Glitch filter has no shader programs to patch.",
      );
    }
    stablePrograms = {
      glProgram: GlProgram.from({
        vertex: glProgram.vertex,
        fragment: patchGlitchShaderSource(glProgram.fragment, "GLSL"),
        name: "vlo-glitch-filter",
      }),
      gpuProgram: GpuProgram.from({
        vertex: gpuProgram.vertex,
        fragment: {
          ...gpuProgram.fragment,
          source: patchGlitchShaderSource(gpuProgram.fragment.source, "WGSL"),
        },
      }),
    };
  }
  filter.glProgram = stablePrograms.glProgram;
  filter.gpuProgram = stablePrograms.gpuProgram;
  return filter;
}

/** Pattern inputs last drawn into each instance's displacement map. */
const DRAWN_PATTERNS = new WeakMap<Filter, GlitchPatternInputs>();

/**
 * Glitch runtime with a seeded displacement map. Seed, Slices, Min Size, and
 * Average fully determine the bands, so preview, export, frame capture, and
 * recreated instances agree. Seed no longer drives the upstream `uSeed`
 * uniform, which only scales the RGB channel offsets this definition leaves
 * at zero.
 */
export const glitchFilterRuntime = createTransformationFilterRuntime({
  create: () => {
    const filter = createStableGlitchFilter();
    // The shader spreads the displacement map over the input frame. Viewport
    // cropping would change that frame and move bands relative to the image.
    filter.clipToViewport = false;
    return filter;
  },
  update: (filter, parameters, context, outputFilters) => {
    const glitch = filter as GlitchFilter;
    glitch.resolution = resolveGlitchFilterResolution(
      getTargetBounds(context.target),
      maxFilterTextureSize,
    );
    if (
      typeof parameters.offset === "number" &&
      Number.isFinite(parameters.offset)
    ) {
      glitch.offset = parameters.offset;
    }
    if (
      typeof parameters.direction === "number" &&
      Number.isFinite(parameters.direction)
    ) {
      glitch.direction = parameters.direction;
    }

    const inputs = resolveGlitchPatternInputs(parameters);
    const drawn = DRAWN_PATTERNS.get(filter);
    if (!drawn || !glitchPatternInputsEqual(drawn, inputs)) {
      // Changing the count makes upstream regenerate a Math.random() map; it
      // is overwritten before this filter is ever rendered.
      glitch.slices = inputs.slices;
      glitch.minSize = inputs.minSize;
      glitch.average = inputs.average;
      const pattern = computeGlitchPattern(inputs, glitch.sampleSize);
      glitch.sizes = pattern.sizes;
      glitch.offsets = pattern.offsets;
      glitch.redraw();
      DRAWN_PATTERNS.set(filter, inputs);
    }

    outputFilters.push(filter);
    return true;
  },
  release: (filter) => {
    DRAWN_PATTERNS.delete(filter);
    filter.destroy();
  },
});

export const glitchFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "GlitchFilter",
  filterRuntime: glitchFilterRuntime,
  label: "Glitch",
  handler: filterHandler,
  // Offset is measured in rendered pixels; keep it proportional to the image.
  filterParameterScale: {
    offset: "worldUniform",
  },
  uiConfig: {
    groups: [
      {
        id: "glitch_settings",
        title: "Settings",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Slices",
            name: "slices",
            defaultValue: 5,
            min: 1,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Offset",
            name: "offset",
            defaultValue: 100,
            min: 0,
            max: 500,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Direction",
            name: "direction",
            defaultValue: 0,
            min: -180,
            max: 180,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Seed",
            name: "seed",
            defaultValue: 0,
            min: 0,
            max: 100,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Min Size",
            name: "minSize",
            defaultValue: 8,
            min: 1,
            max: 100,
            step: 1,
            supportsSpline: false,
          },
          {
            type: "checkbox",
            label: "Average",
            name: "average",
            defaultValue: false,
          },
        ],
      },
    ],
  },
};
