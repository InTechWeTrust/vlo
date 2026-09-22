import { z } from "zod";
import { mediaSecondsToTickExact, ticksPerFrame } from "../../../core/time";
import {
  detachedRenderDocumentSchema,
  exportFpsSchema,
  RENDER_CONTRACT,
  mediaTrackSchema,
  mediaProjectTopologySchema,
  renderAssetReferences,
  renderClipSchema,
  type DetachedRenderDocument,
} from "../schemas/projectRenderSnapshot";
import { withoutMaskAuthoringData } from "../../masks/renderContract";
import {
  QUALIFIED_BLEND_MODES,
  QUALIFIED_FILTER_NAMES,
  QUALIFIED_MASK_EDGE_TYPES,
  QUALIFIED_TRANSFORM_TYPES,
  withoutLegacyTransformParameters,
} from "../../transformations/renderContract";

// Validate before projecting. Persistence intentionally preserves unknown clip
// fields; dropping them here could turn a future effect into a silent omission.
const projectInputsSchema = z.strictObject({
  tracks: z.array(mediaTrackSchema).min(1).max(64),
  clips: z.array(renderClipSchema).min(1).max(10_000),
  transitions: z.array(z.unknown()).max(0).optional(),
  assets: z.array(z.unknown()).max(100_000),
  // Unreferenced library content is not a render dependency. compositeId on a
  // clip is rejected by mediaClipSchema, including hidden/muted clips.
  composites: z.array(z.unknown()).optional(),
  compositeSourcePolicy: z.unknown().optional(),
  duration: z.number().int().positive().max(mediaSecondsToTickExact(86_400)),
  fps: exportFpsSchema,
});

const sourceAssetSchema = z.strictObject({
  id: z.string().min(1).max(200), hash: z.string(), name: z.string().min(1).max(255),
  type: z.enum(["video", "audio", "image", "lut"]), src: z.string(), createdAt: z.number(),
  duration: z.number().positive().max(86_400).optional(),
  sourcePath: z.string().optional(), metadataRef: z.string().optional(), metadataLoaded: z.boolean().optional(),
  fps: z.number().positive().optional(), hasAudio: z.boolean().optional(),
  familyId: z.string().optional(), favourite: z.boolean().optional(),
  thumbnail: z.string().optional(), thumbnailPath: z.string().optional(),
  proxySrc: z.string().optional(), proxyPath: z.string().optional(),
  // These fields are known editor metadata, not render inputs. Insertion
  // materializes creation-time transforms/masks onto the clip itself.
  creationMetadata: z.unknown().optional(), file: z.unknown().optional(), proxyFile: z.unknown().optional(),
});

export interface ProjectExportPreflightIssue {
  code:
    /** A feature a separate render window does not support yet; the editor's export does. */
    | "unsupported-feature"
    | "unsupported-project"
    | "missing-asset"
    | "asset-not-ready"
    /** The editor was edited or switched while capture was in progress. */
    | "project-changed"
    | "project-busy";
  path: string;
  message: string;
}

export class ProjectExportPreflightError extends Error {
  readonly issues: readonly ProjectExportPreflightIssue[];
  constructor(issues: readonly ProjectExportPreflightIssue[]) {
    const features = issues.filter((issue) => issue.code === "unsupported-feature");
    super(features.length > 0 && features.length === issues.length
      ? `A separate render window doesn't support these yet: ${features.map((issue) => issue.message).join("; ")}. `
        + "Export in the editor instead."
      : issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "ProjectExportPreflightError";
    this.issues = issues;
  }
}

function parseSupported<T>(schema: z.ZodType<T>, value: unknown, prefix: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ProjectExportPreflightError(result.error.issues.map((issue) => ({
    code: "unsupported-project", path: [prefix, ...issue.path].join("."),
    message: `Unsupported or invalid render data: ${issue.message}`,
  })));
}

type LooseRecord = Record<string, unknown>;

/**
 * Tracks with no clips render nothing in any renderer, so they are left out
 * rather than refused: an empty prompt or effects track should not keep a
 * project out of a separate render window. Relative track order, which is layer order, is
 * unchanged.
 */
function withoutEmptyTracks(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const project = value as LooseRecord;
  const occupied = new Set(records(project.clips).map((clip) => clip.trackId));
  return Array.isArray(project.tracks)
    ? { ...project, tracks: records(project.tracks).filter((track) => occupied.has(track.id)) }
    : value;
}

/**
 * The render projection: data the editor keeps that cannot change a frame is
 * dropped by the feature that owns it, before the strict schema sees the
 * rest. Anything not named here is render input and is validated as such.
 */
function projectForRender(value: unknown): unknown {
  const withTracks = withoutEmptyTracks(value);
  if (!withTracks || typeof withTracks !== "object") return withTracks;
  const project = withTracks as LooseRecord;
  return Array.isArray(project.clips)
    ? { ...project, clips: records(project.clips).map((clip) => {
      const projected = withoutMaskAuthoringData(clip);
      return Array.isArray(projected.transformations)
        ? { ...projected, transformations: records(projected.transformations).map(withoutLegacyTransformParameters) }
        : projected;
    }) }
    : withTracks;
}

/**
 * Assets a project names, read tolerantly before validation: hydration has to
 * run on a project that preflight would still reject, because an unhydrated
 * sidecar is itself one of the reasons it would. Over-inclusive by design —
 * it names every asset field, not only each mask's active one.
 */
export function referencedAssetIdsLoosely(projectData: unknown): string[] {
  const project = projectData && typeof projectData === "object" ? projectData as LooseRecord : {};
  const ids = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value.length > 0) ids.add(value); };
  for (const clip of records(project.clips)) {
    for (const field of ["assetId", "sam2MaskAssetId", "generationMaskAssetId", "brushMaskAssetId"]) add(clip[field]);
    for (const transform of records(clip.transformations)) {
      add((transform.parameters as LooseRecord | undefined)?.lutAssetId);
    }
  }
  return [...ids];
}

