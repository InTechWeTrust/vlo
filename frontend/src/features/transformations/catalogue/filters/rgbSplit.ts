import { RGBSplitFilter } from "pixi-filters";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";
import { createTransformationFilterRuntime } from "../filterRuntime";
import {
  configureUnclippedFilter,
  withFilterTextureLimitRecording,
} from "./unclippedFilterTexture";

const RGB_SPLIT_PARAMETERS = [
  "redX",
  "redY",
  "greenX",
  "greenY",
  "blueX",
  "blueY",
] as const;

class StableRGBSplitFilter extends withFilterTextureLimitRecording(
  RGBSplitFilter,
) {}

/**
 * RGB Split samples each channel at an offset, so pixels near a viewport edge
 * read content outside it. Viewport cropping would drop that content in a
 * zoomed preview and at the project edge in export, so this runtime keeps the
 * filter unclipped.
 */
export const rgbSplitFilterRuntime = createTransformationFilterRuntime({
  create: () => {
    const filter = new StableRGBSplitFilter();
    // Upstream assigns its shared DEFAULT_OPTIONS vectors to the uniforms and
    // the component setters mutate them, so every instance (including export's
    // fresh ones) would share, and overwrite, the same channel offsets.
    filter.red = { x: -10, y: 0 };
    filter.green = { x: 0, y: 10 };
    filter.blue = { x: 0, y: 0 };
    return filter;
  },
  update: (filter, parameters, context, outputFilters) => {
    const rgbSplit = filter as RGBSplitFilter;
    configureUnclippedFilter(rgbSplit, context.target);
    for (const name of RGB_SPLIT_PARAMETERS) {
      const value = parameters[name];
      if (typeof value === "number" && Number.isFinite(value)) {
        rgbSplit[name] = value;
      }
    }
    outputFilters.push(filter);
    return true;
  },
  release: (filter) => filter.destroy(),
});

export const rgbSplitFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual",
  filterName: "RGBSplitFilter",
  filterRuntime: rgbSplitFilterRuntime,
  label: "RGB Split",
  handler: filterHandler,
  // Channel offsets are measured in rendered pixels; keep them proportional
  // to the image. Uniform scaling stays correct for rotated clips.
  filterParameterScale: {
    redX: "worldUniform",
    redY: "worldUniform",
    greenX: "worldUniform",
    greenY: "worldUniform",
    blueX: "worldUniform",
    blueY: "worldUniform",
  },
  // The shader samples outside the input frame without clamping. What it reads
  // there depends on the pooled power-of-two texture size, which varies with
  // zoom and output size; padding keeps every offset sample inside the frame.
  filterPadding: (params) => {
    let maxOffset = 0;
    for (const name of RGB_SPLIT_PARAMETERS) {
      const value = params[name];
      if (typeof value === "number" && Number.isFinite(value)) {
        maxOffset = Math.max(maxOffset, Math.abs(value));
      }
    }
    return maxOffset > 0 ? Math.ceil(maxOffset) + 1 : 0;
  },
  uiConfig: {
    groups: [
      {
        id: "rgbsplit_red",
        title: "Red",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Red X",
            name: "redX",
            defaultValue: -10,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Red Y",
            name: "redY",
            defaultValue: 0,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
      {
        id: "rgbsplit_green",
        title: "Green",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Green X",
            name: "greenX",
            defaultValue: 0,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Green Y",
            name: "greenY",
            defaultValue: 10,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
      {
        id: "rgbsplit_blue",
        title: "Blue",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Blue X",
            name: "blueX",
            defaultValue: 0,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "slider",
            label: "Blue Y",
            name: "blueY",
            defaultValue: 0,
            min: -50,
            max: 50,
            step: 1,
            supportsSpline: true,
          },
        ],
      },
    ],
  },
};
