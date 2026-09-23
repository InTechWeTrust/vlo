import type { Asset, MaskCropMetadata } from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import type { AspectRatioProcessingMetadata } from "../types";
import type { DerivedMaskSourceVideoTreatment } from "../pipeline/types";
import type { ProcessingWarning } from "../processing";

export interface IframeTimelineSelectionSettings {
  aspectRatio: {
    enabled: boolean;
    targetAspectRatio: string;
    targetResolution: number;
    stride: number;
    searchSteps: number;
  };
  maskCrop: {
    mode: "full" | "crop";
    dilation: number;
  };
  /**
   * How masks treat the source video. `remove_transparency` matches the
   * generation panel's default: the video is rendered without masks and the
   * mask travels only as the separate matte. `preserve_transparency` renders
   * the masked composite, which an MP4 flattens to black where it is
   * transparent.
   */
  sourceVideoTreatment: DerivedMaskSourceVideoTreatment;
}

export type IframeTemporaryAssetRole = "video" | "mask" | "image";

export interface IframeTemporaryAsset {
  asset: Asset;
  role: IframeTemporaryAssetRole;
  selectionId: string;
  timelineSelection: TimelineSelection;
  maskCropMetadata: MaskCropMetadata;
  aspectRatioProcessing: AspectRatioProcessingMetadata | null;
}

export interface ProcessedIframeTimelineSelection {
  timelineSelection: TimelineSelection;
  video: File;
  mask: File | null;
  /** Thumbnail captured from the timeline frame (the video's poster). */
  thumbnail: File;
  /**
   * Thumbnail captured from the rendered mask matte itself, so the mask card
   * shows the black/white matte rather than reusing the video's frame. Null
   * whenever there is no mask.
   */
  maskThumbnail: File | null;
  aspectRatioProcessing: AspectRatioProcessingMetadata | null;
  maskCropMetadata: MaskCropMetadata;
  warnings: ProcessingWarning[];
}

/**
 * A single frame captured from the timeline. The PNG is the same composite the
 * generation panel hands an image slot, transparency included, so it can stand
 * in for that input when a workflow is run directly in the ComfyUI editor.
 */
export interface ProcessedIframeTimelineFrame {
  /** Point selection at the captured tick. */
  timelineSelection: TimelineSelection;
  image: File;
}

export interface StoredIframeTimelineFrame {
  selectionId: string;
  imageAsset: IframeTemporaryAsset;
}

export interface StoredIframeTimelineSelection {
  selectionId: string;
  videoAsset: IframeTemporaryAsset;
  maskAsset: IframeTemporaryAsset | null;
}
