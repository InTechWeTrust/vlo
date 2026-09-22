import { z } from "zod";
import { TICKS_PER_SECOND, mediaSecondsToTickExact, ticksPerFrame } from "../../../core/time";
import {
  createMaskComponentSchema,
  maskAssetId,
  maskClipFields,
  refineMaskTopology,
} from "../../masks/renderContract";
import {
  adjustmentTransformSchema,
  AUDIO_RENDER_TRANSFORM_TYPES,
  maskCompositionTransformSchema,
  maskShapeTransformSchema,
  mediaTransformSchema,
  transformAssetIds,
} from "../../transformations/renderContract";

/**
 * The support set a detached render is qualified for. Media placement and
 * layout, keyframed animation, clip masks, colour grading (with LUTs) and the
 * colour filters, on clips and on adjustment layers. Renamed whenever that
 * set changes, so a render host never accepts a document it cannot draw.
 */
export const RENDER_CONTRACT = "core-v1";

const MAX_TICKS = mediaSecondsToTickExact(86_400);
const id = z.string().min(1).max(200);
const tick = z.number().int().min(0).max(MAX_TICKS);
const positiveTick = tick.positive();

type Issue = (message: string) => void;

const timingFields = {
  id, trackId: id, name: z.string().max(255), start: tick,
  transformedDuration: positiveTick, transformedOffset: tick,
  timelineDuration: positiveTick, croppedSourceDuration: positiveTick, offset: tick,
};

interface ClipTiming {
  sourceDuration: number | null;
  transformedDuration: number;
  transformedOffset: number;
  timelineDuration: number;
  croppedSourceDuration: number;
  offset: number;
}

/**
 * Speed, reverse and freeze are not qualified yet, so every clip must play
 * its source at unit rate: the cached transformed and timeline spans equal
 * the source spans they derive from.
 */
function refineUnitRate(clip: ClipTiming, issue: Issue) {
  if (clip.timelineDuration !== clip.croppedSourceDuration || clip.offset !== clip.transformedOffset) {
    issue("Retiming is not supported by a separate render window.");
  }
  if (clip.sourceDuration !== null && (clip.transformedDuration !== clip.sourceDuration
    || clip.offset + clip.croppedSourceDuration > clip.sourceDuration)) {
    issue("Invalid source trim or transformed duration.");
  }
}

function refineUniqueTransformIds(clip: { transformations: readonly { id: string }[] }, issue: Issue) {
  if (new Set(clip.transformations.map((t) => t.id)).size !== clip.transformations.length) {
    issue("Duplicate transform identity.");
  }
}

const maskComponentSchema = createMaskComponentSchema(maskCompositionTransformSchema);

export const mediaClipSchema = z.strictObject({
  ...timingFields, assetId: id, type: z.enum(["video", "audio", "image"]),
  sourceDuration: positiveTick.nullable(),
  isMuted: z.boolean().default(false),
  components: z.array(maskComponentSchema).max(256).default([]),
  transformations: z.array(mediaTransformSchema).max(64),
}).superRefine((clip, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  refineUnitRate(clip, issue);
  refineUniqueTransformIds(clip, issue);
  if (clip.type === "image" && clip.sourceDuration !== null) issue("Still images require an unbounded sourceDuration.");
  if (clip.type !== "image" && clip.sourceDuration === null) issue("Only still images have an unbounded source.");
  for (const transform of clip.transformations) {
    const audible = AUDIO_RENDER_TRANSFORM_TYPES.has(transform.type);
    if (clip.type === "audio" && !audible) issue("Visual transforms cannot be applied to audio.");
    if (clip.type === "image" && audible) issue("Volume cannot be applied to an image.");
  }
  if (clip.type === "audio" && clip.components.length > 0) issue("Audio clips cannot be masked.");
});

/** Placed on its parent's track with its parent's timing; drawn only through the parent. */
export const maskClipSchema = z.strictObject({
  ...timingFields, ...maskClipFields,
  sourceDuration: positiveTick.nullable(),
  transformations: z.array(maskShapeTransformSchema).max(64),
}).superRefine((clip, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  refineUnitRate(clip, issue);
  refineUniqueTransformIds(clip, issue);
});

