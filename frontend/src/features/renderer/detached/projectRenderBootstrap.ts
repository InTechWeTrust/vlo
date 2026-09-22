import type { Asset } from "../../../types/Asset";
import type {
  ClipTransform,
  TimelineClip,
  TimelineTrack,
} from "../../../types/TimelineTypes";
import { getEntryForTransform } from "../../transformations/catalogue/TransformationRegistry";
import {
  detachedRenderDocumentSchema,
  RENDER_CONTRACT,
  type DetachedRenderAsset,
  type DetachedRenderDocument,
} from "../schemas/projectRenderSnapshot";
import type { ExportConfig, ProjectData } from "../services/ExportRenderer";
import type { OutputVideoFormat } from "../services/TextureOutputEncoder";

/** Everything a detached render host needs to run the editor's project export. */
export interface DetachedProjectRender {
  document: DetachedRenderDocument;
  /** Geometry only: the host attaches its own output target. */
  exportConfig: Pick<
    ExportConfig,
    | "logicalWidth"
    | "logicalHeight"
    | "outputWidth"
    | "outputHeight"
    | "backgroundAlpha"
  >;
  projectData: ProjectData;
  format: OutputVideoFormat;
  keyFrameInterval: number;
  includeAudio: boolean;
}

export class DetachedRenderBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetachedRenderBootstrapError";
  }
}

/**
 * Turns a detached render document into the inputs the editor's own project
 * export takes, with nothing read from a live editor.
 *
 * The editor validated this document when it captured it. It is parsed again
 * here because this is the side that has to be right: a field this realm does
 * not understand would otherwise be rendered as if absent. Every transform is
 * then resolved against the built-in catalogue, so a missing provider fails
 * before the first frame rather than rendering without it.
 *
 * `resolveAssetSource` binds each asset to a source the host owns (typically
 * an object URL over a file handed across), so the render never reads an
 * editor URL that could be revoked or re-pointed.
 */
export function bootstrapProjectRender(
  input: unknown,
  resolveAssetSource: (asset: DetachedRenderAsset) => string,
): DetachedProjectRender {
  const parsed = detachedRenderDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new DetachedRenderBootstrapError(
      `The render document is not a valid ${RENDER_CONTRACT} document: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const document = parsed.data;

  // Parsed values are structurally the editor's own types, narrowed. Cast once
  // here rather than letting the looser editor types flow back into the parse.
  const clips = document.clips as unknown as TimelineClip[];
  for (const clip of document.clips) {
    const compositionTransforms = clip.type === "mask" || clip.type === "adjustment" ? []
      : clip.components.flatMap((component) =>
        component.type === "mask_composition" ? component.parameters.compositeTransformations : []);
    for (const transform of [...clip.transformations, ...compositionTransforms] as ClipTransform[]) {
      if (!getEntryForTransform(transform)) {
        throw new DetachedRenderBootstrapError(
          `No renderer is available for transform '${transform.type}' on clip '${clip.id}'.`,
        );
      }
    }
  }

  const assets: Asset[] = document.assets.map((asset) => ({
    id: asset.id,
    // Keys decode caches only. The document names assets by editor ID, and a
    // host binds one source per ID, so the ID identifies the content.
    hash: asset.id,
    name: asset.name,
    type: asset.type,
    src: resolveAssetSource(asset),
    createdAt: 0,
    // An editor still image or LUT has no duration at all, not a null one.
    ...(asset.duration !== null ? { duration: asset.duration } : {}),
    ...(asset.fps !== null ? { fps: asset.fps } : {}),
  }));

  const { geometry, encoding } = document;
  return {
    document,
    exportConfig: {
      logicalWidth: geometry.logicalWidth,
      logicalHeight: geometry.logicalHeight,
      outputWidth: geometry.outputWidth,
      outputHeight: geometry.outputHeight,
      backgroundAlpha: geometry.backgroundAlpha,
    },
    projectData: {
      tracks: document.tracks as TimelineTrack[],
      clips,
      transitions: [],
      assets,
      // Already whole frames: capture rounds the timeline up exactly as the
      // renderer would, so the two agree on the last frame.
      duration: document.durationTicks,
      fps: document.fps,
    },
    format: encoding.format,
    keyFrameInterval: encoding.keyFrameInterval,
    includeAudio: encoding.includeAudio,
  };
}
