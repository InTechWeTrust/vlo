import { GlitchFilter } from "pixi-filters";
import { GlProgram, GpuProgram, type Filter } from "pixi.js";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";
import { createTransformationFilterRuntime } from "../filterRuntime";
import {
  configureUnclippedFilter,
  withFilterTextureLimitRecording,
} from "./unclippedFilterTexture";
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

class StableGlitchFilter extends withFilterTextureLimitRecording(
  GlitchFilter,
) {}

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
  create: () => createStableGlitchFilter(),
  update: (filter, parameters, context, outputFilters) => {
    const glitch = filter as GlitchFilter;
    // The shader spreads the displacement map over the input frame. Viewport
    // cropping would change that frame and move bands relative to the image.
    configureUnclippedFilter(glitch, context.target);
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
