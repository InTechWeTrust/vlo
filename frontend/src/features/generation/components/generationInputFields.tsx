import { memo, useCallback, useMemo } from "react";
import { Box, Button, Typography } from "@mui/material";
import type { Asset } from "../../../types/Asset";
import {
  AssetBatchDropSlot,
  AssetDropSlot,
  CommittedTextInput,
  PanelSection,
  type AssetBatchSlotItem,
} from "../../panelUI";
import {
  canValueCarryAudio,
  readIncludeEmbeddedAudio,
} from "../utils/mediaInputItemOptions";
import type {
  GenerationMediaInputValue,
  WorkflowInput,
  WorkflowInputItemOption,
} from "../types";
import {
  buildRepeatableInputSlotId,
  getWorkflowInputId,
} from "../utils/workflowInputs";
import { useMediaInputPreparationStore } from "../store/useMediaInputPreparationStore";
import { generationTextInputClaims } from "../services/GenerationTextInputClaims";
import { useGenerationTextInputClaim } from "../hooks/useGenerationTextInputClaim";
import {
  acceptAssetForInputType,
  resolveAcceptTypes,
  resolveExternalAcceptTypes,
  toPreparingSlotValue,
  toSlotValue,
  type MediaWorkflowInput,
} from "./generationInputFieldValues";

/**
 * One rendered generation input, shared by the live panel and by any staged
 * editor over the same inputs.
 *
 * These were private to `GenerationInputs`, which meant a second surface over
 * the same inputs — the prompt composer's staged editor — could either import
 * that 30-prop composition root or reimplement the fields and drift from it.
 * They are value-and-callback driven already, so lifting them out costs
 * nothing and is what keeps the two surfaces looking like one panel.
 */

/**
 * Prompt boxes gate the Generate button: a workflow can require the text input
 * before submission is allowed. Committing only on blur left the button grey
 * while the caret was still in the box, and clicking the disabled button moves
 * no focus, so it never un-stuck itself. Commit on a short typing pause too.
 */
export const PROMPT_COMMIT_DEBOUNCE_MS = 250;

interface TextInputSectionProps {
  input: WorkflowInput;
  bgColor: string;
  value: string;
  commitInputId: string;
  onCommit: (inputId: string, value: string) => void;
}

function TextInputSection({
  input,
  bgColor,
  value,
  commitInputId,
  onCommit,
}: TextInputSectionProps) {
  // Claims are keyed by the canonical input id, which is what the session
  // publishes and what a claim resolves to; `commitInputId` may be the bare
  // node-id alias the panel writes through.
  const claim = useGenerationTextInputClaim(getWorkflowInputId(input));

  return (
    <PanelSection title={input.label} bgColor={bgColor} defaultOpen={true}>
      {input.description ? (
        <Typography sx={{ mb: 1, color: "text.secondary", fontSize: "0.8rem" }}>
          {input.description}
        </Typography>
      ) : null}
      {claim ? (
        <Box
          sx={{
            mb: 1,
            p: 1,
            borderRadius: 1,
            bgcolor: "rgba(255, 255, 255, 0.04)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            display: "flex",
            alignItems: "flex-start",
            gap: 1,
          }}
        >
          <Typography
            sx={{ flex: 1, color: "text.secondary", fontSize: "0.75rem" }}
          >
            {claim.reason}
          </Typography>
          <Button
            size="small"
            onClick={() =>
              generationTextInputClaims.revoke(getWorkflowInputId(input))
            }
            sx={{ flexShrink: 0, fontSize: "0.7rem", py: 0, minWidth: 0 }}
          >
            Edit anyway
          </Button>
        </Box>
      ) : null}
      <CommittedTextInput
        // Remounted when a claim comes or goes, so the buffered field picks up
        // the composed text instead of redisplaying the draft it was holding.
        key={claim ? "claimed" : "free"}
        initialValue={value}
        disabled={claim !== null}
        onCommit={(nextValue) => onCommit(commitInputId, nextValue)}
        commitDebounceMs={PROMPT_COMMIT_DEBOUNCE_MS}
        multiline={true}
        minRows={6}
        maxRows={20}
        placeholder={`Enter ${input.label.toLowerCase()}...`}
        sx={{
          "& .MuiOutlinedInput-root": {
            bgcolor: "#1a1a1a",
            fontSize: "0.875rem",
          },
        }}
      />
    </PanelSection>
  );
}

export const MemoizedTextInputSection = memo(TextInputSection);

