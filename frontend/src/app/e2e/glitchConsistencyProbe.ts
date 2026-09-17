import {
  Application,
  Container,
  RenderTexture,
  Sprite,
  Texture,
  type Filter,
} from "pixi.js";
import { GlitchFilter } from "pixi-filters";
import "../../features/transformations";
import { filterApplicator } from "../../features/transformations/catalogue/filterFactory";
import type {
  ClipTransformTarget,
  TransformState,
} from "../../features/transformations/catalogue/types";
import { computeGlitchPattern } from "../../features/transformations/utils/glitchPattern";

/**
 * Real-WebGL Glitch consistency probe (docs/glitch-render-consistency-plan.md).
 *
 * Renders a coordinate-encoded image (R = source x, G = source y) through the
 * production filter applicator under different viewport zooms, pans, render
 * target resolutions, and clip transforms. Every output pixel therefore names
 * the source pixel it sampled, so band placement and displacement can be
 * compared in clip coordinates. A raw upstream filter with the same seeded map
 * is rendered as a control to prove the probe detects the original defects.
 */

const IMAGE_SIZE = 256;
const VIEW_SIZE = 512;
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

interface ProbeView {
  zoom: number;
  x: number;
  y: number;
  targetResolution?: number;
}

interface ProbeClip {
  direction: number;
  rotation: number;
  scaleX: number;
}

type SampleMap = Map<number, number>;

export interface GlitchConsistencyComparison {
  clip: string;
  view: string;
  implementation: "runtime" | "upstream-control";
  sharedCells: number;
  mismatchRatio: number;
}

export interface GlitchConsistencyProbeResult {
  maxTextureSize: number;
  extremeZoom: number;
  independentInstancesIdentical: boolean;
  comparisons: GlitchConsistencyComparison[];
}

let probeInFlight = false;

function createCoordinateTexture(): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_SIZE;
  canvas.height = IMAGE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable for Glitch probe");
  const image = context.createImageData(IMAGE_SIZE, IMAGE_SIZE);
  for (let y = 0; y < IMAGE_SIZE; y++) {
    for (let x = 0; x < IMAGE_SIZE; x++) {
      const index = (y * IMAGE_SIZE + x) * 4;
      image.data[index] = x;
      image.data[index + 1] = y;
      image.data[index + 2] = 255;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = "nearest";
  return texture;
}

function renderSamples(
  application: Application,
  texture: Texture,
  view: ProbeView,
  clip: ProbeClip,
  implementation: GlitchConsistencyComparison["implementation"],
): SampleMap {
  const renderer = application.renderer;
  const stage = new Container();
  const world = new Container();
  world.scale.set(view.zoom);
  world.position.set(view.x, view.y);
  stage.addChild(world);

  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.position.set(IMAGE_SIZE / 2, IMAGE_SIZE / 2);
  sprite.rotation = clip.rotation;
  sprite.scale.set(clip.scaleX, 1);
  world.addChild(sprite);

  const params = { ...GLITCH_PARAMETERS, direction: clip.direction };
  if (implementation === "runtime") {
    const state = {
      scaleX: 1,
      scaleY: 1,
      x: 0,
      y: 0,
      rotation: 0,
      filters: [
        { type: "GlitchFilter", params, sourceTransformId: "glitch-probe" },
      ],
    } as TransformState;
    filterApplicator(sprite as unknown as ClipTransformTarget, state, {
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
    });
  } else {
    const control = new GlitchFilter(params);
    const pattern = computeGlitchPattern(params);
    control.sizes = pattern.sizes;
    control.offsets = pattern.offsets;
    control.redraw();
    sprite.filters = [control];
  }

  const resolution = view.targetResolution ?? 1;
  const target = RenderTexture.create({
    width: VIEW_SIZE / resolution,
    height: VIEW_SIZE / resolution,
    resolution,
  });
  const filters: readonly Filter[] = sprite.filters ?? [];
  try {
    renderer.render({ container: stage, target, clear: true });
    const { pixels, width, height } = renderer.extract.pixels(target);
    const samples: SampleMap = new Map();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        if (pixels[index + 3] < 250 || pixels[index + 2] < 250) continue;
        const worldX = Math.floor(
          ((x + 0.5) / resolution - view.x) / view.zoom,
        );
        const worldY = Math.floor(
          ((y + 0.5) / resolution - view.y) / view.zoom,
        );
        const key = worldY * 4096 + worldX;
        if (!samples.has(key)) {
          samples.set(key, pixels[index] * 256 + pixels[index + 1]);
        }
      }
    }
    return samples;
  } finally {
    stage.destroy({ children: true });
    for (const filter of filters) filter.destroy();
    target.destroy(true);
  }
}

