import { createCapturedMediaValue } from "../utils/capturedMedia";
import type { Asset } from "../../../types/Asset";
import type { TimelineSelection } from "../../../types/TimelineTypes";
import type {
  GenerationMediaInputValue,
  WorkflowInput,
  WorkflowInputItemOption,
} from "../types";
import {
  buildRepeatableInputSlotId,
  buildWorkflowInputLookup,
  parseRepeatableInputSlotId,
  resolveWorkflowInputKeys,
  resolveWorkflowInputForSlot,
} from "../utils/workflowInputs";
import {
  collectMediaItemIds,
  createMediaItemId,
  isValidMediaItemId,
} from "../utils/mediaItemIds";
import { withDefaultItemOptions } from "../utils/mediaInputItemOptions";
import { revokePreviewUrl } from "./mediaInputState";
import type {
  GenerationStoreSet,
  GenerationStoreGet,
  GenerationWorkflowState,
} from "./types";

function removeMediaInputEntries(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  inputIds: readonly string[],
  options: { revoke?: boolean } = {},
): Record<string, GenerationMediaInputValue | null> {
  const next = { ...mediaInputs };
  const shouldRevoke = options.revoke !== false;

  for (const inputId of new Set(inputIds)) {
    if (shouldRevoke) {
      revokePreviewUrl(next[inputId]);
    }
    delete next[inputId];
  }

  return next;
}

function getExistingMediaInputValue(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  inputIds: readonly string[],
): GenerationMediaInputValue | null {
  for (const inputId of inputIds) {
    if (Object.prototype.hasOwnProperty.call(mediaInputs, inputId)) {
      return mediaInputs[inputId] ?? null;
    }
  }

  return null;
}

/**
 * Reads the ordered contents of a repeatable input, densely: batch slots are
 * kept contiguous (clearing shifts the tail down), so the list index is the
 * delivery position the nodes will see.
 */
function readRepeatableSlotValues(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  input: Pick<WorkflowInput, "id" | "nodeId" | "param">,
  inputById: ReadonlyMap<string, Pick<WorkflowInput, "id" | "nodeId" | "param">>,
  max: number,
): Array<{ slotId: string; value: GenerationMediaInputValue }> {
  const entries: Array<{ slotId: string; value: GenerationMediaInputValue }> = [];
  for (let index = 0; index < max; index += 1) {
    const slotId = buildRepeatableInputSlotId(input, index);
    const keys =
      index === 0 ? resolveWorkflowInputKeys(slotId, inputById) : [slotId];
    const value = getExistingMediaInputValue(mediaInputs, keys);
    if (value) {
      entries.push({ slotId, value });
    }
  }
  return entries;
}

/** Writes an ordered list back over a repeatable input's slots, front-packed. */
function writeRepeatableSlotValues(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  input: Pick<WorkflowInput, "id" | "nodeId" | "param">,
  inputById: ReadonlyMap<string, Pick<WorkflowInput, "id" | "nodeId" | "param">>,
  max: number,
  values: readonly GenerationMediaInputValue[],
): Record<string, GenerationMediaInputValue | null> {
  const next = { ...mediaInputs };
  for (let index = 0; index < max; index += 1) {
    const slotId = buildRepeatableInputSlotId(input, index);
    const keys =
      index === 0 ? resolveWorkflowInputKeys(slotId, inputById) : [slotId];
    for (const key of keys) {
      delete next[key];
    }
    const value = values[index];
    if (value) {
      // The canonical key is the one the rest of the store reads through.
      next[keys[0] ?? slotId] = value;
    }
  }
  return next;
}

/**
 * Front-packs a repeatable input so its occupied slots stay contiguous. Slot
 * order is delivery order, and the panel presents the batch densely, so a hole
 * left behind by a value moving out would silently reorder what the nodes
 * receive the next time an item is added.
 */
function compactRepeatableInput(
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  input: Pick<WorkflowInput, "id" | "nodeId" | "param" | "presentation">,
  inputById: ReadonlyMap<string, Pick<WorkflowInput, "id" | "nodeId" | "param">>,
): Record<string, GenerationMediaInputValue | null> {
  const repeatableMax = input.presentation?.repeatable?.max;
  if (!repeatableMax) {
    return mediaInputs;
  }
  const entries = readRepeatableSlotValues(
    mediaInputs,
    input,
    inputById,
    repeatableMax,
  );
  const isGapless = entries.every(
    (entry, index) =>
      entry.slotId === buildRepeatableInputSlotId(input, index),
  );
  if (isGapless) {
    return mediaInputs;
  }
  return writeRepeatableSlotValues(
    mediaInputs,
    input,
    inputById,
    repeatableMax,
    entries.map((entry) => entry.value),
  );
}

