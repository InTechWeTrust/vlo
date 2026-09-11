import { assetMatchesType } from "../../../shared/utils/assetTypeDetection";
import type { GenerationMediaInputValue, WorkflowInput } from "../types";
import { canAudioSlotHoldAsset, isAudioSlotVideoAsset } from "./audioSlotAssets";
import {
  buildRepeatableInputSlotId,
  buildWorkflowInputLookup,
  getWorkflowInputId,
  getWorkflowInputValue,
} from "./workflowInputs";

type MediaInputType = Exclude<WorkflowInput["inputType"], "text">;
type TextWorkflowInput = WorkflowInput & { inputType: "text" };
type MediaWorkflowInput = WorkflowInput & { inputType: MediaInputType };

type CarryoverValueMap<T> = Readonly<Record<string, T>>;

function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildLabelClassParamSignature(input: WorkflowInput): string {
  return [
    normalizeLabel(input.label),
    input.classType.trim().toLowerCase(),
    input.param.trim().toLowerCase(),
  ].join("|");
}

function buildClassParamSignature(input: WorkflowInput): string {
  return [
    input.classType.trim().toLowerCase(),
    input.param.trim().toLowerCase(),
  ].join("|");
}

/**
 * How a next input found its previous counterpart.
 *
 * `direct` means the identifier survived — the same workflow re-read, so a
 * slot keeps the exact position it held. `heuristic` means the value is moving
 * to an input that carries a different identifier, which is what a switch
 * between two workflows looks like.
 */
type CarryoverMatchKind = "direct" | "heuristic";

interface CarryoverMatch {
  previousId: string;
  kind: CarryoverMatchKind;
}

/**
 * Whether the two input lists come from the same workflow.
 *
 * Identifier matching is only evidence of identity within one workflow: node
 * ids are workflow-local, and two workflows can hand the same id to inputs
 * that mean different things (the shipped MiniMax i2v and r2v workflows both
 * put an image input on node 141 — a start frame in one, a reference batch in
 * the other). Across workflows, labels and class decide instead.
 */
export interface CarryoverOptions {
  sameWorkflow?: boolean;
}

function buildCarryoverMatches<TInput extends WorkflowInput>(
  previousInputs: readonly TInput[],
  nextInputs: readonly TInput[],
  canUseDirect: (input: TInput) => boolean,
  canUseHeuristic: (input: TInput) => boolean,
  sameWorkflow: boolean,
): Map<string, CarryoverMatch> {
  const previousInputLookup = buildWorkflowInputLookup(previousInputs);
  const usedPreviousIds = new Set<string>();
  const matches = new Map<string, CarryoverMatch>();

  const assign = (
    nextInput: TInput,
    previousInput: TInput,
    kind: CarryoverMatchKind,
  ) => {
    const nextId = getWorkflowInputId(nextInput);
    const previousId = getWorkflowInputId(previousInput);
    matches.set(nextId, { previousId, kind });
    usedPreviousIds.add(previousId);
  };

  const resolveUnmatchedCandidates = (
    nextInput: TInput,
    predicate: (input: TInput) => boolean,
  ): TInput[] =>
    previousInputs.filter((previousInput) => {
      const previousId = getWorkflowInputId(previousInput);
      return (
        !usedPreviousIds.has(previousId) &&
        previousInput.inputType === nextInput.inputType &&
        predicate(previousInput)
      );
    });

  for (const nextInput of nextInputs) {
    if (!sameWorkflow) break;
    const directCandidates = [
      previousInputLookup.get(getWorkflowInputId(nextInput)),
      previousInputLookup.get(nextInput.nodeId),
    ]
      .filter((candidate): candidate is TInput => Boolean(candidate))
      .filter(
        (candidate, index, candidates) =>
          candidates.findIndex(
            (entry) => getWorkflowInputId(entry) === getWorkflowInputId(candidate),
          ) === index,
      )
      .filter(
        (candidate) =>
          candidate.inputType === nextInput.inputType &&
          !usedPreviousIds.has(getWorkflowInputId(candidate)) &&
          canUseDirect(candidate),
      );

    if (directCandidates.length === 1) {
      assign(nextInput, directCandidates[0], "direct");
    }
  }

  const heuristicSignaturePasses = [
    buildLabelClassParamSignature,
    (input: TInput) => normalizeLabel(input.label),
    buildClassParamSignature,
  ];

  for (const signatureForInput of heuristicSignaturePasses) {
    for (const nextInput of nextInputs) {
      if (matches.has(getWorkflowInputId(nextInput))) {
        continue;
      }

      const nextSignature = signatureForInput(nextInput);
      if (!nextSignature) {
        continue;
      }

      const candidates = resolveUnmatchedCandidates(
        nextInput,
        (previousInput) =>
          canUseHeuristic(previousInput) &&
          signatureForInput(previousInput) === nextSignature,
      );

      if (candidates.length === 1) {
        assign(nextInput, candidates[0], "heuristic");
      }
    }
  }

  const inputTypes: WorkflowInput["inputType"][] = [
    "text",
    "image",
    "video",
    "audio",
  ];
  for (const inputType of inputTypes) {
    const remainingNextInputs = nextInputs.filter(
      (input) =>
        input.inputType === inputType && !matches.has(getWorkflowInputId(input)),
    );
    const remainingPreviousInputs = previousInputs.filter((input) => {
      const previousId = getWorkflowInputId(input);
      return (
        input.inputType === inputType &&
        !usedPreviousIds.has(previousId) &&
        canUseHeuristic(input)
      );
    });

    if (remainingNextInputs.length === 1 && remainingPreviousInputs.length === 1) {
      assign(remainingNextInputs[0], remainingPreviousInputs[0], "heuristic");
    }
  }

  return matches;
}

