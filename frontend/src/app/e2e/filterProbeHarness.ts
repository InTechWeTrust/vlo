import {
  Application,
  Container,
  RenderTexture,
  Sprite,
  Texture,
  type Filter,
} from "pixi.js";
import "../../features/transformations";
import { filterApplicator } from "../../features/transformations/catalogue/filterFactory";
import type {
  ClipTransformTarget,
  TransformState,
} from "../../features/transformations/catalogue/types";

/**
 * Shared real-WebGL harness for filter consistency probes.
 *
 * A coordinate-encoded image (R = source x, G = source y, B/A = 255) is drawn
 * under a chosen viewport zoom, pan, render-target resolution and clip
 * transform. Each output pixel therefore names the source pixel its channels
 * sampled, so results can be compared in clip coordinates regardless of the
 * raster they were rendered at.
 */

export const PROBE_IMAGE_SIZE = 256;
const VIEW_SIZE = 512;

export interface ProbeView {
  zoom: number;
  x: number;
  y: number;
  targetResolution?: number;
}

export interface ProbeClip {
  rotation: number;
  scaleX: number;
}

/** Clip cell key → R * 256 + G of the first output pixel covering it. */
export type SampleMap = Map<number, number>;

export interface SampleComparison {
  sharedCells: number;
  mismatchRatio: number;
}

export interface FilterProbeContext {
  maxTextureSize: number;
  render(
    view: ProbeView,
    clip: ProbeClip,
    attachFilters: (sprite: Sprite) => void,
  ): SampleMap;
}

/** Attach filters through the production applicator, as the renderer does. */
export function applyProductionFilter(
  sprite: Sprite,
  type: string,
  params: Record<string, unknown>,
): void {
  const state = {
    scaleX: 1,
    scaleY: 1,
    x: 0,
    y: 0,
    rotation: 0,
    filters: [{ type, params, sourceTransformId: `${type}-probe` }],
  } as TransformState;
  filterApplicator(sprite as unknown as ClipTransformTarget, state, {
    width: PROBE_IMAGE_SIZE,
    height: PROBE_IMAGE_SIZE,
  });
}

function createCoordinateTexture(): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = PROBE_IMAGE_SIZE;
  canvas.height = PROBE_IMAGE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable for filter probe");
  const image = context.createImageData(PROBE_IMAGE_SIZE, PROBE_IMAGE_SIZE);
  for (let y = 0; y < PROBE_IMAGE_SIZE; y++) {
    for (let x = 0; x < PROBE_IMAGE_SIZE; x++) {
      const index = (y * PROBE_IMAGE_SIZE + x) * 4;
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
  attachFilters: (sprite: Sprite) => void,
): SampleMap {
  const renderer = application.renderer;
  const stage = new Container();
  const world = new Container();
  world.scale.set(view.zoom);
  world.position.set(view.x, view.y);
  stage.addChild(world);

  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.position.set(PROBE_IMAGE_SIZE / 2, PROBE_IMAGE_SIZE / 2);
  sprite.rotation = clip.rotation;
  sprite.scale.set(clip.scaleX, 1);
  world.addChild(sprite);
  attachFilters(sprite);

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

/** Fraction of shared cells whose sampled source moved beyond `distance`. */
export function compareSamples(
  reference: SampleMap,
  candidate: SampleMap,
  distance: number,
): SampleComparison {
  let sharedCells = 0;
  let mismatches = 0;
  for (const [key, sample] of candidate) {
    const expected = reference.get(key);
    if (expected === undefined) continue;
    sharedCells += 1;
    const dx = (sample >> 8) - (expected >> 8);
    const dy = (sample & 255) - (expected & 255);
    if (Math.hypot(dx, dy) > distance) mismatches += 1;
  }
  return {
    sharedCells,
    mismatchRatio: sharedCells > 0 ? mismatches / sharedCells : 1,
  };
}

export function samplesEqual(left: SampleMap, right: SampleMap): boolean {
  if (left.size !== right.size) return false;
  for (const [key, sample] of left) {
    if (right.get(key) !== sample) return false;
  }
  return true;
}

/**
 * Views shared by every probe: the reference is fully visible at zoom 1; the
 * others zoom, cross the viewport's top-left edge, raise the render-target
 * resolution, or need unclipped filter textures beyond the device limit.
 */
export function createProbeViews(maxTextureSize: number): {
  reference: ProbeView;
  views: Record<string, ProbeView>;
} {
  const extremeZoom = Math.ceil((maxTextureSize * 1.5) / PROBE_IMAGE_SIZE);
  return {
    reference: { zoom: 1, x: 128, y: 128 },
    views: {
      "zoom-in": { zoom: 1.6, x: -40, y: 10 },
      "zoom-out": { zoom: 0.6, x: 220, y: 200 },
      "crossing-viewport": { zoom: 2.2, x: -250, y: -120 },
      "resolution-2": { zoom: 1, x: 60, y: 60, targetResolution: 2 },
      "beyond-texture-limit": {
        zoom: extremeZoom,
        x: -extremeZoom * 100,
        y: -extremeZoom * 100,
      },
    },
  };
}

function readMaxTextureSize(application: Application): number {
  const gl = (
    application.renderer as unknown as { gl?: WebGL2RenderingContext }
  ).gl;
  if (!gl) throw new Error("Filter probe requires a WebGL renderer");
  return Math.min(
    gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
  );
}

let probeInFlight = false;

/** Run `probe` against a private WebGL application, one probe at a time. */
export async function runFilterProbe<T>(
  probe: (context: FilterProbeContext) => T,
): Promise<T> {
  if (probeInFlight) throw new Error("A filter consistency probe is running");
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
    const coordinateTexture = createCoordinateTexture();
    texture = coordinateTexture;
    return probe({
      maxTextureSize: readMaxTextureSize(application),
      render: (view, clip, attachFilters) =>
        renderSamples(
          application,
          coordinateTexture,
          view,
          clip,
          attachFilters,
        ),
    });
  } finally {
    texture?.destroy(true);
    application.destroy(true, { children: true });
    probeInFlight = false;
  }
}