function records(value: unknown): LooseRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is LooseRecord => !!item && typeof item === "object")
    : [];
}

const CLIP_LABELS: Readonly<Record<string, string>> = {
  text: "Text clips",
  shape: "Shapes",
  extension: "Extension clips",
};
/** Kept apart from clip labels, so a track and the clips on it are not one count. */
const TRACK_LABELS: Readonly<Record<string, string>> = {
  prompt: "Prompt tracks",
  effects: "Effects tracks",
};
const RENDERED_TRACK_TYPES = new Set(["undefined", "visual", "audio", "adjustment"]);
const RENDERED_CLIP_TYPES = new Set(["video", "audio", "image", "mask", "adjustment"]);
/** Speed-family transforms. Named apart so a retimed clip reads as one blocker. */
const RETIMING_TRANSFORMS = new Set(["speed", "reverse", "freeze"]);

function transformLabel(transform: LooseRecord): string | null {
  const type = typeof transform.type === "string" ? transform.type : "unknown";
  if (RETIMING_TRANSFORMS.has(type)) return "Speed changes";
  if (type === "filter") {
    const name = typeof transform.filterName === "string" ? transform.filterName : "unknown";
    return QUALIFIED_FILTER_NAMES.has(name) ? null : `The ${name.replace(/Filter$/, "")} effect`;
  }
  if (type === "blendMode") {
    const mode = (transform.parameters as LooseRecord | undefined)?.blendMode;
    return typeof mode === "string" && !QUALIFIED_BLEND_MODES.has(mode) ? `The "${mode}" blend mode` : null;
  }
  const parameters = transform.parameters as LooseRecord | undefined;
  if (parameters && Object.values(parameters).some((value) =>
    typeof (value as LooseRecord | null)?.type === "string"
    && String((value as LooseRecord).type).startsWith("extension-"))) {
    return "Extension-driven animation";
  }
  return QUALIFIED_TRANSFORM_TYPES.has(type) ? null : `The ${type} transform`;
}

/**
 * The features that keep this project out of a separate render window, named the way
 * a user would recognise them and counted, rather than as schema paths.
 *
 * Checked before the render schema so the common cases — text, composites,
 * transitions, speed — read as one line each. Anything this does not
 * recognise still falls through to the schema, which stays the authority.
 * Tracks with no clips are not blockers: they render nothing, and the
 * snapshot leaves them out.
 */