function textInputDefaultValue(input: WorkflowInput): string {
  return typeof input.currentValue === "string" ? input.currentValue : "";
}

function isDirectCompatibleMediaValue(
  inputType: MediaInputType,
  value: GenerationMediaInputValue | null | undefined,
): value is GenerationMediaInputValue {
  if (!value) {
    return false;
  }

  if (inputType === "image") {
    return (
      value.kind === "frame" ||
      (value.kind === "asset" && assetMatchesType(value.asset, "image"))
    );
  }

  if (inputType === "audio") {
    return (
      (value.kind === "asset" && canAudioSlotHoldAsset(value.asset)) ||
      (value.kind === "timelineSelection" && value.mediaType === "audio")
    );
  }

  return (
    (value.kind === "asset" && assetMatchesType(value.asset, "video")) ||
    (value.kind === "timelineSelection" && value.mediaType === "video")
  );
}

function isHeuristicCompatibleMediaValue(
  inputType: MediaInputType,
  value: GenerationMediaInputValue | null | undefined,
): value is GenerationMediaInputValue {
  if (!isDirectCompatibleMediaValue(inputType, value)) {
    return false;
  }

  if (
    inputType === "audio" &&
    value.kind === "asset" &&
    isAudioSlotVideoAsset(value.asset)
  ) {
    // An in-flight extraction still writes to its original slot. Only move
    // it to a different workflow input once the prepared audio is available.
    return Boolean(value.extractedAudioFile) && !value.isExtracting;
  }

  if (value.kind !== "timelineSelection") {
    return true;
  }

  if (inputType === "audio") {
    return (
      value.mediaType === "audio" &&
      value.preparedAudioFile !== null &&
      !value.isExtracting
    );
  }

  return (
    value.mediaType === "video" &&
    value.preparedVideoFile !== null &&
    !value.isExtracting
  );
}

export function carryOverTextValues(
  previousInputs: readonly WorkflowInput[],
  previousValues: CarryoverValueMap<string>,
  nextInputs: readonly WorkflowInput[],
  options: CarryoverOptions = {},
): Record<string, string> {
  const previousTextInputs = previousInputs.filter(
    (input): input is TextWorkflowInput => input.inputType === "text",
  );
  const nextTextInputs = nextInputs.filter(
    (input): input is TextWorkflowInput => input.inputType === "text",
  );
  const previousInputLookup = buildWorkflowInputLookup(previousTextInputs);
  const previousValuesById = new Map<string, string>();

  for (const input of previousTextInputs) {
    const value = getWorkflowInputValue(previousValues, input, previousInputLookup);
    if (typeof value === "string") {
      previousValuesById.set(getWorkflowInputId(input), value);
    }
  }

  const matches = buildCarryoverMatches(
    previousTextInputs,
    nextTextInputs,
    (input) => previousValuesById.has(getWorkflowInputId(input)),
    (input) => {
      const value = previousValuesById.get(getWorkflowInputId(input));
      return typeof value === "string" && value.trim().length > 0;
    },
    options.sameWorkflow ?? true,
  );

  return Object.fromEntries(
    nextTextInputs.map((input) => {
      const nextId = getWorkflowInputId(input);
      const matchedPreviousId = matches.get(nextId)?.previousId;
      return [
        nextId,
        matchedPreviousId
          ? (previousValuesById.get(matchedPreviousId) ?? textInputDefaultValue(input))
          : textInputDefaultValue(input),
      ];
    }),
  );
}