/**
 * Identity for a timeline selection as far as per-item switches are concerned:
 * the same range over the same clips. Re-preparing a selection rewrites the
 * value with an equal selection, while picking a new range produces a
 * different one and must not inherit the previous item's switches.
 */
function isSameTimelineSelection(
  previous: TimelineSelection,
  next: TimelineSelection,
): boolean {
  if (previous === next) return true;
  if (previous.anchor !== next.anchor || (previous.anchor + previous.durationTicks) !== (next.anchor + next.durationTicks)) return false;
  if (previous.region.clips.length !== next.region.clips.length) return false;
  return previous.region.clips.every((clip, index) => clip.id === next.region.clips[index]?.id);
}

/**
 * Is `next` the same attachment as `previous`, rewritten?
 *
 * Preparation rewrites a value in place — an extraction finishing, a selection
 * re-rendered — and that must not read as the user replacing the media. The
 * same asset, or the same selection over the same clips, is the same
 * occurrence. A different asset, a different range, or a new frame capture is
 * a replacement, and gets a new identity and none of the old switches.
 *
 * An edit that deliberately keeps the attachment while changing its range (the
 * mini editor) passes its `itemId` explicitly; this rule cannot
 * tell that apart from picking a new range.
 */
function isSameOccurrence(
  previous: GenerationMediaInputValue,
  next: GenerationMediaInputValue,
): boolean {
  if (previous.kind === "asset" && next.kind === "asset") {
    return previous.asset.id === next.asset.id;
  }
  return (
    previous.kind === "timelineSelection" &&
    next.kind === "timelineSelection" &&
    previous.mediaType === next.mediaType &&
    isSameTimelineSelection(previous.timelineSelection, next.timelineSelection)
  );
}

/**
 * A batch item's per-item switches — and its identity — belong to the media,
 * not to the slot it happens to occupy. Carry them across whenever the
 * replacement is the same occurrence; otherwise mint a fresh identity and
 * start from the slot's default switches.
 */
function carryForwardItemOptions(
  previous: GenerationMediaInputValue | null,
  next: GenerationMediaInputValue,
  input: Pick<WorkflowInput, "inputType" | "presentation"> | undefined,
): GenerationMediaInputValue {
  if (!previous || !isSameOccurrence(previous, next)) {
    const identified = isValidMediaItemId(next.itemId)
      ? next
      : { ...next, itemId: createMediaItemId() };
    return input ? withDefaultItemOptions(input, identified) : identified;
  }

  // Extraction completion/error replaces the value, but its edit recipe still
  // describes the same request. Do not inherit it for a newly selected range.
  if (
    previous.kind === "timelineSelection" &&
    next.kind === "timelineSelection" &&
    previous.mediaType === next.mediaType &&
    previous.timelineSelection === next.timelineSelection &&
    previous.extractionRequestId === next.extractionRequestId &&
    !next.bakedEdit && previous.bakedEdit
  ) {
    next = { ...next, bakedEdit: previous.bakedEdit };
  }

  const itemId = isValidMediaItemId(next.itemId)
    ? next.itemId
    : isValidMediaItemId(previous.itemId)
      ? previous.itemId
      : createMediaItemId();
  next = { ...next, itemId };

  // Same occurrence implies the same kind, so only the kinds that carry the
  // switch have one to hand on.
  const includeEmbeddedAudio =
    "includeEmbeddedAudio" in previous
      ? previous.includeEmbeddedAudio
      : undefined;
  return typeof includeEmbeddedAudio === "boolean" &&
    (next.kind === "asset" ||
      (next.kind === "timelineSelection" && next.mediaType === "video"))
    ? { ...next, includeEmbeddedAudio }
    : next;
}

export function buildMediaInputActions(
  set: GenerationStoreSet,
  get: GenerationStoreGet,
): Pick<
  GenerationWorkflowState,
  | "setMediaInputAsset"
  | "setMediaInputFrame"
  | "setMediaInputFrameWithSelection"
  | "setMediaInputTimelineSelection"
  | "reassignMediaInput"
  | "moveMediaInput"
  | "setMediaInputItemOption"
  | "setMediaInputItemId"
  | "clearMediaInput"