interface MediaInputSectionProps {
  input: MediaWorkflowInput;
  bgColor: string;
  value: GenerationMediaInputValue | null | undefined;
  onInputDrop: (inputId: string, asset: Asset) => void;
  onExternalInputDrop: (inputId: string, file: File) => void | Promise<void>;
  onInputClear: (inputId: string) => void;
  onClickSelect: (inputId: string, inputType: "image" | "video" | "audio") => void;
  onEditMedia?: (inputId: string, inputType: "video") => void;
}

function MediaInputSection({
  input,
  bgColor,
  value,
  onInputDrop,
  onExternalInputDrop,
  onInputClear,
  onClickSelect,
  onEditMedia,
}: MediaInputSectionProps) {
  const inputId = getWorkflowInputId(input);
  const mediaInputType = input.inputType;
  const acceptTypes = resolveAcceptTypes(mediaInputType);
  const acceptAsset = acceptAssetForInputType(mediaInputType);
  const acceptExternalTypes = resolveExternalAcceptTypes(mediaInputType);
  const preparing = useMediaInputPreparationStore((state) =>
    state.preparingInputIds.has(inputId),
  );
  const slotValue = useMemo(() => {
    const base = toSlotValue(value, mediaInputType);
    return preparing ? toPreparingSlotValue(base, mediaInputType) : base;
  }, [mediaInputType, preparing, value]);

  return (
    <PanelSection title={input.label} bgColor={bgColor} defaultOpen={true}>
      {input.description ? (
        <Typography sx={{ mb: 1, color: "text.secondary", fontSize: "0.8rem" }}>
          {input.description}
        </Typography>
      ) : null}
      <AssetDropSlot
        id={inputId}
        accept={acceptTypes}
        acceptAsset={acceptAsset}
        acceptExternal={acceptExternalTypes}
        value={slotValue}
        onClear={() => onInputClear(inputId)}
        onEdit={
          mediaInputType === "video" && slotValue && !preparing && onEditMedia
            ? () => onEditMedia(inputId, "video")
            : undefined
        }
        onDrop={(asset: Asset) => onInputDrop(inputId, asset)}
        onExternalDrop={(file: File) => onExternalInputDrop(inputId, file)}
        onSelect={() => onClickSelect(inputId, mediaInputType)}
      />
    </PanelSection>
  );
}

export const MemoizedMediaInputSection = memo(MediaInputSection);

interface BatchMediaInputSectionProps {
  input: MediaWorkflowInput;
  bgColor: string;
  mediaInputs: Record<string, GenerationMediaInputValue | null>;
  firstValue: GenerationMediaInputValue | null | undefined;
  onInputDrop: (inputId: string, asset: Asset) => void;
  onExternalInputDrop: (inputId: string, file: File) => void | Promise<void>;
  onInputClear: (inputId: string) => void;
  onMoveMediaInput: (sourceInputId: string, targetIndex: number) => void;
  onSwapMediaInputs: (sourceInputId: string, targetInputId: string) => void;
  onClickSelect: (inputId: string, inputType: "image" | "video" | "audio") => void;
  onEditMedia?: (inputId: string, inputType: "video") => void;
  onToggleItemOption?: (
    inputId: string,
    option: WorkflowInputItemOption,
    active: boolean,
  ) => void;
}

/**
 * A batch loader presented as one telescoping slot rather than a row of fixed
 * slots: the strip holds exactly the references that were added, in the order
 * the node will receive them, and offers a `+` while it is below its ceiling.
 */
