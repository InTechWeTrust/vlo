import type { Asset } from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import type { GenerationMediaInputValue } from "../types";
import type { GenerationWorkflowState } from "../store/types";
import { isAudioSlotVideoAsset } from "./audioSlotAssets";
import { extractAudioFromVideo } from "./manualSlotMedia";
import { resolveAssetFileForGeneration } from "./mediaInputAssets";

export const NO_ASSET_AUDIO_TRACK_MESSAGE =
  "No audio track was found in this video";

type SetMediaInputAsset = GenerationWorkflowState["setMediaInputAsset"];
type SetMediaInputTimelineSelection =
  GenerationWorkflowState["setMediaInputTimelineSelection"];

/**
 * True while `value` is still the extraction this request started: the same
 * slot, the same asset, the same request id, still marked extracting. Anything
 * else means the user has since replaced, cleared, or moved the value, and the
 * result must be dropped rather than written back.
 */
export function isAssetSlotExtractionCurrent(
  value: GenerationMediaInputValue | null | undefined,
  assetId: string,
  extractionRequestId: number,
): boolean {
  return (
    value?.kind === "asset" &&
    value.asset.id === assetId &&
    value.isExtracting === true &&
    (value.extractionRequestId ?? 0) === extractionRequestId
  );
}

/**
 * Finds slots left holding a value that is marked extracting but whose
 * extraction no longer belongs to them — the state a value lands in when a
 * reorder or a repeatable-slot clear moves it while its extraction is still
 * running. Those need restarting where the value came to rest, or they stay
 * "extracting" forever.
 */
export function collectStalledAudioExtractions(
  inputIds: readonly string[],
  getSlotValue: (inputId: string) => GenerationMediaInputValue | null,
): Array<{ inputId: string; asset: Asset }> {
  const stalled: Array<{ inputId: string; asset: Asset }> = [];

  for (const inputId of new Set(inputIds)) {
    const value = getSlotValue(inputId);
    if (value?.kind === "asset" && value.isExtracting) {
      stalled.push({ inputId, asset: value.asset });
    }
  }

  return stalled;
}

/**
 * The same problem for timeline selections: a render in flight belongs to the
 * slot it started in, so a clear or a reorder that shifts the value strands it
 * marked extracting. Unlike the asset case the caller owns the restart — a
 * selection render needs the panel's workflow context — so this only reports
 * which slots need one.
 */
export function collectStalledSelectionExtractions(
  inputIds: readonly string[],
  getSlotValue: (inputId: string) => GenerationMediaInputValue | null,
): Array<{
  inputId: string;
  value: Extract<GenerationMediaInputValue, { kind: "timelineSelection" }>;
}> {
  const stalled: Array<{
    inputId: string;
    value: Extract<GenerationMediaInputValue, { kind: "timelineSelection" }>;
  }> = [];

  for (const inputId of new Set(inputIds)) {
    const value = getSlotValue(inputId);
    if (value?.kind === "timelineSelection" && value.isExtracting) {
      stalled.push({ inputId, value });
    }
  }

  return stalled;
}

export interface FailedSelectionExtractionOptions {
  inputId: string;
  timelineSelection: TimelineSelection;
  thumbnailFile: File;
  extractionRequestId: number;
  mediaType: "video" | "audio";
  /** Used when the failure carries no message of its own. */
  fallbackMessage: string;
  setMediaInputTimelineSelection: SetMediaInputTimelineSelection;
  selectionExtractionRequestIdsRef: { current: Record<string, number> };
}

/**
 * Writes a thrown selection render back onto its slot as a failure. Nothing
 * settles a slot once the render that owns it throws, and one left marked
 * extracting stays busy for good — refusing generation and a second attempt at
 * editing alike. A failure that no longer belongs to the slot is dropped,
 * exactly as a successful render would be.
 */
export function settleFailedSelectionExtraction(
  options: FailedSelectionExtractionOptions,
  error: unknown,
): void {
  const { extractionRequestId, inputId } = options;
  if (
    options.selectionExtractionRequestIdsRef.current[inputId] !==
    extractionRequestId
  ) {
    return;
  }

  options.setMediaInputTimelineSelection(
    inputId,
    options.timelineSelection,
    options.thumbnailFile,
    {
      mediaType: options.mediaType,
      isExtracting: false,
      extractionRequestId,
      ...(options.mediaType === "audio"
        ? { preparedAudioFile: null }
        : { preparedVideoFile: null }),
      extractionError:
        error instanceof Error && error.message
          ? error.message
          : options.fallbackMessage,
    },
  );
}

interface AudioAssetExtractionOptions {
  inputId: string;
  asset: Asset;
  extractionRequestId: number;
  setMediaInputAsset: SetMediaInputAsset;
  /**
   * Returns false once a newer drop has superseded this one, so a slow
   * extraction never overwrites the slot's current value.
   */
  isCurrentRequest?: () => boolean;
}

/**
 * Pulls the audio track out of a video asset that was dropped on an audio
 * slot, writing the result (or the failure) back into the slot. Assumes the
 * slot has already been put into its extracting state.
 */
export async function extractAudioForAssetSlot({
  inputId,
  asset,
  extractionRequestId,
  setMediaInputAsset,
  isCurrentRequest,
}: AudioAssetExtractionOptions): Promise<void> {
  const stillCurrent = () => isCurrentRequest?.() !== false;

  try {
    const sourceFile = await resolveAssetFileForGeneration(asset);
    const extractedAudioFile = await extractAudioFromVideo(sourceFile);
    if (!stillCurrent()) return;
    setMediaInputAsset(inputId, asset, {
      isExtracting: false,
      extractionRequestId,
      extractedAudioFile,
      extractionError:
        extractedAudioFile === null ? NO_ASSET_AUDIO_TRACK_MESSAGE : null,
    });
  } catch (error) {
    console.error("Failed to extract audio from generation asset input", error);
    if (!stillCurrent()) return;
    setMediaInputAsset(inputId, asset, {
      isExtracting: false,
      extractionRequestId,
      extractedAudioFile: null,
      extractionError:
        error instanceof Error
          ? error.message
          : "Failed to extract audio from this video",
    });
  }
}

/**
 * Fills an audio slot with `asset`. Audio assets land directly; a video asset
 * lands in its extracting state and its audio track is pulled in the
 * background. Returns the extraction promise when one was started.
 */
export function fillAudioSlotWithAsset({
  inputId,
  asset,
  extractionRequestId,
  setMediaInputAsset,
  isCurrentRequest,
}: AudioAssetExtractionOptions): Promise<void> | null {
  if (!isAudioSlotVideoAsset(asset)) {
    setMediaInputAsset(inputId, asset);
    return null;
  }

  setMediaInputAsset(inputId, asset, {
    isExtracting: true,
    extractionRequestId,
  });

  return extractAudioForAssetSlot({
    inputId,
    asset,
    extractionRequestId,
    setMediaInputAsset,
    isCurrentRequest,
  });
}