export function findDetachedRenderBlockers(value: unknown): ProjectExportPreflightIssue[] {
  if (!value || typeof value !== "object") return [];
  const project = value as LooseRecord;
  const counts = new Map<string, number>();
  const count = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);
  const clips = records(project.clips);
  const occupied = new Set(clips.map((clip) => clip.trackId));

  for (const track of records(project.tracks)) {
    const type = String(track.type);
    if (RENDERED_TRACK_TYPES.has(type) || !occupied.has(track.id)) continue;
    count(TRACK_LABELS[type] ?? `"${type}" tracks`);
  }
  for (const clip of clips) {
    const type = String(clip.type);
    if (!RENDERED_CLIP_TYPES.has(type)) {
      count(CLIP_LABELS[type] ?? `"${type}" clips`);
      continue;
    }
    if (clip.compositeId) count("Composites");
    // A mask follows its parent's timing, so a retimed parent is already
    // counted once; counting its masks again would inflate the number.
    const labels = new Set(records(clip.transformations).map(transformLabel)
      .filter((label): label is string => label !== null && !(type === "mask" && label === "Speed changes")));
    if (type !== "mask" && !labels.has("Speed changes")
      && (clip.timelineDuration !== clip.croppedSourceDuration || clip.offset !== clip.transformedOffset)) {
      labels.add("Speed changes");
    }
    for (const component of records(clip.components)) {
      for (const transform of records((component.parameters as LooseRecord | undefined)?.compositeTransformations)) {
        const label = transformLabel(transform);
        if (label && !QUALIFIED_MASK_EDGE_TYPES.has(String(transform.type))) labels.add(label);
      }
    }
    for (const label of labels) count(label);
  }
  const transitions = records(project.transitions).length;
  if (transitions > 0) counts.set("Transitions", transitions);

  return [...counts].map(([label, total]) => ({
    code: "unsupported-feature" as const,
    path: "project",
    message: `${label} (${total})`,
  }));
}

function timeless(type: string): boolean {
  return type === "image" || type === "lut";
}

/** Pure preflight on a captured ProjectData value; does not hydrate or read assets. */
export function inspectProjectRenderInputs(value: unknown) {
  const blockers = findDetachedRenderBlockers(value);
  if (blockers.length > 0) throw new ProjectExportPreflightError(blockers);
  const project = parseSupported(projectInputsSchema, projectForRender(value), "project");
  const requiredIds = new Set(renderAssetReferences(project.clips).keys());
  const sourceAssets = new Map<string, z.infer<typeof sourceAssetSchema>>();
  for (const raw of project.assets) {
    if (!raw || typeof raw !== "object" || !("id" in raw) || typeof raw.id !== "string" || !requiredIds.has(raw.id)) continue;
    const asset = parseSupported(sourceAssetSchema, raw, `assets.${raw.id}`);
    if (sourceAssets.has(asset.id)) {
      throw new ProjectExportPreflightError([{ code: "unsupported-project", path: `assets.${asset.id}`, message: "Duplicate asset identity." }]);
    }
    if ((asset.metadataRef && asset.metadataLoaded !== true) || (!timeless(asset.type) && asset.duration === undefined)) {
      throw new ProjectExportPreflightError([{ code: "asset-not-ready", path: `assets.${asset.id}`,
        message: "Hydrate this asset's metadata before capturing the export." }]);
    }
    sourceAssets.set(asset.id, asset);
  }
  const dependencies = [...requiredIds].map((id) => {
    const asset = sourceAssets.get(id);
    if (!asset) throw new ProjectExportPreflightError([{ code: "missing-asset", path: `assets.${id}`, message: "Referenced asset is missing." }]);
    // No locator, File/Blob, thumbnail, proxy or hash: the render host binds
    // each asset to a source of its own, by ID.
    return { id: asset.id, name: asset.name, type: asset.type,
      duration: timeless(asset.type) ? null : asset.duration!,
      // Only visual decoding snaps to a source frame grid; the renderer reads
      // no other asset's rate.
      fps: asset.type === "video" ? asset.fps ?? null : null };
  });
  const timeline = {
    tracks: project.tracks, clips: project.clips, fps: project.fps,
    // Match ExportRenderer's ceil-to-frame policy for a full project export.
    durationTicks: Math.ceil(project.duration / ticksPerFrame(project.fps)) * ticksPerFrame(project.fps),
  };
  parseSupported(mediaProjectTopologySchema, { ...timeline,
    assets: dependencies.map(({ id, type, duration, fps }) => ({ id, type, duration, fps })),
  }, "project");
  return { ...timeline, dependencies };
}

interface CreateDetachedRenderDocumentOptions {
  projectData: unknown;
  geometry: DetachedRenderDocument["geometry"];
  encoding: DetachedRenderDocument["encoding"];
}

/** Capture after hydration and brush-mask materialization. */
export function createDetachedRenderDocument(
  options: CreateDetachedRenderDocumentOptions,
): DetachedRenderDocument {
  const prepared = inspectProjectRenderInputs(options.projectData);
  return parseSupported(detachedRenderDocumentSchema, {
    version: 1, renderer: { contract: RENDER_CONTRACT },
    geometry: options.geometry, encoding: options.encoding,
    fps: prepared.fps, durationTicks: prepared.durationTicks,
    tracks: prepared.tracks, clips: prepared.clips, assets: prepared.dependencies,
  }, "document");
}
