import type { GeneratedMiniEditorEdit } from "../../../types/Asset";
import type { MiniEditorEditSpec, ResolvedEditorSource } from "../../miniEditor";
import {
  captureVideoFrameFile,
  probeVideoDurationTicks,
} from "../../../core/media";
import { mediaSecondsToTick, tickToMediaSeconds } from "../../../core/time";
import { getAssetById } from "../../userAssets/api";
import type { DerivedMaskMapping } from "../pipeline/types";
import { resolveAssetFileForGeneration } from "../utils/mediaInputAssets";
import {
  createAudioSelectionPlaceholderFile,
  extractAudioFromVideo,
  trimAudioFile,
} from "../utils/manualSlotMedia";
import {
  getDerivedMaskRenderKey,
  pickPrimaryPreparedMaskFile,
} from "../utils/inputSelection";
import { renderSyntheticEditedOutputs } from "../utils/miniEditorEdit";
import { buildDerivedMaskRenderSignature } from "../utils/derivedMaskRenderSignature";

/** Save and metadata replay use the same video/matte bake and cache contract. */
export async function bakeMiniEditorVideo(
  spec: MiniEditorEditSpec,
  source: ResolvedEditorSource,
  render: NonNullable<GeneratedMiniEditorEdit["render"]>,
  mappings: DerivedMaskMapping[],
) {
  const visualMasks = mappings.filter(
    (mapping) => mapping.purpose !== "audio_timing",
  );
  const maskRequests = visualMasks.map((mapping) => {
    const key = getDerivedMaskRenderKey(mapping);
    return {
      key,
      maskType: key === "video_soft" ? ("soft" as const) : ("binary" as const),
      sourceVideoTreatment: mapping.sourceVideoTreatment,
    };
  });
  const { video, masks, maskContentByKey } = await renderSyntheticEditedOutputs(
    spec,
    source,
    render,
    { maskRequests },
  );
  return {
    preparedVideoFile: video,
    preparedMaskFile: pickPrimaryPreparedMaskFile(visualMasks, masks),
    preparedMasksByKey: masks,
    preparedMaskContentByKey: maskContentByKey,
    preparedDerivedMaskSignature: buildDerivedMaskRenderSignature(visualMasks),
  };
}

export async function replayMiniEditorAssetEdit(
  edit: GeneratedMiniEditorEdit,
  mediaType: "audio" | "video",
  mappings: DerivedMaskMapping[],
) {
  const asset = edit.assetId ? getAssetById(edit.assetId) : undefined;
  if (!asset) {
    throw new Error(
      "The mini editor's source asset is missing. Restore the source asset to replay this edit.",
    );
  }
  if (asset.type !== "video" && !(mediaType === "audio" && asset.type === "audio")) {
    throw new Error(
      "The mini editor's source asset has an incompatible media type.",
    );
  }
  const file = await resolveAssetFileForGeneration(asset);
  if (mediaType === "audio") {
    // An audio slot first extracts a dropped video's soundtrack, then the
    // mini editor trims that WAV. Replay follows the same conversion order.
    const audioFile =
      asset.type === "video" ? await extractAudioFromVideo(file) : file;
    if (!audioFile) {
      throw new Error("The saved mini editor source has no extractable audio.");
    }
    const preparedAudioFile = await trimAudioFile(
      audioFile,
      edit.spec.cropStartTicks,
      edit.spec.cropEndTicks,
    );
    if (!preparedAudioFile) {
      throw new Error("The saved mini editor range has no extractable audio.");
    }
    return {
      thumbnailFile: createAudioSelectionPlaceholderFile(),
      preparedAudioFile,
    };
  }
  if (!edit.render) {
    throw new Error("The saved mini editor edit is missing its render settings.");
  }

  const sourceUrl = URL.createObjectURL(file);
  try {
    const source: ResolvedEditorSource = {
      assetId: asset.id,
      sourceUrl,
      sourceFile: file,
      durationTicks:
        asset.duration && asset.duration > 0
          ? mediaSecondsToTick(asset.duration)
          : await probeVideoDurationTicks(sourceUrl),
      fps: asset.fps,
    };
    const thumbnailFile = await captureVideoFrameFile(
      sourceUrl,
      tickToMediaSeconds(edit.spec.cropStartTicks),
      "mini-editor-replay.png",
    );
    return {
      thumbnailFile,
      ...await bakeMiniEditorVideo(edit.spec, source, edit.render, mappings),
    };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
