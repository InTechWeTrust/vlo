import { RGBSplitFilter } from "pixi-filters";
import type { Sprite } from "pixi.js";
import {
  applyProductionFilter,
  compareSamples,
  createProbeViews,
  runFilterProbe,
  type ProbeClip,
} from "./filterProbeHarness";

/**
 * Real-WebGL RGB Split consistency probe.
 *
 * Red and green are sampled at authored offsets, so on the coordinate-encoded
 * image each output pixel records where both channels were read. Offsets must
 * stay fixed in clip pixels across zoom, pan and resolution, and samples just
 * beyond a viewport edge must not be cropped away. A raw upstream filter is
 * rendered as a control to prove the probe detects both defects.
 */

/** A channel sample moved by more than this is a mismatch. */
const MISMATCH_DISTANCE = 1.5;

const RGB_SPLIT_PARAMETERS = {
  redX: 12,
  redY: 0,
  greenX: 0,
  greenY: -8,
  blueX: 0,
  blueY: 0,
};

type Implementation = "runtime" | "upstream-control";

export interface RgbSplitConsistencyComparison {
  clip: string;
  view: string;
  implementation: Implementation;
  sharedCells: number;
  mismatchRatio: number;
}

export interface RgbSplitConsistencyProbeResult {
  maxTextureSize: number;
  comparisons: RgbSplitConsistencyComparison[];
}

function attachRgbSplit(implementation: Implementation) {
  return (sprite: Sprite) => {
    if (implementation === "runtime") {
      applyProductionFilter(sprite, "RGBSplitFilter", RGB_SPLIT_PARAMETERS);
      return;
    }
    const control = new RGBSplitFilter();
    control.red = {
      x: RGB_SPLIT_PARAMETERS.redX,
      y: RGB_SPLIT_PARAMETERS.redY,
    };
    control.green = {
      x: RGB_SPLIT_PARAMETERS.greenX,
      y: RGB_SPLIT_PARAMETERS.greenY,
    };
    control.blue = {
      x: RGB_SPLIT_PARAMETERS.blueX,
      y: RGB_SPLIT_PARAMETERS.blueY,
    };
    sprite.filters = [control];
  };
}

export function runRgbSplitConsistencyProbe(): Promise<RgbSplitConsistencyProbeResult> {
  return runFilterProbe(({ maxTextureSize, render }) => {
    const { reference, views } = createProbeViews(maxTextureSize);
    const clips: Record<string, ProbeClip> = {
      default: { rotation: 0, scaleX: 1 },
      "rotated-nonuniform": { rotation: 0.4, scaleX: 1.4 },
    };

    const comparisons: RgbSplitConsistencyComparison[] = [];
    for (const [clipName, clip] of Object.entries(clips)) {
      const implementations: Implementation[] =
        clipName === "default" ? ["runtime", "upstream-control"] : ["runtime"];
      for (const implementation of implementations) {
        const attach = attachRgbSplit(implementation);
        const referenceSamples = render(reference, clip, attach);
        for (const [viewName, view] of Object.entries(views)) {
          comparisons.push({
            clip: clipName,
            view: viewName,
            implementation,
            ...compareSamples(
              referenceSamples,
              render(view, clip, attach),
              MISMATCH_DISTANCE,
            ),
          });
        }
      }
    }

    return { maxTextureSize, comparisons };
  });
}
