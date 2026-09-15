import type { GenerationMediaInputValue, WorkflowInput } from "../types";
import { resolveAssetType } from "../../../shared/utils/assetTypeDetection";

/** Native slots and detached snapshots share the existing preview's lifetime. */
export function mediaInputThumbnail(value: GenerationMediaInputValue, inputType?: WorkflowInput["inputType"]): string | undefined {
  if (inputType === "audio") return undefined;
  if (value.kind === "frame") return value.previewUrl;
  if (value.isExtracting || value.extractionError) return undefined;
  if (value.kind === "timelineSelection") return value.mediaType === "video" ? value.thumbnailUrl : undefined;
  return value.asset.thumbnail || ((resolveAssetType(value.asset) ?? value.asset.type) === "image" ? value.asset.src : undefined);
}
