import { useCallback, useMemo, type ReactNode } from "react";
import { Alert, Box } from "@mui/material";
import type { Asset } from "../../../types/Asset";
import { resolveAssetType } from "../../../shared/utils/assetTypeDetection";
import { useAssetStore } from "../../userAssets";
import { useGenerationStore } from "../useGenerationStore";
import { resolveWidgetInputs } from "../services/workflowRules";
import { buildWorkflowInputLookup, getWorkflowInputId } from "../utils/workflowInputs";
import { useGenerationInputsDraft } from "../draft/useGenerationInputsDraft";
import type {
  GenerationDraftWidgetTarget,
  GenerationInputsDraftController,
} from "../draft/useGenerationInputsDraft";
import { widgetKey } from "../draft/generationInputsDraft";
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
  MemoizedWidgetGroupSection,
  MemoizedBatchMediaInputSection,
  MemoizedMediaInputGroupSection,
  MemoizedMediaInputSection,
  MemoizedTextInputSection,
} from "./generationInputFields";
import {
  isMediaWorkflowInput,
  type MediaWorkflowInput,
} from "./generationInputFieldValues";

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
  /**
   * Widgets to edit alongside them, addressed as the transaction addresses
   * them. A duration that a composer derives text from belongs beside that
   * text, not one panel away.
   */
  readonly widgetTargets?: readonly GenerationDraftWidgetTarget[];
  readonly children?: (controller: GenerationInputsDraftController) => ReactNode;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();
