import { buildGenerationMediaItem } from "./generationMediaSnapshot";
import { withDefaultItemOptions } from "./mediaInputItemOptions";
import type {
  GenerationInputSnapshot,
  GenerationMediaItemSnapshot,
} from "../services/generationSessionTypes";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import type { GenerationWorkflowState } from "../store/types";
import type { GenerationMediaInputValue } from "../types";

/** In-memory capture data. Preview URLs belong to each holder, never to the payload. */
export type GenerationCapturedMedia =
  | {
      readonly kind: "frame";
      readonly file: File;
      readonly timelineSelection: TimelineSelection;
    }
  | {
      readonly kind: "timelineSelection";
      readonly timelineSelection: TimelineSelection;
      readonly thumbnailFile: File;
      readonly options?: Parameters<GenerationWorkflowState["setMediaInputTimelineSelection"]>[3];
    };

/** Same native value for the panel and a held draft, with independently owned previews. */
export function createCapturedMediaValue(
  capture: GenerationCapturedMedia,
  previewUrl: string,
): Exclude<GenerationMediaInputValue, { kind: "asset" }> {
  if (capture.kind === "frame") return { ...capture, previewUrl };
  const { timelineSelection, thumbnailFile, options } = capture;
  const shared = {
    kind: "timelineSelection" as const,
    timelineSelection,
    thumbnailFile,
    thumbnailUrl: previewUrl,
    isExtracting: options?.isExtracting ?? false,
    extractionRequestId: options?.extractionRequestId ?? 0,
    bakedEdit: options?.bakedEdit ?? null,
    ...(options?.itemId ? { itemId: options.itemId } : {}),
    extractionError: options?.extractionError ?? null,
  };
  return options?.mediaType === "audio"
    ? { ...shared, mediaType: "audio", preparedAudioFile: options.preparedAudioFile ?? null }
    : {
        ...shared,
        mediaType: "video",
        preparedVideoFile: options?.preparedVideoFile ?? null,
        preparedMaskFile: options?.preparedMaskFile ?? null,
        preparedMasksByKey: options?.preparedMasksByKey ?? null,
        preparedMaskContentByKey: options?.preparedMaskContentByKey ?? null,
        preparedDerivedMaskSignature: options?.preparedDerivedMaskSignature ?? null,
        ...(typeof options?.includeEmbeddedAudio === "boolean"
          ? { includeEmbeddedAudio: options.includeEmbeddedAudio }
          : {}),
      };
}

/** Detach mutable selection settings while retaining immutable File contents. */
export function copyCapturedMedia(capture: GenerationCapturedMedia): GenerationCapturedMedia {
  const timelineSelection = structuredClone(capture.timelineSelection);
  if (capture.kind === "frame") return { ...capture, timelineSelection };
  const options = capture.options;
  return {
    ...capture,
    timelineSelection,
    options: options ? {
      ...options,
      bakedEdit: options.bakedEdit ? structuredClone(options.bakedEdit) : options.bakedEdit,
      preparedMasksByKey: options.preparedMasksByKey ? { ...options.preparedMasksByKey } : options.preparedMasksByKey,
      preparedMaskContentByKey: options.preparedMaskContentByKey ? { ...options.preparedMaskContentByKey } : options.preparedMaskContentByKey,
    } : undefined,
  };
}

export function describeCapturedMedia(
  input: GenerationInputSnapshot,
  capture: GenerationCapturedMedia,
  previewUrl = "",
): GenerationMediaItemSnapshot {
  const workflowInput = {
    inputType: input.inputType,
    presentation: input.repeatable ? {
      repeatable: {
        max: input.repeatable.max,
        itemOptions: input.repeatable.optionIds.filter((id): id is "audio" => id === "audio"),
      },
    } : undefined,
  };
  // With the defaults the store applies on attach, so a staged capture shows
  // the switches it will commit with.
  return buildGenerationMediaItem(
    workflowInput,
    withDefaultItemOptions(workflowInput, createCapturedMediaValue(capture, previewUrl)),
    "",
    0,
  );
}
