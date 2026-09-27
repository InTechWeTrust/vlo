import type { Asset } from "../../../types/Asset";
import type { BaseClip, ClipType } from "../../../types/TimelineTypes";
import { getProjectDimensions } from "../../renderer/utils/dimensions";
import { useProjectStore } from "../../project/useProjectStore";
import {
  deriveClipTransformsFromAsset,
  deriveExtractedAudioClipState,
  type MetadataPlacement,
} from "./metadataTransforms";
import { durationSecondsToTicks } from "./assetDuration";

export interface CreateClipFromAssetOptions {
  /** Defaults to "applied"; see {@link MetadataPlacement}. */
  metadataPlacement?: MetadataPlacement;
}

export const createClipFromAsset = (
  asset: Asset,
  { metadataPlacement = "applied" }: CreateClipFromAssetOptions = {},
): BaseClip => {
  if (asset.type === "lut") {
    throw new Error("LUT assets cannot be placed on the timeline");
  }
  // The remaining asset types ("video" | "image" | "audio") match a ClipType subset
  const type: ClipType = asset.type;
  const isImage = asset.type === "image";
  const hasFiniteDuration =
    typeof asset.duration === "number" &&
    Number.isFinite(asset.duration) &&
    asset.duration > 0;

  // Still images use a default duration, but timed media should rely on real metadata.
  const durationSeconds = hasFiniteDuration
    ? (asset.duration ?? 0)
    : isImage
      ? 5
      : 0;
  const durationTicks = durationSecondsToTicks(durationSeconds) ?? 0;
  const { aspectRatio } = useProjectStore.getState().config;
  const metadataClipState =
    asset.type === "audio"
      ? deriveExtractedAudioClipState(asset, durationTicks)
      : null;
  const transformations =
    metadataClipState?.transformations ??
    deriveClipTransformsFromAsset(asset, {
      logicalContainerSize: getProjectDimensions(aspectRatio),
      metadataPlacement,
    });

  return {
    id: `clip_${crypto.randomUUID()}`,
    type,
    name: asset.name,
    assetId: asset.id,
    sourceDuration: isImage ? null : durationTicks,
    timelineDuration: metadataClipState?.timelineDuration ?? durationTicks,
    croppedSourceDuration:
      metadataClipState?.croppedSourceDuration ?? durationTicks,
    offset: metadataClipState?.offset ?? 0,
    transformations,
    transformedDuration:
      metadataClipState?.transformedDuration ?? durationTicks,
    transformedOffset: metadataClipState?.transformedOffset ?? 0,
  };
};
