import { useCallback, useMemo, type ReactNode } from "react";
import { Alert, Box } from "@mui/material";
import type { Asset } from "../../../types/Asset";
import { useGenerationInputsDraft } from "../draft/useGenerationInputsDraft";
import type { GenerationInputsDraftController } from "../draft/useGenerationInputsDraft";
import type {
  GenerationInputSnapshot,
  GenerationMediaItemSnapshot,
} from "../services/generationSessionTypes";
import type {
  GenerationMediaInputValue,
  WorkflowInput,
} from "../types";
import type { AssetDropSlotDisabledActions } from "../../panelUI";
import { buildRepeatableInputSlotId } from "../utils/workflowInputs";
import {
  MemoizedBatchMediaInputSection,
  MemoizedMediaInputSection,
  MemoizedTextInputSection,
} from "./generationInputFields";
import { isMediaWorkflowInput } from "./generationInputFieldValues";

/**
 * A staged editor over some of the generation panel's inputs.
 *
 * Renders the panel's own field components against a draft, so the two
 * surfaces look like one panel rather than two implementations of it. Nothing
 * is written until the caller commits; `children` receives the controller so
 * it can put its own commit control wherever it belongs.
 *
 * Only the interactions the session transaction can express are offered.
 * Timeline capture, external file drops and media editing all *start real
 * work* — a render, an ingest — and produce values that no id can name until
 * they finish, so they cannot be held in a draft. They are shown refused with
 * a reason rather than hidden: a slot that silently loses an affordance looks
 * broken, and a no-op callback looks enabled.
 */
export interface GenerationInputsDraftProps {
  /** The inputs to edit, by id. Anything else stays the panel's alone. */
  readonly inputIds: readonly string[];
  readonly children?: (controller: GenerationInputsDraftController) => ReactNode;
}

const STAGED_REFUSALS: AssetDropSlotDisabledActions = {
  select: "Selecting from the timeline starts a render, which cannot be held until you commit.",
  externalDrop: "Adding a file imports it now, which cannot be held until you commit.",
  edit: "Editing media changes it now, which cannot be held until you commit.",
};

/**
 * The panel-shaped value for one staged media item.
 *
 * The fields consume the panel's own value type; the draft holds the detached
 * snapshot. Only the parts a field reads are needed, and `preparing` carries
 * through so a video staged onto an audio slot reads as extracting rather than
 * as ready — which is what it will be a moment after commit.
 */
function toPanelValue(
  item: GenerationMediaItemSnapshot | undefined,
): GenerationMediaInputValue | null {
  if (!item) return null;
  return {
    kind: "asset",
    asset: {
      id: item.assetId ?? item.slotId,
      name: item.displayName,
      type: item.mediaType,
      // `hasAudio` is what decides whether the strip offers the embedded-audio
      // switch at all (`isVideoAssetWithAudio`). Dropping it would hide the
      // switch on every staged video — and that switch decides whether a
      // reference contributes an `<Audio j>`, which moves every audio ordinal
      // after it.
      hasAudio: item.hasAudio,
    },
    ...(item.options.audio === true ? { includeEmbeddedAudio: true } : {}),
    ...(item.preparing ? { isExtracting: true } : {}),
  } as unknown as GenerationMediaInputValue;
}

function toPanelInput(input: GenerationInputSnapshot): WorkflowInput {
  return {
    id: input.id,
    nodeId: input.nodeId,
    param: input.param,
    label: input.label,
    inputType: input.inputType,
    ...(input.description ? { description: input.description } : {}),
    presentation: input.repeatable
      ? {
          repeatable: {
            max: input.repeatable.max,
            // Without the offered option ids the strip never renders the
            // audio switch, however capable the item is.
            itemOptions: input.repeatable.optionIds,
          },
        }
      : {},
  } as unknown as WorkflowInput;
}

