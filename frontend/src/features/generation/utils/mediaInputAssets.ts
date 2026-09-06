import type { Asset } from "../../../types/Asset";
import { assetMatchesType } from "../../../shared/utils/assetTypeDetection";
import type { GenerationMediaInputValue } from "../types";
import { ensureAssetFileLoaded } from "../../userAssets";
import {
  canDropAssetOnAudioSlot,
  isAudioSlotVideoAsset,
  type AudioSlotAssetCandidate,
} from "./audioSlotAssets";

function fallbackMimeTypeForAssetType(assetType: Asset["type"]): string {
  if (assetType === "image") {
    return "image/png";
  }
  if (assetType === "audio") {
    return "audio/wav";
  }
  if (assetType === "video") {
    return "video/mp4";
  }
  return "application/octet-stream";
}

export function hasProvidedMediaInputValue(
  inputType: "image" | "video" | "audio",
  value: GenerationMediaInputValue | null | undefined,
): boolean {
  if (!value) return false;

  if (value.kind === "asset") {
    if (assetMatchesType(value.asset, inputType)) return true;
    if (inputType === "audio" && isAudioSlotVideoAsset(value.asset)) {
      return !value.isExtracting && value.extractedAudioFile != null;
    }
    return false;
  }

  if (inputType === "image") {
    return value.kind === "frame";
  }

  if (inputType === "audio") {
    return (
      value.kind === "timelineSelection" &&
      value.mediaType === "audio" &&
      value.preparedAudioFile !== null &&
      !value.isExtracting
    );
  }

  if (
    value.kind !== "timelineSelection" ||
    value.mediaType !== "video"
  ) {
    return false;
  }
  if (value.extractionError) return false;
  return value.isExtracting || value.preparedVideoFile !== null;
}

export async function resolveAssetFileForGeneration(
  asset: Pick<Asset, "id" | "file" | "src" | "name" | "type">,
): Promise<File> {
  if (asset.file) {
    return asset.file;
  }

  const hydratedFile = await ensureAssetFileLoaded(asset.id);
  if (hydratedFile) {
    return hydratedFile;
  }

  const response = await fetch(asset.src);
  if (!response.ok) {
    throw new Error(`Failed to fetch generation asset file (${response.status})`);
  }

  const blob = await response.blob();
  return new File([blob], asset.name, {
    type: blob.type || fallbackMimeTypeForAssetType(asset.type),
    lastModified: Date.now(),
  });
}

/**
 * May this library asset be attached to a media input *as an asset*?
 *
 * The rule a library drag applies, restated for callers that have an asset id
 * rather than a drag: an audio slot takes audio or a video that really carries
 * a soundtrack (`hasAudio` is known for a library asset, so a silent one is
 * refused up front), and every other slot takes its own media type.
 *
 * Narrower than the drop target in one place, on purpose: dragging a video
 * onto an *image* slot opens the frame chooser and stores the captured still,
 * not the asset. A caller with only an id has no frame to choose, so it cannot
 * reach that path and must be told so rather than silently attaching a video.
 */
export function canAttachAssetToMediaInput(
  inputType: "text" | "image" | "video" | "audio",
  asset: AudioSlotAssetCandidate,
): boolean {
  if (inputType === "audio") return canDropAssetOnAudioSlot(asset);
  if (inputType === "text") return false;
  return assetMatchesType(asset, inputType);
}
