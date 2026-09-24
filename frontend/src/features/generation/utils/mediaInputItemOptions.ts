import type { GenerationMediaInputValue, WorkflowInput } from "../types";
import { isVideoAssetWithAudio } from "./audioSlotAssets";

/**
 * Per-item switches live on the media input value, which is a union: only the
 * kinds that can deliver a soundtrack carry the flag. These readers keep every
 * caller from re-deriving that narrowing.
 */
export function readIncludeEmbeddedAudio(
  value: GenerationMediaInputValue,
): boolean {
  if (value.kind === "asset") return value.includeEmbeddedAudio === true;
  return (
    value.kind === "timelineSelection" &&
    value.mediaType === "video" &&
    value.includeEmbeddedAudio === true
  );
}

/**
 * Whether a batch video item can offer the audio switch at all. A library
 * asset knows whether it has a soundtrack; a timeline selection is rendered
 * with its included tracks, so it stays capable until it is prepared.
 */
export function canValueCarryAudio(value: GenerationMediaInputValue): boolean {
  if (value.kind === "asset") return isVideoAssetWithAudio(value.asset);
  return value.kind === "timelineSelection" && value.mediaType === "video";
}

/**
 * The switches a newly attached item starts with: a reference video delivers
 * its own soundtrack until the user mutes it. The default is written onto the
 * value rather than read from an absent flag, because saved panels and
 * generation metadata already record "muted" as absence.
 */
export function withDefaultItemOptions(
  input: Pick<WorkflowInput, "inputType" | "presentation">,
  value: GenerationMediaInputValue,
): GenerationMediaInputValue {
  if (
    input.inputType !== "video" ||
    input.presentation?.repeatable?.itemOptions?.includes("audio") !== true ||
    !canValueCarryAudio(value) ||
    value.kind === "frame" ||
    (value.kind === "timelineSelection" && value.mediaType !== "video") ||
    typeof value.includeEmbeddedAudio === "boolean"
  ) {
    return value;
  }
  return { ...value, includeEmbeddedAudio: true };
}
