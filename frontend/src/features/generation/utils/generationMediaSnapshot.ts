import { mediaInputThumbnail } from "./mediaInputThumbnail";
import {
  assetMatchesType,
  resolveAssetType,
} from "../../../shared/utils/assetTypeDetection";
import { isAudioSlotVideoAsset } from "./audioSlotAssets";
import {
  canValueCarryAudio,
  readIncludeEmbeddedAudio,
} from "./mediaInputItemOptions";
import { readMediaItemId } from "./mediaItemIds";
import {
  buildRepeatableInputSlotId,
  getWorkflowInputSlotValue,
} from "./workflowInputs";
import type {
  GenerationMediaItemSnapshot,
  GenerationMediaItemSource,
} from "../services/generationSessionTypes";
import type { GenerationMediaInputValue, WorkflowInput } from "../types";

/**
 * Reads a media input's occupied slots as ordered, detached items
 * (docs/minimax-prompt-composer-extension-plan.md §4, 1A).
 *
 * Owner-neutral: the panel's own batch strip and the SDK projection describe
 * the same slots by the same rules, so a consumer counting delivery positions
 * counts what `_apply_batch_memory_loader_injections` and ComfyUI's `Autogrow`
 * expansion will see. Every derivation here — which slot is occupied, what a
 * value presents as, whether it can carry the audio switch — is the panel's,
 * reused rather than restated.
 */

/** How many slots one repeatable input may hold, matching the panel's clamp. */
function resolveMax(input: WorkflowInput): number {
  return Math.max(1, Math.floor(input.presentation?.repeatable?.max ?? 1));
}

function resolveSource(value: GenerationMediaInputValue): GenerationMediaItemSource {
  if (value.kind === "asset") return "asset";
  return value.kind === "frame" ? "frame" : "timeline-selection";
}

/**
 * What the slot *delivers*, which is not always what the media is: a video
 * dropped on an audio slot contributes its soundtrack, and the panel already
 * presents it that way. Tag emission counts deliveries, so it reads this.
 */
function resolveMediaType(
  value: GenerationMediaInputValue,
  inputType: WorkflowInput["inputType"],
): GenerationMediaItemSnapshot["mediaType"] {
  if (value.kind === "frame") return "image";
  if (value.kind === "timelineSelection") return value.mediaType;
  if (inputType === "audio" && isAudioSlotVideoAsset(value.asset)) {
    return "audio";
  }
  const assetType = resolveAssetType(value.asset) ?? value.asset.type;
  return assetType === "video" || assetType === "audio" ? assetType : "image";
}

/**
 * Does this item really carry a soundtrack?
 *
 * `null` is not "no": it is the host declining to guess. A timeline selection
 * has not been rendered yet, and a video ingested before `hasAudio` was probed
 * never recorded one — both are the case where turning the audio switch on
 * produces no track and silently shifts every ordinal after it.
 */
function resolveHasAudio(value: GenerationMediaInputValue): boolean | null {
  if (value.kind === "frame") return false;
  if (value.kind === "timelineSelection") {
    return value.mediaType === "audio" ? true : null;
  }
  const { asset } = value;
  if (assetMatchesType(asset, "audio")) return true;
  if (assetMatchesType(asset, "video")) return asset.hasAudio ?? null;
  return false;
}

function resolveDisplayName(value: GenerationMediaInputValue): string {
  if (value.kind === "asset") return value.asset.name;
  if (value.kind === "frame") return value.file.name;
  const { start, end } = value.timelineSelection;
  return `Timeline selection (${start}-${end ?? start})`;
}

/**
 * The per-item switches this input offers *for this value*, with their current
 * state. Gated exactly as the batch strip gates the control it renders: the
 * rules have to declare the option, the input has to be a video input, and the
 * value has to be able to deliver a soundtrack at all.
 */
function resolveOptions(
  input: Pick<WorkflowInput, "inputType" | "presentation">,
  value: GenerationMediaInputValue,
): Readonly<Record<string, boolean>> {
  const itemOptions = input.presentation?.repeatable?.itemOptions;
  if (
    input.inputType !== "video" ||
    itemOptions?.includes("audio") !== true ||
    !canValueCarryAudio(value)
  ) {
    return Object.freeze({});
  }
  return Object.freeze({ audio: readIncludeEmbeddedAudio(value) });
}

