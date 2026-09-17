import { GlitchFilter } from "pixi-filters";
import type { Sprite } from "pixi.js";
import { computeGlitchPattern } from "../../features/transformations/utils/glitchPattern";
import {
  applyProductionFilter,
  compareSamples,
  createProbeViews,
  runFilterProbe,
  samplesEqual,
  type ProbeClip,
} from "./filterProbeHarness";

/**
 * Real-WebGL Glitch consistency probe (docs/glitch-render-consistency-plan.md).
 *
 * Renders Glitch through the production filter applicator and compares, in
 * clip coordinates, the source pixel every output pixel sampled. A raw
 * upstream filter with the same seeded map is rendered as a control to prove
 * the probe detects the original defects.
 */

/** A sampled source differing by more than this is a displacement mismatch. */
const MISMATCH_DISTANCE = 1.5;

const GLITCH_PARAMETERS = {
  slices: 9,
  offset: 30,
  direction: 0,
  seed: 12.5,
  minSize: 8,
  average: false,
};

interface GlitchProbeClip extends ProbeClip {
  direction: number;
}

type Implementation = "runtime" | "upstream-control";

export interface GlitchConsistencyComparison {
  clip: string;
  view: string;
  implementation: Implementation;
  sharedCells: number;
  mismatchRatio: number;
}

export interface GlitchConsistencyProbeResult {
  maxTextureSize: number;
  independentInstancesIdentical: boolean;
  comparisons: GlitchConsistencyComparison[];
}

function attachGlitch(clip: GlitchProbeClip, implementation: Implementation) {
  const params = { ...GLITCH_PARAMETERS, direction: clip.direction };
  return (sprite: Sprite) => {
    if (implementation === "runtime") {
      applyProductionFilter(sprite, "GlitchFilter", params);
      return;
    }
    const control = new GlitchFilter(params);
    const pattern = computeGlitchPattern(params);
    control.sizes = pattern.sizes;
    control.offsets = pattern.offsets;
    control.redraw();
    sprite.filters = [control];
  };
}

export function runGlitchConsistencyProbe(): Promise<GlitchConsistencyProbeResult> {
  return runFilterProbe(({ maxTextureSize, render }) => {
    const { reference, views } = createProbeViews(maxTextureSize);
    const clips: Record<string, GlitchProbeClip> = {
      default: { direction: 0, rotation: 0, scaleX: 1 },
      "direction-nonsquare": { direction: 35, rotation: 0, scaleX: 1.5 },
      "direction-rotated-nonuniform": {
        direction: -60,
        rotation: -0.3,
        scaleX: 0.7,
      },
    };

    const comparisons: GlitchConsistencyComparison[] = [];
    for (const [clipName, clip] of Object.entries(clips)) {
      const implementations: Implementation[] =
        clipName === "direction-nonsquare"
          ? ["runtime", "upstream-control"]
          : ["runtime"];
      for (const implementation of implementations) {
        const attach = attachGlitch(clip, implementation);
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

    const defaultAttach = attachGlitch(clips.default, "runtime");
    const independentInstancesIdentical = samplesEqual(
      render(reference, clips.default, defaultAttach),
      render(reference, clips.default, defaultAttach),
    );

    return { maxTextureSize, independentInstancesIdentical, comparisons };
  });
}
