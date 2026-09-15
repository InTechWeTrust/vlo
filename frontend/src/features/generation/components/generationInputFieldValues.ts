import { mediaInputThumbnail } from "../utils/mediaInputThumbnail";
import type { Asset, AssetType } from "../../../types/Asset";
import { resolveAssetType } from "../../../shared/utils/assetTypeDetection";
import type { AssetDropSlotValue } from "../../panelUI";
import {
  canDropAssetOnAudioSlot,
  isAudioSlotVideoAsset,
} from "../utils/audioSlotAssets";
import type { GenerationMediaInputValue, WorkflowInput } from "../types";

/**
 * Value and accept-type derivations for a rendered generation input.
 *
 * Split from the field components because a module exporting both components
 * and helpers loses Fast Refresh for the whole file — every edit to a helper
 * would remount the panel being edited.
 */

/** A workflow input that carries media rather than text. */
export type MediaWorkflowInput = WorkflowInput & {
  inputType: "image" | "video" | "audio";
};

export function isMediaWorkflowInput(input: WorkflowInput): input is MediaWorkflowInput {
  return (
    input.inputType === "image" ||
    input.inputType === "video" ||
    input.inputType === "audio"
  );
}

export function toSlotValue(
  value: GenerationMediaInputValue | null | undefined,
  inputType?: WorkflowInput["inputType"],
): AssetDropSlotValue | null {
  if (!value) return null;

  if (value.kind === "asset") {
    const assetType = resolveAssetType(value.asset) ?? value.asset.type;
    // A video filling an audio slot presents as the audio it will contribute.
    const isExtractedAudio =
      inputType === "audio" && isAudioSlotVideoAsset(value.asset);
    const status = value.isExtracting
      ? ("preparing" as const)
      : value.extractionError
        ? ("error" as const)
        : undefined;
    return {
      type: isExtractedAudio ? "audio" : assetType,
      name: value.asset.name,
      thumbnail: mediaInputThumbnail(value, inputType),
      ...(status ? { status } : {}),
      ...(status === "preparing"
        ? { statusMessage: "Extracting audio…" }
        : status === "error"
          ? { statusMessage: value.extractionError ?? "Extraction failed" }
          : {}),
    };
  }

  if (value.kind === "frame") {
    return {
      type: "image",
      name: value.file.name,
      thumbnail: mediaInputThumbnail(value, inputType),
    };
  }

  // A confirmed selection lands in the store long before its video or audio
  // has been rendered out of the timeline, so the slot has to say so; without
  // this a finished-looking thumbnail sits there for the seconds the render
  // takes.
  const selectionStatus = value.isExtracting
    ? ("preparing" as const)
    : value.extractionError
      ? ("error" as const)
      : undefined;
  return {
    type: value.mediaType,
    name: `Timeline selection (${value.timelineSelection.start}-${value.timelineSelection.end ?? value.timelineSelection.start})`,
    ...(value.mediaType === "video" && !selectionStatus
      ? { thumbnail: mediaInputThumbnail(value, inputType) }
      : {}),
    ...(selectionStatus ? { status: selectionStatus } : {}),
    ...(selectionStatus === "preparing"
      ? { statusMessage: PREPARING_MESSAGE[value.mediaType] }
      : selectionStatus === "error"
        ? { statusMessage: value.extractionError ?? "Extraction failed" }
        : {}),
  };
}

const PREPARING_MESSAGE: Record<"image" | "video" | "audio", string> = {
  image: "Capturing frame…",
  video: "Rendering timeline video…",
  audio: "Extracting audio…",
};

/**
 * The slot's appearance while its value is being produced. Applies to both
 * halves of that wait: before a value exists at all (the marker in
 * {@link useMediaInputPreparationStore}) and after one lands still extracting.
 */
export function toPreparingSlotValue(
  base: AssetDropSlotValue | null,
  inputType: "image" | "video" | "audio",
): AssetDropSlotValue {
  const statusMessage = PREPARING_MESSAGE[inputType];
  return base
    ? { ...base, thumbnail: undefined, status: "preparing", statusMessage }
    : {
        type: inputType,
        name: statusMessage,
        status: "preparing",
        statusMessage,
      };
}

/**
 * Whether a filled slot can be opened in the mini editor. Every video value
 * can: even a plain asset is croppable through a synthetic bake. An audio slot
 * needs media that is actually in hand — a video dropped on one is editable
 * only once its track has been pulled out, and a selection only once its audio
 * has been rendered.
 */
export function canEditMediaValue(
  value: GenerationMediaInputValue | null | undefined,
  inputType: "image" | "video" | "audio",
): boolean {
  if (!value) return false;
  if (inputType === "video") return true;
  if (inputType !== "audio") return false;

  if (value.kind === "asset") {
    if (value.isExtracting) return false;
    return isAudioSlotVideoAsset(value.asset)
      ? value.extractedAudioFile != null
      : true;
  }
  // A selection whose render failed still has its clips, and the editor
  // re-renders from those — so a failed extraction stays recoverable. A trim
  // has no clips, so it is only openable while its file is in hand.
  return (
    value.kind === "timelineSelection" &&
    value.mediaType === "audio" &&
    !value.isExtracting &&
    (value.preparedAudioFile != null ||
      value.timelineSelection.clips.length > 0)
  );
}

/** Media-specific drop allowances beyond the slot's eventual output type. */
export function acceptAssetForInputType(
  inputType: WorkflowInput["inputType"],
): ((asset: Asset) => boolean) | undefined {
  if (inputType === "audio") return canDropAssetOnAudioSlot;
  if (inputType === "image") {
    return (asset) => resolveAssetType(asset) === "video";
  }
  return undefined;
}

/** External video files can be inspected after drop for audio or a still frame. */
export function resolveExternalAcceptTypes(
  inputType: WorkflowInput["inputType"],
): AssetType[] {
  const accept = resolveAcceptTypes(inputType);
  return inputType === "audio" || inputType === "image"
    ? [...accept, "video"]
    : [...accept];
}

export function resolveAcceptTypes(
  inputType: WorkflowInput["inputType"],
) {
  switch (inputType) {
    case "image":
      return ["image" as const];
    case "audio":
      return ["audio" as const];
    case "video":
      return ["video" as const];
    default:
      return [];
  }
}