/** How many slots one media input holds, matching the panel's own clamp. */
function resolveRepeatableMax(input: MediaWorkflowInput): number {
  return Math.max(1, Math.floor(input.presentation?.repeatable?.max ?? 1));
}

interface PreviousSlotValue {
  index: number;
  value: GenerationMediaInputValue;
}

/**
 * Every filled slot of one media input, in slot order.
 *
 * A batch is more than the value under the input's own identifier: only its
 * first item lives there, and the rest hang off `::repeat::` slot ids. Reading
 * the whole strip is what lets a batch survive as a batch — matching included,
 * since an input whose first slot happens to be empty still has values worth
 * carrying.
 */
function collectPreviousSlotValues(
  input: MediaWorkflowInput,
  previousValues: CarryoverValueMap<GenerationMediaInputValue | null>,
  previousInputLookup: ReadonlyMap<string, MediaWorkflowInput>,
): PreviousSlotValue[] {
  const slots: PreviousSlotValue[] = [];

  for (let index = 0; index < resolveRepeatableMax(input); index += 1) {
    // The first slot is the input's own identifier, which older state may hold
    // under the bare node id — `getWorkflowInputValue` knows both spellings.
    const value =
      index === 0
        ? getWorkflowInputValue(previousValues, input, previousInputLookup)
        : previousValues[buildRepeatableInputSlotId(input, index)];
    if (!isDirectCompatibleMediaValue(input.inputType, value)) {
      continue;
    }
    slots.push({ index, value });
  }

  return slots;
}

export function carryOverMediaInputs(
  previousInputs: readonly WorkflowInput[],
  previousValues: CarryoverValueMap<GenerationMediaInputValue | null>,
  nextInputs: readonly WorkflowInput[],
  options: CarryoverOptions = {},
): Record<string, GenerationMediaInputValue | null> {
  const previousMediaInputs = previousInputs.filter(
    (input): input is MediaWorkflowInput => input.inputType !== "text",
  );
  const nextMediaInputs = nextInputs.filter(
    (input): input is MediaWorkflowInput => input.inputType !== "text",
  );
  const previousInputLookup = buildWorkflowInputLookup(previousMediaInputs);
  const previousSlotsById = new Map<string, readonly PreviousSlotValue[]>();

  for (const input of previousMediaInputs) {
    const slots = collectPreviousSlotValues(
      input,
      previousValues,
      previousInputLookup,
    );
    if (slots.length > 0) {
      previousSlotsById.set(getWorkflowInputId(input), slots);
    }
  }

  const matches = buildCarryoverMatches(
    previousMediaInputs,
    nextMediaInputs,
    (input) => (previousSlotsById.get(getWorkflowInputId(input))?.length ?? 0) > 0,
    (input) =>
      (previousSlotsById.get(getWorkflowInputId(input)) ?? []).some((slot) =>
        isHeuristicCompatibleMediaValue(input.inputType, slot.value),
      ),
    options.sameWorkflow ?? true,
  );

  const carried: Record<string, GenerationMediaInputValue | null> = {};

  for (const nextInput of nextMediaInputs) {
    const match = matches.get(getWorkflowInputId(nextInput));
    if (!match) continue;

    const slots = previousSlotsById.get(match.previousId);
    if (!slots?.length) continue;

    const nextMax = resolveRepeatableMax(nextInput);

    // The identifier survived, so the slots did too: hold every item exactly
    // where the user left it, and drop only what the new input has no room for.
    if (match.kind === "direct") {
      for (const slot of slots) {
        if (slot.index >= nextMax) continue;
        carried[buildRepeatableInputSlotId(nextInput, slot.index)] = slot.value;
      }
      continue;
    }

    // Moving to a differently-identified input. Items that are mid-extraction
    // cannot come along — their work writes back to the slot id they started
    // on — so the surviving items are re-packed from the front rather than
    // left sparse. Delivery position is counted off filled slots, and the
    // panel keeps its batches front-packed; a hole here would renumber the
    // references a prompt names ("<Picture 2>") behind the user's back.
    let position = 0;
    for (const slot of slots) {
      if (position >= nextMax) break;
      if (!isHeuristicCompatibleMediaValue(nextInput.inputType, slot.value)) {
        continue;
      }
      carried[buildRepeatableInputSlotId(nextInput, position)] = slot.value;
      position += 1;
    }
  }

  return carried;
}