/** A render group over the tracks below it; draws nothing of its own. */
export const adjustmentClipSchema = z.strictObject({
  ...timingFields, type: z.literal("adjustment"),
  sourceDuration: positiveTick,
  depth: z.union([z.number().int().min(1).max(64), z.literal("all")]),
  retimingMode: z.enum(["static", "ripple"]).optional(),
  // A muted adjustment applies nothing; the clip-mute action writes it here too.
  isMuted: z.boolean().optional(),
  // No render component attaches to an adjustment. Markers can, and projection
  // removes them, which may leave an empty list behind.
  components: z.array(z.never()).max(0).optional(),
  transformations: z.array(adjustmentTransformSchema).max(64),
}).superRefine((clip, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  refineUnitRate(clip, issue);
  refineUniqueTransformIds(clip, issue);
});

export const renderClipSchema = z.discriminatedUnion("type", [mediaClipSchema, maskClipSchema, adjustmentClipSchema]);
export type RenderClip = z.infer<typeof renderClipSchema>;

export const mediaTrackSchema = z.strictObject({
  id,
  // Absent on tracks saved before track types; the renderer treats them as
  // visual layers that also mix any audio placed on them.
  type: z.enum(["visual", "audio", "adjustment"]).optional(),
  label: z.string(),
  isVisible: z.boolean(), isMuted: z.boolean(), isLocked: z.boolean(),
});

/**
 * A video's own frame rate snaps source time onto its frame grid before a frame
 * is decoded, so it is render input, not library metadata. Null means the
 * editor knows none, and the renderer falls back to the project rate — the
 * same fallback the browser export takes. Only visual sources are snapped.
 */
const sourceFps = z.number().positive().max(1000).nullable().default(null);

const mediaAssetShape = {
  id, type: z.enum(["video", "audio", "image", "lut"]),
  duration: z.number().positive().max(86_400).nullable(),
  fps: sourceFps,
};

function refineMediaAsset(
  asset: { type: string; duration: number | null; fps: number | null },
  ctx: z.RefinementCtx,
) {
  const timeless = asset.type === "image" || asset.type === "lut";
  if (timeless !== (asset.duration === null)) {
    ctx.addIssue({ code: "custom", message: "Only still images and LUTs have no source duration." });
  }
  if (asset.type !== "video" && asset.fps !== null) {
    ctx.addIssue({ code: "custom", message: "Only video sources carry a frame rate." });
  }
}

const mediaAssetSchema = z.strictObject({
  ...mediaAssetShape, name: z.string().min(1).max(255),
}).superRefine(refineMediaAsset);

export const exportFpsSchema = z.number().int().min(1).max(120)
  .refine((fps) => TICKS_PER_SECOND % fps === 0, "FPS must lie on the canonical frame grid.");

type AssetType = z.infer<typeof mediaAssetShape.type>;

/**
 * Every asset a render reads, with the asset types each use accepts: clip
 * media, the active source of each mask, and resources transforms name. This
 * is the one dependency traversal; capture loads and hands over, and the
 * manifest check compares, exactly this set.
 */
export function renderAssetReferences(clips: readonly RenderClip[]): Map<string, ReadonlySet<AssetType>> {
  const references = new Map<string, Set<AssetType>>();
  const add = (assetId: string | null, types: readonly AssetType[]) => {
    if (!assetId) return;
    const accepted = references.get(assetId);
    // One asset used two ways must satisfy both uses.
    references.set(assetId, accepted
      ? new Set([...accepted].filter((type) => types.includes(type)))
      : new Set(types));
  };
  for (const clip of clips) {
    if (clip.type === "mask") {
      add(maskAssetId(clip), clip.maskType === "brush" ? ["image"] : ["video", "image"]);
    } else if (clip.type !== "adjustment") {
      add(clip.assetId, [clip.type]);
    }
    for (const transform of clip.transformations) {
      for (const assetId of transformAssetIds(transform)) add(assetId, ["lut"]);
    }
  }
  return references;
}