const EMPTY_TOGGLES: Record<string, boolean> = {};

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
  resolveAsset: (assetId: string) => Asset | undefined,
): GenerationMediaInputValue | null {
  if (!item) return null;
  // The *library* asset, not a stub built from the snapshot: the slot reads
  // its preview off `asset.thumbnail`/`asset.src`, and its type through
  // `resolveAssetType`, neither of which a detached snapshot carries. Without
  // it every staged item renders "No Preview".
  const asset = item.assetId ? resolveAsset(item.assetId) : undefined;
  return {
    kind: "asset",
    asset: asset ?? {
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

/**
 * What a staged drop may carry.
 *
 * The panel accepts a video on an *image* slot and opens a frame picker, whose
 * result is a captured frame — work that starts immediately and produces a
 * value no id can name until it finishes, so it cannot be held in a draft.
 * Accepting the drag and staging a plain attach instead would skip the picker
 * the user expects and stage a write the transaction refuses anyway.
 */
function stageableAsset(
  inputType: GenerationInputSnapshot["inputType"],
  asset: Asset,
): boolean {
  if (inputType !== "image") return true;
  return resolveAssetType(asset) !== "video";
}

export function GenerationInputsDraft({
  inputIds,
  widgetTargets,
  children,
}: GenerationInputsDraftProps) {
  const controller = useGenerationInputsDraft(inputIds, widgetTargets);
  const { inputs, apply } = controller;
  const assets = useAssetStore((state) => state.assets);
  /**
   * The panel's *own* input definitions, not ones rebuilt from the snapshot.
   *
   * The snapshot is the detached, extension-facing projection: it carries no
   * grouping, no per-item option ids, and no asset beyond an id. Synthesising
   * a `WorkflowInput` from it means silently dropping whatever the fields read
   * that the projection does not publish — which is how the staged editor lost
   * previews, the audio switch, and the shared "Frames" heading at once. The
   * definitions come from the store; only the *values* come from the draft.
   */
  const workflowInputs = useGenerationStore((state) => state.workflowInputs);
  /**
   * The panel's widget definitions, through the panel's own resolver.
   *
   * `useGenerationPanel` builds these in a hook rather than the store, so they
   * are re-derived here from the same store values with the same function —
   * not reimplemented. Only the rules path: manual-mode graphs and
   * autodiscovered LoRA loaders are not resolved here, and a widget this does
   * not find is simply not offered rather than rendered from a guess.
   */
  const syncedWorkflow = useGenerationStore((state) => state.syncedWorkflow);
  const syncedGraphData = useGenerationStore((state) => state.syncedGraphData);
  const activeWorkflowRules = useGenerationStore(
    (state) => state.activeWorkflowRules,
  );
  const rawObjectInfo = useGenerationStore((state) => state.rawObjectInfo);
  const widgetInputs = useMemo(
    () =>
      syncedWorkflow && activeWorkflowRules
        ? resolveWidgetInputs(syncedWorkflow, activeWorkflowRules, {
            graphData: syncedGraphData,
            objectInfo: rawObjectInfo,
          })
        : [],
    [syncedWorkflow, activeWorkflowRules, syncedGraphData, rawObjectInfo],
  );
  const definitions = useMemo(
    () => buildWorkflowInputLookup(workflowInputs),
    [workflowInputs],
  );
  const resolveAsset = useCallback(
    (assetId: string) => assets.find((candidate) => candidate.id === assetId),
    [assets],
  );

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

  /**
   * Grouped exactly as the panel groups them: a workflow that puts its start
   * and end frames in one "Frames" block should not have them fall into two
   * headings here, which is what rendering each input on its own produced.
   */
  const blocks = useMemo(() => {
    const built: Array<
      | { kind: "single"; input: WorkflowInput; snapshot: GenerationInputSnapshot }
      | { kind: "group"; id: string; title: string; entries: Array<{
          input: MediaWorkflowInput;
          snapshot: GenerationInputSnapshot;
        }> }
    > = [];
    const groups = new Map<string, Extract<(typeof built)[number], { kind: "group" }>>();
    for (const snapshot of inputs) {
      const input = definitions.get(snapshot.id);
      if (!input) continue;
      const group = input.presentation?.group;
      if (!group?.id || !isMediaWorkflowInput(input)) {
        built.push({ kind: "single", input, snapshot });
        continue;
      }
      const existing = groups.get(group.id);
      if (existing) {
        existing.entries.push({ input, snapshot });
        continue;
      }
      const block = {
        kind: "group" as const,
        id: group.id,
        title: group.title ?? input.label,
        entries: [{ input, snapshot }],
      };
      groups.set(group.id, block);
      built.push(block);
    }
    return built;
  }, [inputs, definitions]);

  const mediaValuesFor = useCallback(
    (snapshot: GenerationInputSnapshot, input: WorkflowInput) => {
      const staged = snapshot.media ?? [];
      const values: Record<string, GenerationMediaInputValue | null> = {};
      if (snapshot.repeatable) {
        staged.forEach((item, slotIndex) => {
          values[buildRepeatableInputSlotId(input, slotIndex)] = toPanelValue(
            item,
            resolveAsset,
          );
        });
      } else {
        values[getWorkflowInputId(input)] = toPanelValue(staged[0], resolveAsset);
      }
      return values;
    },
    [resolveAsset],
  );

  /**
   * The requested widgets, as the panel describes them, carrying the staged
   * value. Rendered through the panel's own widget row so the control, its
   * bounds and its display unit — seconds, for a frame count — are the ones
   * the user already knows.
   */
  const widgetGroup = useMemo(() => {
    const wanted = new Set(
      (widgetTargets ?? []).map((target) => widgetKey(target.nodeId, target.param)),
    );
    if (wanted.size === 0) return null;
    const widgets = widgetInputs.filter((widget) =>
      wanted.has(widgetKey(widget.nodeId, widget.param)),
    );
    if (widgets.length === 0) return null;
    return {
      id: "draft-widgets",
      sectionId: "draft",
      title: widgets.length === 1 ? widgets[0].config.label : "Settings",
      widgets,
    };
  }, [widgetInputs, widgetTargets]);

  const stagedWidgetValues = useMemo(() => {
    const values: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of controller.widgetValues) {
      const separator = key.lastIndexOf(":");
      const nodeId = key.slice(0, separator);
      values[nodeId] = { ...(values[nodeId] ?? {}), [key.slice(separator + 1)]: value };
    }
    return values;
  }, [controller.widgetValues]);

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
      {blocks.map((block, index) => {
        const bgColor = index % 2 === 0 ? "#202024" : "#18181b";

        if (block.kind === "group") {
          const mediaInputs: Record<string, GenerationMediaInputValue | null> = {};
          for (const entry of block.entries) {
            Object.assign(mediaInputs, mediaValuesFor(entry.snapshot, entry.input));
          }
          return (
            <MemoizedMediaInputGroupSection
              key={`group:${block.id}`}
              title={block.title}
              inputs={block.entries.map((entry) => entry.input)}
              bgColor={bgColor}
              mediaInputs={mediaInputs}
              disabledActions={STAGED_REFUSALS}
              acceptAsset={(asset) =>
                block.entries.every((entry) =>
                  stageableAsset(entry.input.inputType, asset),
                )
              }
              onInputDrop={(inputId, asset) => onDrop(inputId, asset)}
              onExternalInputDrop={() => undefined}
              onInputClear={(inputId) => {
                const entry = block.entries.find(
                  (candidate) => getWorkflowInputId(candidate.input) === inputId,
                );
                const item = entry?.snapshot.media?.[0];
                if (entry && item) onClearSlot(entry.snapshot.id, item.slotId);
              }}
              onSwapMediaInputs={() => undefined}
              onClickSelect={() => undefined}
            />
          );
        }

        const { input, snapshot } = block;
        if (snapshot.inputType === "text") {
          return (
            <MemoizedTextInputSection
              key={snapshot.id}
              input={input}
              bgColor={bgColor}
              value={textValues[snapshot.id] ?? ""}
              commitInputId={snapshot.id}
              onCommit={onTextCommit}
            />
          );
        }
        if (!isMediaWorkflowInput(input)) return null;
        const staged = snapshot.media ?? [];

        if (snapshot.repeatable) {
          const indexOfSlotKey = (slotKey: string): number | null => {
            for (
              let slotIndex = 0;
              slotIndex < snapshot.repeatable!.max;
              slotIndex += 1
            ) {
              if (buildRepeatableInputSlotId(input, slotIndex) === slotKey) {
                return slotIndex;
              }
            }
            return null;
          };
          const slotIdAt = (slotKey: string): string | null => {
            const at = indexOfSlotKey(slotKey);
            return at === null ? null : (staged[at]?.slotId ?? null);
          };
          return (
            <MemoizedBatchMediaInputSection
              key={snapshot.id}
              input={input}
              bgColor={bgColor}
              mediaInputs={mediaValuesFor(snapshot, input)}
              firstValue={toPanelValue(staged[0], resolveAsset)}
              disabledActions={STAGED_REFUSALS}
              onInputDrop={(slotKey, asset) => {
                // The strip names the tile dropped on, and that is a position:
                // a drop on an occupied tile replaces it, as the panel does.
                const at = indexOfSlotKey(slotKey);
                apply({
                  kind: "attachAsset",
                  inputId: snapshot.id,
                  assetId: asset.id,
                  ...(at === null || at >= staged.length ? {} : { at }),
                });
              }}
              onExternalInputDrop={() => undefined}
              onInputClear={(slotKey) => {
                const slotId = slotIdAt(slotKey);
                if (slotId) onClearSlot(snapshot.id, slotId);
              }}
              onMoveMediaInput={(slotKey, targetIndex) => {
                const from = indexOfSlotKey(slotKey);
                if (from === null) return;
                onReorder(snapshot.id, from, targetIndex);
              }}
              onSwapMediaInputs={() => undefined}
              onClickSelect={() => undefined}
              onToggleItemOption={(slotKey, option, active) => {
                const slotId = slotIdAt(slotKey);
                if (slotId) onToggleOption(snapshot.id, slotId, option, active);
              }}
            />
          );
        }

        return (
          <MemoizedMediaInputSection
            key={snapshot.id}
            input={input}
            bgColor={bgColor}
            value={toPanelValue(staged[0], resolveAsset)}
            disabledActions={STAGED_REFUSALS}
            acceptAsset={(asset) => stageableAsset(snapshot.inputType, asset)}
            onInputDrop={(_inputId, asset) => onDrop(snapshot.id, asset)}
            onExternalInputDrop={() => undefined}
            onInputClear={() => {
              const item = staged[0];
              if (item) onClearSlot(snapshot.id, item.slotId);
            }}
            onClickSelect={() => undefined}
          />
        );
      })}
      {widgetGroup ? (
        <MemoizedWidgetGroupSection
          group={widgetGroup}
          widgetValues={stagedWidgetValues}
          bypassedWidgetTargets={EMPTY_KEYS}
          randomizeToggles={EMPTY_TOGGLES}
          onWidgetChange={(nodeId, param, value) =>
            apply({ kind: "setWidget", nodeId, param, value })
          }
          onToggleRandomize={() => undefined}
          showExactAspectRatioControl={false}
          resolvedExactAspectRatioWidgetKey={null}
          exactAspectRatio={false}
          showDivider={false}
          bypassedNodeIds={EMPTY_KEYS}
        />
      ) : null}
      {children?.(controller)}
    </Box>
  );
}