> {
  return {
    setMediaInputAsset: (inputId, asset: Asset, options) =>
      set({
        mediaInputs: updateMediaInputs(get, inputId, {
          kind: "asset",
          asset,
          isExtracting: options?.isExtracting ?? false,
          extractionRequestId: options?.extractionRequestId ?? 0,
          extractedAudioFile: options?.extractedAudioFile ?? null,
          extractionError: options?.extractionError ?? null,
        }),
      }),

    setMediaInputFrame: (inputId, file) =>
      set({
        mediaInputs: updateMediaInputs(get, inputId, {
          kind: "frame",
          file,
          previewUrl: URL.createObjectURL(file),
          timelineSelection: null,
        }),
      }),

    setMediaInputFrameWithSelection: (inputId, file, timelineSelection) =>
      set({
        mediaInputs: updateMediaInputs(get, inputId, {
          kind: "frame",
          file,
          previewUrl: URL.createObjectURL(file),
          timelineSelection,
        }),
      }),

    setMediaInputTimelineSelection: (
      inputId,
      timelineSelection,
      thumbnailFile,
      options,
    ) =>
      set({
        mediaInputs: updateMediaInputs(
          get,
          inputId,
          createCapturedMediaValue({ kind: "timelineSelection", timelineSelection, thumbnailFile, options }, URL.createObjectURL(thumbnailFile))
        ),
      }),

    reassignMediaInput: (sourceInputId, targetInputId) =>
      set({
        mediaInputs: reassignMediaInputs(get, sourceInputId, targetInputId),
      }),

    moveMediaInput: (sourceInputId, targetIndex) => {
      const { workflowInputs, mediaInputs } = get();
      const inputById = buildWorkflowInputLookup(workflowInputs);
      const workflowInput = resolveWorkflowInputForSlot(sourceInputId, inputById);
      const repeatableMax = workflowInput?.presentation?.repeatable?.max;
      if (!workflowInput || !repeatableMax) return;

      const entries = readRepeatableSlotValues(
        mediaInputs,
        workflowInput,
        inputById,
        repeatableMax,
      );
      // Matched by slot rather than by slot index: the two only agree while the
      // batch is gapless, and the move itself is what closes any gap.
      const sourceSlotId = buildRepeatableInputSlotId(
        workflowInput,
        parseRepeatableInputSlotId(sourceInputId)?.index ?? 0,
      );
      const sourceIndex = entries.findIndex(
        (entry) => entry.slotId === sourceSlotId,
      );
      if (sourceIndex < 0) return;
      const destination = Math.max(
        0,
        Math.min(entries.length - 1, Math.floor(targetIndex)),
      );
      if (destination === sourceIndex) return;

      const reordered = entries.map((entry) => entry.value);
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(destination, 0, moved);
      set({
        mediaInputs: writeRepeatableSlotValues(
          mediaInputs,
          workflowInput,
          inputById,
          repeatableMax,
          reordered,
        ),
      });
    },

    setMediaInputItemOption: (
      inputId: string,
      option: WorkflowInputItemOption,
      active: boolean,
    ) => {
      if (option !== "audio") return;
      const { workflowInputs, mediaInputs } = get();
      const inputById = buildWorkflowInputLookup(workflowInputs);
      const keys = resolveWorkflowInputKeys(inputId, inputById);
      const existingKey = keys.find((key) =>
        Object.prototype.hasOwnProperty.call(mediaInputs, key),
      );
      const value = existingKey ? mediaInputs[existingKey] : null;
      if (!existingKey || !value) return;
      if (value.kind === "frame") return;
      if (value.kind === "timelineSelection" && value.mediaType !== "video") {
        return;
      }
      set({
        mediaInputs: {
          ...mediaInputs,
          [existingKey]: { ...value, includeEmbeddedAudio: active },
        },
      });
    },

    setMediaInputItemId: (inputId, itemId) => {
      if (!isValidMediaItemId(itemId)) return;
      const { workflowInputs, mediaInputs } = get();
      const inputById = buildWorkflowInputLookup(workflowInputs);
      const keys = resolveWorkflowInputKeys(inputId, inputById);
      const existingKey = keys.find((key) =>
        Object.prototype.hasOwnProperty.call(mediaInputs, key),
      );
      const value = existingKey ? mediaInputs[existingKey] : null;
      if (!existingKey || !value || value.itemId === itemId) return;
      // Identity is unique panel-wide. A second slot claiming an id another
      // slot holds would make every reference to it ambiguous, so the claim
      // is refused and the slot keeps the id it has.
      if (collectMediaItemIds(mediaInputs).has(itemId)) return;
      set({
        mediaInputs: { ...mediaInputs, [existingKey]: { ...value, itemId } },
      });
    },

    clearMediaInput: (inputId) => {
      const { workflowInputs, mediaInputs } = get();
      const inputById = buildWorkflowInputLookup(workflowInputs);
      const workflowInput = resolveWorkflowInputForSlot(inputId, inputById);
      const repeatableMax = workflowInput?.presentation?.repeatable?.max;
      if (workflowInput && repeatableMax) {
        const parsedSlot = parseRepeatableInputSlotId(inputId);
        const clearedIndex = parsedSlot?.index ?? 0;
        const next = { ...mediaInputs };
        const clearedKeys =
          clearedIndex === 0
            ? resolveWorkflowInputKeys(inputId, inputById)
            : [inputId];
        const clearedValue = getExistingMediaInputValue(next, clearedKeys);
        revokePreviewUrl(clearedValue);
        for (const key of clearedKeys) {
          delete next[key];
        }
        for (let index = clearedIndex; index < repeatableMax - 1; index += 1) {
          const currentSlotId = buildRepeatableInputSlotId(workflowInput, index);
          const nextSlotId = buildRepeatableInputSlotId(workflowInput, index + 1);
          if (Object.prototype.hasOwnProperty.call(next, nextSlotId)) {
            next[currentSlotId] = next[nextSlotId] ?? null;
          } else {
            delete next[currentSlotId];
          }
        }
        delete next[
          buildRepeatableInputSlotId(workflowInput, repeatableMax - 1)
        ];
        set({ mediaInputs: next });
        return;
      }
      const inputKeys = resolveWorkflowInputKeys(inputId, inputById);
      const hasMatchingEntry = inputKeys.some((key) =>
        Object.prototype.hasOwnProperty.call(mediaInputs, key),
      );
      if (!hasMatchingEntry) return;
      set({
        mediaInputs: removeMediaInputEntries(mediaInputs, inputKeys),
      });
    },
  };
}