function BatchMediaInputSection({
  input,
  bgColor,
  mediaInputs,
  firstValue,
  onInputDrop,
  onExternalInputDrop,
  onInputClear,
  onMoveMediaInput,
  onSwapMediaInputs,
  onClickSelect,
  onEditMedia,
  onToggleItemOption,
}: BatchMediaInputSectionProps) {
  const max = Math.max(1, Math.floor(input.presentation?.repeatable?.max ?? 1));
  const mediaInputType = input.inputType;
  const itemOptions = input.presentation?.repeatable?.itemOptions;
  const supportsAudioOption =
    mediaInputType === "video" && itemOptions?.includes("audio") === true;
  const slotLabelBase =
    input.label.replace(/\s+inputs?$/i, "").trim() || input.label;

  const preparingInputIds = useMediaInputPreparationStore(
    (state) => state.preparingInputIds,
  );

  const items = useMemo<AssetBatchSlotItem[]>(() => {
    const collected: AssetBatchSlotItem[] = [];
    for (let index = 0; index < max; index += 1) {
      const slotId = buildRepeatableInputSlotId(input, index);
      const value = index === 0 ? firstValue : mediaInputs[slotId];
      const preparing = preparingInputIds.has(slotId);
      const slotValue = toSlotValue(value, mediaInputType);
      // A position being prepared holds the place it will occupy, so the strip
      // shows the work rather than staying one tile short until it finishes.
      if (preparing) {
        collected.push({
          slotId,
          value: toPreparingSlotValue(slotValue, mediaInputType),
        });
        continue;
      }
      if (!value || !slotValue) continue;
      collected.push({
        slotId,
        value: slotValue,
        editable: mediaInputType === "video",
        ...(supportsAudioOption && canValueCarryAudio(value)
          ? {
              options: [
                {
                  id: "audio",
                  icon: "audio" as const,
                  active: readIncludeEmbeddedAudio(value),
                  label: "Include this video's audio as a reference",
                  activeLabel: "Audio included as a reference",
                },
              ],
            }
          : {}),
      });
    }
    return collected;
  }, [
    firstValue,
    input,
    max,
    mediaInputs,
    mediaInputType,
    preparingInputIds,
    supportsAudioOption,
  ]);

  /**
   * Maps a strip position to the slot that backs it. Filled positions answer
   * with their own slot; the trailing add tile answers with the first free
   * slot, so a drop can never land on top of an occupied one even if the batch
   * somehow holds a gap.
   */
  const slotIdAt = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) return item.slotId;
      for (let candidate = 0; candidate < max; candidate += 1) {
        const slotId = buildRepeatableInputSlotId(input, candidate);
        const value = candidate === 0 ? firstValue : mediaInputs[slotId];
        // A slot that is still being prepared counts as taken: its value is on
        // its way and would otherwise be overwritten by the next drop.
        if (!value && !preparingInputIds.has(slotId)) return slotId;
      }
      return buildRepeatableInputSlotId(input, max - 1);
    },
    [firstValue, input, items, max, mediaInputs, preparingInputIds],
  );

  /**
   * A drag can also arrive from another input's slot, which is a swap between
   * two inputs rather than a move inside this batch. Route it the way it was
   * routed before batches were a single slot.
   */
  const ownSlotIds = useMemo(() => {
    const ids = new Set<string>([getWorkflowInputId(input), input.nodeId]);
    for (let index = 0; index < max; index += 1) {
      ids.add(buildRepeatableInputSlotId(input, index));
    }
    return ids;
  }, [input, max]);

  const handleReorder = useCallback(
    (slotId: string, toIndex: number) => {
      if (ownSlotIds.has(slotId)) {
        onMoveMediaInput(slotId, toIndex);
        return;
      }
      onSwapMediaInputs(slotId, slotIdAt(Math.min(toIndex, items.length)));
    },
    [items.length, onMoveMediaInput, onSwapMediaInputs, ownSlotIds, slotIdAt],
  );

  return (
    <PanelSection title={input.label} bgColor={bgColor} defaultOpen={true}>
      {input.description ? (
        <Typography sx={{ mb: 1, color: "text.secondary", fontSize: "0.8rem" }}>
          {input.description}
        </Typography>
      ) : null}
      <AssetBatchDropSlot
        id={getWorkflowInputId(input)}
        accept={resolveAcceptTypes(mediaInputType)}
        acceptAsset={acceptAssetForInputType(mediaInputType)}
        acceptExternal={resolveExternalAcceptTypes(mediaInputType)}
        items={items}
        max={max}
        itemLabel={(index) => `${slotLabelBase} ${index + 1}`}
        onDrop={(index, asset) => onInputDrop(slotIdAt(index), asset)}
        onExternalDrop={(index, file) =>
          onExternalInputDrop(slotIdAt(index), file)
        }
        onSelect={(index) => onClickSelect(slotIdAt(index), mediaInputType)}
        onClear={(slotId) => onInputClear(slotId)}
        onEdit={
          mediaInputType === "video" && onEditMedia
            ? (slotId) => onEditMedia(slotId, "video")
            : undefined
        }
        onReorder={handleReorder}
        onToggleOption={
          supportsAudioOption && onToggleItemOption
            ? (slotId, optionId, nextActive) =>
                onToggleItemOption(
                  slotId,
                  optionId as WorkflowInputItemOption,
                  nextActive,
                )
            : undefined
        }
      />
    </PanelSection>
  );
}

export const MemoizedBatchMediaInputSection = memo(BatchMediaInputSection);