export function GenerationInputsDraft({
  inputIds,
  children,
}: GenerationInputsDraftProps) {
  const controller = useGenerationInputsDraft(inputIds);
  const { inputs, apply } = controller;

  const textValues = useMemo(() => {
    const values: Record<string, string> = {};
    for (const input of inputs) {
      if (input.inputType !== "text") continue;
      values[input.id] = typeof input.value === "string" ? input.value : "";
    }
    return values;
  }, [inputs]);

  const onTextCommit = useCallback(
    (inputId: string, value: string) => {
      apply({ kind: "setText", inputId, value });
    },
    [apply],
  );

  const onDrop = useCallback(
    (inputId: string, asset: Asset) => {
      apply({ kind: "attachAsset", inputId, assetId: asset.id });
    },
    [apply],
  );

  const onClearSlot = useCallback(
    (inputId: string, slotId: string) => {
      apply({ kind: "removeMedia", inputId, slotId });
    },
    [apply],
  );

  const onReorder = useCallback(
    (inputId: string, fromOrdinal: number, toOrdinal: number) => {
      apply({ kind: "moveMedia", inputId, fromOrdinal, toOrdinal });
    },
    [apply],
  );

  const onToggleOption = useCallback(
    (inputId: string, slotId: string, optionId: string, value: boolean) => {
      apply({ kind: "setMediaOption", inputId, slotId, optionId, value });
    },
    [apply],
  );

  return (
    <Box
      data-testid="generation-inputs-draft"
      sx={{ display: "flex", flexDirection: "column" }}
    >
      {controller.error ? (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {controller.error}
        </Alert>
      ) : null}
      {inputs.map((input, index) => {
        const bgColor = index % 2 === 0 ? "#202024" : "#18181b";
        const panelInput = toPanelInput(input);

        if (input.inputType === "text") {
          return (
            <MemoizedTextInputSection
              key={input.id}
              input={panelInput}
              bgColor={bgColor}
              value={textValues[input.id] ?? ""}
              commitInputId={input.id}
              onCommit={onTextCommit}
            />
          );
        }
        if (!isMediaWorkflowInput(panelInput)) return null;

        if (input.repeatable) {
          const staged = input.media ?? [];
          // The strip reads its items out of a record keyed by the panel's own
          // repeatable slot ids, so the projection is re-keyed into that shape
          // rather than the strip being taught a second one.
          const mediaInputs: Record<string, GenerationMediaInputValue | null> = {};
          staged.forEach((item, slotIndex) => {
            mediaInputs[buildRepeatableInputSlotId(panelInput, slotIndex)] =
              toPanelValue(item);
          });
          const indexOfSlotKey = (slotKey: string): number | null => {
            for (let slotIndex = 0; slotIndex < input.repeatable!.max; slotIndex += 1) {
              if (buildRepeatableInputSlotId(panelInput, slotIndex) === slotKey) {
                return slotIndex;
              }
            }
            return null;
          };
          const slotIdAt = (slotKey: string): string | null => {
            const at = staged.findIndex(
              (_item, slotIndex) =>
                buildRepeatableInputSlotId(panelInput, slotIndex) === slotKey,
            );
            return at === -1 ? null : staged[at].slotId;
          };
          return (
            <MemoizedBatchMediaInputSection
              key={input.id}
              input={panelInput}
              bgColor={bgColor}
              mediaInputs={mediaInputs}
              firstValue={toPanelValue(staged[0])}
              disabledActions={STAGED_REFUSALS}
              onInputDrop={(slotKey, asset) => {
                // The strip names the tile that was dropped on, and that is a
                // position, not an append: dropping onto an occupied tile
                // replaces it, exactly as the live panel does.
                const at = indexOfSlotKey(slotKey);
                apply({
                  kind: "attachAsset",
                  inputId: input.id,
                  assetId: asset.id,
                  ...(at === null || at >= staged.length ? {} : { at }),
                });
              }}
              onExternalInputDrop={() => undefined}
              onInputClear={(slotKey) => {
                const slotId = slotIdAt(slotKey);
                if (slotId) onClearSlot(input.id, slotId);
              }}
              onMoveMediaInput={(slotKey, targetIndex) => {
                const from = staged.findIndex(
                  (_item, slotIndex) =>
                    buildRepeatableInputSlotId(panelInput, slotIndex) === slotKey,
                );
                if (from === -1) return;
                onReorder(input.id, from, targetIndex);
              }}
              // Cross-input drags are refused at the slot, so this is never
              // reached; it stays required by the field's contract.
              onSwapMediaInputs={() => undefined}
              onClickSelect={() => undefined}
              onToggleItemOption={(slotKey, option, active) => {
                const slotId = slotIdAt(slotKey);
                if (slotId) onToggleOption(input.id, slotId, option, active);
              }}
            />
          );
        }

        return (
          <MemoizedMediaInputSection
            key={input.id}
            input={panelInput}
            bgColor={bgColor}
            value={toPanelValue((input.media ?? [])[0])}
            disabledActions={STAGED_REFUSALS}
            onInputDrop={(_inputId, asset) => onDrop(input.id, asset)}
            onExternalInputDrop={() => undefined}
            onInputClear={() => {
              const item = (input.media ?? [])[0];
              if (item) onClearSlot(input.id, item.slotId);
            }}
            onClickSelect={() => undefined}
          />
        );
      })}
      {children?.(controller)}
    </Box>
  );
}