/**
 * The occupied slots of one media input, in delivery order.
 *
 * A slot still being prepared *before its value exists* is deliberately absent:
 * it has no media to describe and the graph has nothing to deliver from it, so
 * publishing it would invent an ordinal that does not exist yet. A slot whose
 * value has landed but is still extracting is present and marked `preparing`.
 */
export function buildGenerationMediaItems(
  input: WorkflowInput,
  mediaInputs: Readonly<Record<string, GenerationMediaInputValue | null>>,
  inputLookup: ReadonlyMap<string, Pick<WorkflowInput, "id" | "nodeId" | "param">>,
  preparingInputIds: ReadonlySet<string>,
): readonly GenerationMediaItemSnapshot[] {
  if (input.inputType === "text") return [];

  const max = resolveMax(input);
  const items: GenerationMediaItemSnapshot[] = [];
  for (let index = 0; index < max; index += 1) {
    const slotId = buildRepeatableInputSlotId(input, index);
    const value = getWorkflowInputSlotValue(
      mediaInputs as Record<string, GenerationMediaInputValue | null>,
      input,
      index,
      inputLookup,
    );
    if (!value) continue;

    items.push(buildGenerationMediaItem(input, value, slotId, items.length, preparingInputIds.has(slotId)));
  }
  return items;
}

/**
 * Slots the panel is holding open for a value that does not exist yet.
 *
 * The batch strip counts these as taken when it picks where a drop lands
 * (`slotIdAt`), so anything else choosing a slot has to see them too — a
 * write that ignored them would land on a slot whose real value is seconds
 * away, and lose to it.
 */
export function buildReservedSlotIds(
  input: WorkflowInput,
  mediaInputs: Readonly<Record<string, GenerationMediaInputValue | null>>,
  inputLookup: ReadonlyMap<string, Pick<WorkflowInput, "id" | "nodeId" | "param">>,
  preparingInputIds: ReadonlySet<string>,
): readonly string[] {
  if (input.inputType === "text" || preparingInputIds.size === 0) return [];

  const reserved: string[] = [];
  for (let index = 0; index < resolveMax(input); index += 1) {
    const slotId = buildRepeatableInputSlotId(input, index);
    if (!preparingInputIds.has(slotId)) continue;
    // A slot whose value has landed is in `media` already, marked `preparing`.
    // Only the empty ones are reservations.
    const value = getWorkflowInputSlotValue(
      mediaInputs as Record<string, GenerationMediaInputValue | null>,
      input,
      index,
      inputLookup,
    );
    if (!value) reserved.push(slotId);
  }
  return reserved;
}

/** The repeatable descriptor for an input, or `undefined` when it is single. */
export function describeRepeatableInput(
  input: WorkflowInput,
): { readonly max: number; readonly optionIds: readonly string[] } | undefined {
  const repeatable = input.presentation?.repeatable;
  if (!repeatable?.max) return undefined;
  return {
    max: Math.max(1, Math.floor(repeatable.max)),
    optionIds:
      input.inputType === "video" ? (repeatable.itemOptions ?? []) : [],
  };
}

/** Shared value projection for committed inputs and in-memory draft captures. */
export function buildGenerationMediaItem(
  input: Pick<WorkflowInput, "inputType" | "presentation">,
  value: GenerationMediaInputValue,
  slotId: string,
  ordinal: number,
  preparing = false,
): GenerationMediaItemSnapshot {
  const thumbnail = mediaInputThumbnail(value, input.inputType);
  return Object.freeze({
    slotId,
    itemId: readMediaItemId(value),
    // Position among *filled* slots. The panel front-packs its batches, so
    // this normally equals the slot index; it is derived rather than
    // assumed so a transient gap cannot publish a wrong delivery position.
    ordinal,
    source: resolveSource(value),
    ...(value.kind === "asset" ? { assetId: value.asset.id } : {}),
    displayName: resolveDisplayName(value),
    ...(thumbnail ? { thumbnail } : {}),
    mediaType: resolveMediaType(value, input.inputType),
    hasAudio: resolveHasAudio(value),
    options: resolveOptions(input, value),
    preparing:
      preparing ||
      (value.kind !== "frame" && value.isExtracting === true),
  });
}