/** Shared by preflight (before any asset is read) and the detached document. */
export const mediaProjectTopologySchema = z.strictObject({
  fps: exportFpsSchema, durationTicks: positiveTick,
  tracks: z.array(mediaTrackSchema).min(1).max(64),
  clips: z.array(renderClipSchema).min(1).max(10_000),
  assets: z.array(z.strictObject(mediaAssetShape).superRefine(refineMediaAsset)).max(1024),
}).superRefine((snapshot, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (snapshot.durationTicks % ticksPerFrame(snapshot.fps)) issue("Duration must lie on the canonical frame grid.");
  for (const items of [snapshot.tracks, snapshot.clips, snapshot.assets]) {
    if (new Set(items.map((item) => item.id)).size !== items.length) issue("Duplicate identity in snapshot.");
  }
  const tracks = new Map(snapshot.tracks.map((track) => [track.id, track]));
  const assets = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  const references = renderAssetReferences(snapshot.clips);
  if (references.size !== assets.size || [...references.keys()].some((assetId) => !assets.has(assetId))) {
    issue("Manifest must contain exactly the referenced assets.");
  }
  for (const [assetId, types] of references) {
    const asset = assets.get(assetId);
    if (asset && !types.has(asset.type)) issue(`Asset '${assetId}' is not a type its use accepts.`);
  }
  for (const clip of snapshot.clips) {
    const track = tracks.get(clip.trackId);
    if (!track) {
      issue("Missing clip track.");
    } else if (clip.type === "adjustment" ? track.type !== "adjustment"
      : clip.type === "audio" ? track.type !== undefined && track.type !== "audio"
        : track.type !== undefined && track.type !== "visual") {
      issue("Clip and track types do not match.");
    }
    if (clip.type !== "adjustment" && clip.type !== "mask") {
      const asset = assets.get(clip.assetId);
      if (asset?.duration != null && clip.sourceDuration !== null
        && clip.sourceDuration > Math.ceil(mediaSecondsToTickExact(asset.duration))) {
        issue("Clip exceeds media duration.");
      }
    }
    // Transform IDs need only be unique within a clip: splitting a clip copies
    // them, and filter runtimes are owned per drawn target, not per ID.
    if (clip.start + clip.timelineDuration > snapshot.durationTicks) issue("Clip extends past export duration.");
  }
  refineMaskTopology(snapshot.clips, issue);
  for (const track of snapshot.tracks) {
    // Masks share their parent's track and span by design; only drawn clips can collide.
    const clips = snapshot.clips.filter((clip) => clip.trackId === track.id && clip.type !== "mask")
      .sort((a, b) => a.start - b.start);
    if (clips.some((clip, i) => i > 0 && clips[i - 1].start + clips[i - 1].timelineDuration > clip.start)) {
      issue("Same-track overlap is unsupported; use separate tracks.");
    }
  }
});

/**
 * A whole-project render, detached from the editor: the validated topology,
 * the assets it reads by editor ID, and the output it should produce. Asset
 * bytes travel beside the document; the render host binds each asset to a
 * source it resolves, so nothing here names a URL, path or digest.
 */
export const detachedRenderDocumentSchema = mediaProjectTopologySchema.safeExtend({
  version: z.literal(1),
  renderer: z.strictObject({ contract: z.literal(RENDER_CONTRACT) }),
  geometry: z.strictObject({
    logicalWidth: z.number().int().min(16).max(8192),
    logicalHeight: z.number().int().min(16).max(8192),
    outputWidth: z.number().int().min(16).max(4096).multipleOf(2),
    outputHeight: z.number().int().min(16).max(4096).multipleOf(2),
    backgroundAlpha: z.number().min(0).max(1),
  }),
  encoding: z.strictObject({ format: z.enum(["mp4", "webm"]), includeAudio: z.boolean(),
    keyFrameInterval: z.number().min(0).max(3600) }),
  assets: z.array(mediaAssetSchema).min(1).max(1024),
});

export type DetachedRenderDocument = z.infer<typeof detachedRenderDocumentSchema>;
export type DetachedRenderAsset = DetachedRenderDocument["assets"][number];