function updateMediaInputs(
  get: GenerationStoreGet,
  inputId: string,
  value: GenerationMediaInputValue,
): Record<string, GenerationMediaInputValue | null> {
  const { workflowInputs, mediaInputs } = get();
  const inputById = buildWorkflowInputLookup(workflowInputs);
  const inputKeys = resolveWorkflowInputKeys(inputId, inputById);
  const canonicalInputId = inputKeys[0] ?? inputId;
  const previous = getExistingMediaInputValue(mediaInputs, inputKeys);
  const remaining = removeMediaInputEntries(mediaInputs, inputKeys);
  // An explicit id another slot still holds would alias two attachments; the
  // write goes ahead as new media instead.
  if (value.itemId !== undefined && collectMediaItemIds(remaining).has(value.itemId)) {
    const { itemId: _taken, ...unnamed } = value;
    value = unnamed as GenerationMediaInputValue;
  }
  return {
    ...remaining,
    [canonicalInputId]: carryForwardItemOptions(
      previous,
      value,
      resolveWorkflowInputForSlot(inputId, inputById),
    ),
  };
}

function reassignMediaInputs(
  get: GenerationStoreGet,
  sourceInputId: string,
  targetInputId: string,
): Record<string, GenerationMediaInputValue | null> {
  const { workflowInputs, mediaInputs } = get();
  const inputById = buildWorkflowInputLookup(workflowInputs);
  const sourceInput = resolveWorkflowInputForSlot(sourceInputId, inputById);
  const targetInput = resolveWorkflowInputForSlot(targetInputId, inputById);

  if (!sourceInput || !targetInput) {
    return mediaInputs;
  }

  if (
    sourceInput.inputType !== targetInput.inputType ||
    sourceInput.inputType === "text"
  ) {
    return mediaInputs;
  }

  const sourceKeys = resolveWorkflowInputKeys(sourceInputId, inputById);
  const targetKeys = resolveWorkflowInputKeys(targetInputId, inputById);
  const sourceCanonicalInputId = sourceKeys[0] ?? sourceInputId;
  const targetCanonicalInputId = targetKeys[0] ?? targetInputId;

  if (sourceCanonicalInputId === targetCanonicalInputId) {
    return mediaInputs;
  }

  const sourceValue = getExistingMediaInputValue(mediaInputs, sourceKeys);
  if (!sourceValue) {
    return mediaInputs;
  }

  const targetValue = getExistingMediaInputValue(mediaInputs, targetKeys);
  const next = removeMediaInputEntries(
    mediaInputs,
    [...sourceKeys, ...targetKeys],
    { revoke: false },
  );

  next[targetCanonicalInputId] = sourceValue;
  if (targetValue) {
    next[sourceCanonicalInputId] = targetValue;
  }

  // Moving a value into an empty slot of another input empties the one it came
  // from, which can leave a batch with a hole in the middle.
  return compactRepeatableInput(
    compactRepeatableInput(next, sourceInput, inputById),
    targetInput,
    inputById,
  );
}