function compareSamples(
  reference: SampleMap,
  candidate: SampleMap,
): Pick<GlitchConsistencyComparison, "sharedCells" | "mismatchRatio"> {
  let sharedCells = 0;
  let mismatches = 0;
  for (const [key, sample] of candidate) {
    const expected = reference.get(key);
    if (expected === undefined) continue;
    sharedCells += 1;
    const dx = (sample >> 8) - (expected >> 8);
    const dy = (sample & 255) - (expected & 255);
    if (Math.hypot(dx, dy) > MISMATCH_DISTANCE) mismatches += 1;
  }
  return {
    sharedCells,
    mismatchRatio: sharedCells > 0 ? mismatches / sharedCells : 1,
  };
}

function samplesEqual(left: SampleMap, right: SampleMap): boolean {
  if (left.size !== right.size) return false;
  for (const [key, sample] of left) {
    if (right.get(key) !== sample) return false;
  }
  return true;
}

function readMaxTextureSize(application: Application): number {
  const gl = (
    application.renderer as unknown as { gl?: WebGL2RenderingContext }
  ).gl;
  if (!gl) throw new Error("Glitch probe requires a WebGL renderer");
  return Math.min(
    gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
  );
}

export async function runGlitchConsistencyProbe(): Promise<GlitchConsistencyProbeResult> {
  if (probeInFlight)
    throw new Error("Glitch consistency probe already running");
  probeInFlight = true;
  const application = new Application();
  let texture: Texture | null = null;
  try {
    await application.init({
      width: VIEW_SIZE,
      height: VIEW_SIZE,
      preference: "webgl",
      antialias: false,
      resolution: 1,
      backgroundAlpha: 0,
    });
    texture = createCoordinateTexture();
    const maxTextureSize = readMaxTextureSize(application);
    // Unclipped filter bounds at this zoom exceed the device texture limit.
    const extremeZoom = Math.ceil((maxTextureSize * 1.5) / IMAGE_SIZE);

    const reference: ProbeView = { zoom: 1, x: 128, y: 128 };
    const views: Record<string, ProbeView> = {
      "zoom-in": { zoom: 1.6, x: -40, y: 10 },
      "zoom-out": { zoom: 0.6, x: 220, y: 200 },
      "crossing-viewport": { zoom: 2.2, x: -250, y: -120 },
      "resolution-2": { zoom: 1, x: 60, y: 60, targetResolution: 2 },
      "beyond-texture-limit": {
        zoom: extremeZoom,
        x: -extremeZoom * 100,
        y: -extremeZoom * 100,
      },
    };
    const clips: Record<string, ProbeClip> = {
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
      const implementations: GlitchConsistencyComparison["implementation"][] =
        clipName === "direction-nonsquare"
          ? ["runtime", "upstream-control"]
          : ["runtime"];
      for (const implementation of implementations) {
        const referenceSamples = renderSamples(
          application,
          texture,
          reference,
          clip,
          implementation,
        );
        for (const [viewName, view] of Object.entries(views)) {
          comparisons.push({
            clip: clipName,
            view: viewName,
            implementation,
            ...compareSamples(
              referenceSamples,
              renderSamples(application, texture, view, clip, implementation),
            ),
          });
        }
      }
    }

    const defaultClip = clips.default;
    const independentInstancesIdentical = samplesEqual(
      renderSamples(application, texture, reference, defaultClip, "runtime"),
      renderSamples(application, texture, reference, defaultClip, "runtime"),
    );

    return {
      maxTextureSize,
      extremeZoom,
      independentInstancesIdentical,
      comparisons,
    };
  } finally {
    texture?.destroy(true);
    application.destroy(true, { children: true });
    probeInFlight = false;
  }
}
