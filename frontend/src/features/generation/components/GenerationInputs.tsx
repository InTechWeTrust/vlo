import { memo, useMemo } from "react";
import { Box } from "@mui/material";
import { PanelSection } from "../../panelUI";
import type { Asset } from "../../../types/Asset";
import type {
  GenerationMediaInputValue,
  WorkflowInput,
  WorkflowInputItemOption,
  WorkflowWidgetInput,
} from "../types";
import type { WorkflowSection } from "../services/workflowRules";
import {
  buildWorkflowInputLookup,
  getWorkflowInputId,
  getWorkflowInputValue,
} from "../utils/workflowInputs";
import { isAspectRatioWidget } from "../utils/aspectRatioWidgets";
import { getNodeBypassWidgetKey } from "../utils/nodeBypassWidgets";
import { GenerationPanelSectionHost } from "./GenerationPanelSectionHost";
import { ExtensionUiSlot, anchorSegment } from "../../extensions/ui/publicApi";
import {
  PANEL_SURFACE_ID,
  MemoizedBatchMediaInputSection,
  MemoizedMediaInputGroupSection,
  MemoizedMediaInputSection,
  MemoizedTextInputSection,
  MemoizedWidgetGroupSection,
  type WidgetGroup,
} from "./generationInputFields";
import {
  isMediaWorkflowInput,
  type MediaWorkflowInput,
} from "./generationInputFieldValues";

interface GenerationInputsProps {
  inputs: WorkflowInput[];
  textValues: Record<string, string>;
  onTextValueCommit: (inputId: string, value: string) => void;
  mediaInputs: Record<string, GenerationMediaInputValue | null>;
  onInputDrop: (inputId: string, asset: Asset) => void;
  onExternalInputDrop: (inputId: string, file: File) => void | Promise<void>;
  onInputClear: (inputId: string) => void;
  onSwapMediaInputs: (sourceInputId: string, targetInputId: string) => void;
  onMoveMediaInput: (sourceInputId: string, targetIndex: number) => void;
  onToggleMediaInputOption?: (
    inputId: string,
    option: WorkflowInputItemOption,
    active: boolean,
  ) => void;
  onClickSelect: (inputId: string, inputType: "image" | "video" | "audio") => void;
  onEditMedia?: (
    inputId: string,
    inputType: "video" | "audio",
  ) => void;
  widgetInputs: WorkflowWidgetInput[];
  sections?: WorkflowSection[];
  workflowId?: string | null;
  widgetValues: Record<string, Record<string, unknown>>;
  bypassedWidgetTargets?: ReadonlySet<string>;
  randomizeToggles: Record<string, boolean>;
  onWidgetChange: (nodeId: string, param: string, value: unknown) => void;
  onToggleRandomize: (nodeId: string, param: string) => void;
  showExactAspectRatioControl?: boolean;
  exactAspectRatioWidgetKey?: string | null;
  exactAspectRatio?: boolean;
  onExactAspectRatioChange?: (exact: boolean) => void;
  exactAspectRatioTooltip?: string;
}

const DEFAULT_SECTION_METADATA = {
  inputs: {
    title: "Inputs",
    order: 0,
    defaultOpen: true,
  },
  prompts: {
    title: "Prompts",
    order: 1,
    defaultOpen: true,
  },
  settings: {
    title: "Settings",
    order: 2,
    defaultOpen: true,
  },
  lora_loaders: {
    title: "LoRA loaders",
    order: 3,
    defaultOpen: true,
  },
} as const;

type DefaultSectionId = keyof typeof DEFAULT_SECTION_METADATA;

/**
 * The extension anchor for one section edge, or nothing.
 *
 * Section ids come from workflow rules, which only require them to be
 * non-empty, so an id that is not already a safe slot segment gets no anchor
 * rather than a lossy mapping into one — two sections colliding on a single
 * anchor would render a contribution twice with nothing to explain it.
 */
function sectionAnchor(sectionId: string, edge: "before" | "after") {
  const segment = anchorSegment(sectionId);
  if (!segment) return null;
  return (
    <ExtensionUiSlot
      key={`anchor:${edge}:${sectionId}`}
      slot={`generation.section.${segment}.${edge}`}
    />
  );
}

function normalizeSectionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isDefaultSectionId(value: string): value is DefaultSectionId {
  return Object.prototype.hasOwnProperty.call(DEFAULT_SECTION_METADATA, value);
}

function formatSectionTitle(sectionId: string): string {
  return sectionId
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}











function resolveInputSectionId(input: WorkflowInput): string {
  return normalizeSectionId(input.presentation?.section?.id)
    ?? (input.inputType === "text" ? "prompts" : "inputs");
}

function resolveWidgetSectionId(widget: WorkflowWidgetInput): string {
  return normalizeSectionId(widget.config.sectionId) ?? "settings";
}

/** Hide frontend-only enum widgets that declare no options (the default is still applied). */
function isHiddenWidget(widget: WorkflowWidgetInput): boolean {
  if (widget.config.hidden === true) {
    return true;
  }
  return (
    widget.config.frontendOnly === true &&
    widget.config.valueType === "enum" &&
    (!widget.config.options || widget.config.options.length === 0)
  );
}

function groupWidgetsByNode(widgetInputs: WorkflowWidgetInput[]): WidgetGroup[] {
  type GroupedWidget = {
    widget: WorkflowWidgetInput;
    index: number;
  };

  type WidgetGroupAccumulator = {
    sectionId: string;
    sourceGroupId: string;
    title: string;
    widgets: GroupedWidget[];
    firstIndex: number;
    minOrder?: number;
  };

  const grouped = new Map<string, WidgetGroupAccumulator>();
  for (const [index, widget] of widgetInputs.entries()) {
    if (isHiddenWidget(widget)) continue;
    const sectionId = resolveWidgetSectionId(widget);
    const groupId = widget.config.groupId || widget.nodeId;
    const groupKey = `${sectionId}::${groupId}`;
    const groupTitle = widget.config.groupTitle || widget.config.nodeTitle || "";
    const existing = grouped.get(groupKey);
    if (existing) {
      existing.widgets.push({ widget, index });
      if (!existing.title && groupTitle) {
        existing.title = groupTitle;
      }
      if (
        typeof widget.config.groupOrder === "number" &&
        (existing.minOrder === undefined ||
          widget.config.groupOrder < existing.minOrder)
      ) {
        existing.minOrder = widget.config.groupOrder;
      }
      continue;
    }
    grouped.set(groupKey, {
      sectionId,
      sourceGroupId: groupId,
      title: groupTitle,
      widgets: [{ widget, index }],
      firstIndex: index,
      minOrder:
        typeof widget.config.groupOrder === "number"
          ? widget.config.groupOrder
          : undefined,
    });
  }

  return Array.from(grouped.entries())
    .sort(([leftId, left], [rightId, right]) => {
      if (
        typeof left.minOrder === "number" &&
        typeof right.minOrder === "number"
      ) {
        if (left.minOrder !== right.minOrder) {
          return left.minOrder - right.minOrder;
        }
      } else if (typeof left.minOrder === "number") {
        return -1;
      } else if (typeof right.minOrder === "number") {
        return 1;
      }

      if (left.firstIndex !== right.firstIndex) {
        return left.firstIndex - right.firstIndex;
      }

      return leftId.localeCompare(rightId);
    })
    .map(([groupId, group]) => {
      const entries = [...group.widgets];
      entries.sort((left, right) => {
        const leftOrder = left.widget.config.groupOrder;
        const rightOrder = right.widget.config.groupOrder;
        if (typeof leftOrder === "number" && typeof rightOrder === "number") {
          if (leftOrder !== rightOrder) return leftOrder - rightOrder;
          return left.index - right.index;
        }
        if (typeof leftOrder === "number") return -1;
        if (typeof rightOrder === "number") return 1;
        return left.index - right.index;
      });

      const fallbackTitle =
        entries.length === 1
          ? entries[0]?.widget.config.label || `Node ${group.sourceGroupId}`
          : `Node ${group.sourceGroupId}`;

      return {
        id: groupId,
        sectionId: group.sectionId,
        title: group.title || fallbackTitle,
        widgets: entries.map((entry) => entry.widget),
      };
    });
}

type RenderableInputBlock =
  | {
      kind: "text";
      sectionId: string;
      input: WorkflowInput;
    }
  | {
      kind: "media";
      sectionId: string;
      input: MediaWorkflowInput;
    }
  | {
      kind: "batchMedia";
      sectionId: string;
      input: MediaWorkflowInput;
    }
  | {
      kind: "mediaGroup";
      id: string;
      sectionId: string;
      title: string;
      inputs: MediaWorkflowInput[];
    };

function getRenderableInputBlockPriority(block: RenderableInputBlock): number {
  switch (block.kind) {
    case "media":
    case "batchMedia":
    case "mediaGroup":
      return 0;
    case "text":
      return 1;
  }
}

function buildRenderableInputBlocks(inputs: WorkflowInput[]): RenderableInputBlock[] {
  type GroupedInputEntry = {
    input: MediaWorkflowInput;
    index: number;
    order?: number;
  };

  type GroupAccumulator = {
    sectionId: string;
    title: string;
    entries: GroupedInputEntry[];
    minOrder?: number;
    firstIndex: number;
  };

  const blocks: RenderableInputBlock[] = [];
  const groupedEntries = new Map<string, GroupAccumulator>();

  for (const [index, input] of inputs.entries()) {
    const sectionId = resolveInputSectionId(input);
    if (input.inputType === "text") {
      blocks.push({ kind: "text", input, sectionId });
      continue;
    }

    if (!isMediaWorkflowInput(input)) {
      continue;
    }

    const mediaInput = input;

    if (mediaInput.presentation?.repeatable) {
      blocks.push({ kind: "batchMedia", input: mediaInput, sectionId });
      continue;
    }

    const group = mediaInput.presentation?.group;
    if (!group?.id) {
      blocks.push({ kind: "media", input: mediaInput, sectionId });
      continue;
    }

    const groupKey = `${sectionId}::${group.id}`;
    const existing = groupedEntries.get(groupKey);
    if (existing) {
      existing.entries.push({ input: mediaInput, index, order: group.order });
      if (
        typeof group.order === "number" &&
        (existing.minOrder === undefined || group.order < existing.minOrder)
      ) {
        existing.minOrder = group.order;
      }
      if (!existing.title && group.title) {
        existing.title = group.title;
      }
      continue;
    }

    groupedEntries.set(groupKey, {
      sectionId,
      title: group.title ?? mediaInput.label,
      entries: [{ input: mediaInput, index, order: group.order }],
      minOrder: typeof group.order === "number" ? group.order : undefined,
      firstIndex: index,
    });
    blocks.push({
      kind: "mediaGroup",
      id: groupKey,
      sectionId,
      title: group.title ?? mediaInput.label,
      inputs: [],
    });
  }

  // Sort key resolution:
  //   - mediaGroup: smallest `group.order` declared by any member, falling
  //     back to the index where the group first appeared. This lets rules
  //     drive inter-group order via per-input `group_order` (e.g. Frames
  //     members at 0,1 and Audio members at 10,11 → Frames first), while
  //     un-rules'd workflows keep their original first-occurrence ordering.
  //   - media / text: their position in the inferred input list.
  const resolveSortKey = (
    block: RenderableInputBlock,
    fallbackIndex: number,
  ): number => {
    if (block.kind !== "mediaGroup") return fallbackIndex;
    const group = groupedEntries.get(block.id);
    if (!group) return fallbackIndex;
    return group.minOrder ?? group.firstIndex;
  };

  return blocks
    .map((block, index) => {
      const sortKey = resolveSortKey(block, index);
      if (block.kind !== "mediaGroup") {
        return { block, index, sortKey };
      }

      const group = groupedEntries.get(block.id);
      if (!group) {
        return { block, index, sortKey };
      }

      const sortedInputs = [...group.entries]
        .sort((left, right) => {
          if (
            typeof left.order === "number" &&
            typeof right.order === "number"
          ) {
            if (left.order !== right.order) {
              return left.order - right.order;
            }
            return left.index - right.index;
          }
          if (typeof left.order === "number") return -1;
          if (typeof right.order === "number") return 1;
          return left.index - right.index;
        })
        .map((entry) => entry.input);

      return {
        index,
        sortKey,
        block: {
          ...block,
          title: group.title || block.title,
          inputs: sortedInputs,
        },
      };
    })
    .sort((left, right) => {
      const leftPriority = getRenderableInputBlockPriority(left.block);
      const rightPriority = getRenderableInputBlockPriority(right.block);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      if (left.sortKey !== right.sortKey) {
        return left.sortKey - right.sortKey;
      }
      return left.index - right.index;
    })
    .map(({ block }) => block);
}

interface RenderableSection {
  id: string;
  title: string;
  order?: number;
  defaultOpen: boolean;
  hasExplicitDefinition: boolean;
  renderAsPanel: boolean;
  blocks: RenderableInputBlock[];
  widgetGroups: WidgetGroup[];
  extension: NonNullable<WorkflowSection["extension"]> | null;
  firstIndex: number;
}

function buildRenderableSections(
  inputBlocks: RenderableInputBlock[],
  widgetGroups: WidgetGroup[],
  sections: WorkflowSection[],
): RenderableSection[] {
  type SectionAccumulator = {
    blocks: RenderableInputBlock[];
    widgetGroups: WidgetGroup[];
    firstIndex: number;
  };

  const explicitSections = new Map<string, WorkflowSection>();
  for (const section of sections) {
    const sectionId = normalizeSectionId(section.id);
    if (!sectionId || explicitSections.has(sectionId)) {
      continue;
    }
    explicitSections.set(sectionId, section);
  }

  const resolvedSections = new Map<string, SectionAccumulator>();
  const ensureSection = (sectionId: string, index: number): SectionAccumulator => {
    const existing = resolvedSections.get(sectionId);
    if (existing) {
      if (index < existing.firstIndex) {
        existing.firstIndex = index;
      }
      return existing;
    }

    const created: SectionAccumulator = {
      blocks: [],
      widgetGroups: [],
      firstIndex: index,
    };
    resolvedSections.set(sectionId, created);
    return created;
  };

  inputBlocks.forEach((block, index) => {
    ensureSection(block.sectionId, index).blocks.push(block);
  });

  widgetGroups.forEach((group, index) => {
    ensureSection(group.sectionId, inputBlocks.length + index).widgetGroups.push(group);
  });

  sections.forEach((section, index) => {
    const sectionId = normalizeSectionId(section.id);
    if (sectionId && section.extension) {
      ensureSection(
        sectionId,
        inputBlocks.length + widgetGroups.length + index,
      );
    }
  });

  return Array.from(resolvedSections.entries())
    .map(([sectionId, section]) => {
      const explicitSection = explicitSections.get(sectionId);
      const builtinSection = isDefaultSectionId(sectionId)
        ? DEFAULT_SECTION_METADATA[sectionId]
        : null;
      const title =
        normalizeOptionalLabel(explicitSection?.title)
        ?? builtinSection?.title
        ?? formatSectionTitle(sectionId);
      const order =
        typeof explicitSection?.order === "number"
          ? explicitSection.order
          : builtinSection?.order;
      const defaultOpen =
        typeof explicitSection?.default_open === "boolean"
          ? explicitSection.default_open
          : builtinSection?.defaultOpen ?? true;
      const hasExplicitDefinition = explicitSection !== undefined;

      return {
        id: sectionId,
        title,
        order,
        defaultOpen,
        hasExplicitDefinition,
        renderAsPanel:
          section.widgetGroups.length > 0 ||
          sectionId === "settings" ||
          !isDefaultSectionId(sectionId) ||
          hasExplicitDefinition,
        blocks: section.blocks,
        widgetGroups: section.widgetGroups,
        extension: explicitSection?.extension ?? null,
        firstIndex: section.firstIndex,
      };
    })
    .sort((left, right) => {
      if (typeof left.order === "number" && typeof right.order === "number") {
        if (left.order !== right.order) {
          return left.order - right.order;
        }
      } else if (typeof left.order === "number") {
        return -1;
      } else if (typeof right.order === "number") {
        return 1;
      }

      if (left.firstIndex !== right.firstIndex) {
        return left.firstIndex - right.firstIndex;
      }

      return left.id.localeCompare(right.id);
    });
}







const EMPTY_BYPASSED_WIDGET_TARGETS: ReadonlySet<string> = new Set();

function getRenderableInputBlockKey(block: RenderableInputBlock): string {
  switch (block.kind) {
    case "text":
      return `text:${getWorkflowInputId(block.input)}`;
    case "media":
      return `media:${getWorkflowInputId(block.input)}`;
    case "batchMedia":
      return `batch-media:${getWorkflowInputId(block.input)}`;
    case "mediaGroup":
      return `media-group:${block.id}`;
  }
}

export const GenerationInputs = memo(function GenerationInputs({
  inputs,
  textValues,
  onTextValueCommit,
  mediaInputs,
  onInputDrop,
  onExternalInputDrop,
  onInputClear,
  onSwapMediaInputs,
  onMoveMediaInput,
  onToggleMediaInputOption,
  onClickSelect,
  onEditMedia,
  widgetInputs,
  sections = [],
  workflowId = null,
  widgetValues,
  bypassedWidgetTargets = EMPTY_BYPASSED_WIDGET_TARGETS,
  randomizeToggles,
  onWidgetChange,
  onToggleRandomize,
  showExactAspectRatioControl = false,
  exactAspectRatioWidgetKey,
  exactAspectRatio = false,
  onExactAspectRatioChange,
  exactAspectRatioTooltip,
}: GenerationInputsProps) {
  const groupedWidgets = useMemo(
    () => groupWidgetsByNode(widgetInputs),
    [widgetInputs],
  );
  const inputBlocks = useMemo(
    () => buildRenderableInputBlocks(inputs),
    [inputs],
  );
  const renderableSections = useMemo(
    () => buildRenderableSections(inputBlocks, groupedWidgets, sections),
    [groupedWidgets, inputBlocks, sections],
  );
  const topLevelRenderItems = useMemo<
    Array<
      | { kind: "block"; block: RenderableInputBlock }
      | { kind: "section"; section: RenderableSection }
      | { kind: "anchor"; sectionId: string; edge: "before" | "after" }
    >
  >(
    () =>
      renderableSections.flatMap(
        (
          section,
        ): Array<
          | { kind: "block"; block: RenderableInputBlock }
          | { kind: "section"; section: RenderableSection }
          | { kind: "anchor"; sectionId: string; edge: "before" | "after" }
        > =>
          section.renderAsPanel
            ? [{ kind: "section", section }]
            : // A built-in section with no widget groups and no rules entry is
              // flattened to its bare blocks — which is how `prompts` renders
              // in every shipped workflow. Its anchors have to survive that:
              // an anchor names a section, not the chrome the section happens
              // to be drawn with, and dropping it here would make the whole
              // family unreachable exactly where it is most useful.
              [
                { kind: "anchor" as const, sectionId: section.id, edge: "before" as const },
                ...section.blocks.map(
                  (block) => ({ kind: "block" as const, block }),
                ),
                { kind: "anchor" as const, sectionId: section.id, edge: "after" as const },
              ],
      ),
    [renderableSections],
  );
  // A loader switched off through its bypass choice takes the rest of its
  // node's controls with it: they configure a node this run leaves out.
  const bypassedNodeIds = useMemo(
    () =>
      new Set(
        widgetInputs.flatMap((widget) =>
          widget.config.nodeBypassOption &&
          bypassedWidgetTargets.has(
            getNodeBypassWidgetKey(widget.nodeId, widget.param),
          )
            ? [widget.nodeId]
            : [],
        ),
      ),
    [bypassedWidgetTargets, widgetInputs],
  );
  const inputLookup = useMemo(() => buildWorkflowInputLookup(inputs), [inputs]);
  const resolvedExactAspectRatioWidgetKey = useMemo(() => {
    if (exactAspectRatioWidgetKey) {
      return exactAspectRatioWidgetKey;
    }
    const widget = widgetInputs.find(isAspectRatioWidget);
    return widget ? `${widget.nodeId}:${widget.param}` : null;
  }, [exactAspectRatioWidgetKey, widgetInputs]);

  const renderInputBlock = (
    block: RenderableInputBlock,
    bgColor: string,
    key?: string,
  ) => {
    if (block.kind === "text") {
      const input = block.input;
      const inputId = getWorkflowInputId(input);
      const commitInputId =
        inputLookup.get(input.nodeId) === input ? input.nodeId : inputId;

      return (
        <MemoizedTextInputSection
          key={key ?? inputId}
          input={input}
          bgColor={bgColor}
          value={getWorkflowInputValue(textValues, input, inputLookup) ?? ""}
          commitInputId={commitInputId}
          onCommit={onTextValueCommit}
        />
      );
    }

    if (block.kind === "mediaGroup") {
      return (
        <MemoizedMediaInputGroupSection
          surfaceId={PANEL_SURFACE_ID}
          key={key ?? `media-group:${block.id}`}
          title={block.title}
          inputs={block.inputs}
          bgColor={bgColor}
          mediaInputs={mediaInputs}
          onInputDrop={onInputDrop}
          onExternalInputDrop={onExternalInputDrop}
          onInputClear={onInputClear}
          onSwapMediaInputs={onSwapMediaInputs}
          onClickSelect={onClickSelect}
          onEditMedia={onEditMedia}
        />
      );
    }

    if (block.kind === "batchMedia") {
      return (
        <MemoizedBatchMediaInputSection
          surfaceId={PANEL_SURFACE_ID}
          key={key ?? `batch-media:${getWorkflowInputId(block.input)}`}
          input={block.input}
          bgColor={bgColor}
          mediaInputs={mediaInputs}
          firstValue={getWorkflowInputValue(
            mediaInputs,
            block.input,
            inputLookup,
          )}
          onInputDrop={onInputDrop}
          onExternalInputDrop={onExternalInputDrop}
          onInputClear={onInputClear}
          onMoveMediaInput={onMoveMediaInput}
          onSwapMediaInputs={onSwapMediaInputs}
          onClickSelect={onClickSelect}
          onEditMedia={onEditMedia}
          onToggleItemOption={onToggleMediaInputOption}
        />
      );
    }

    const input = block.input;
    const inputId = getWorkflowInputId(input);
    return (
      <MemoizedMediaInputSection
        surfaceId={PANEL_SURFACE_ID}
        key={key ?? inputId}
        input={input}
        bgColor={bgColor}
        value={getWorkflowInputValue(mediaInputs, input, inputLookup)}
        onInputDrop={onInputDrop}
        onExternalInputDrop={onExternalInputDrop}
        onInputClear={onInputClear}
        onClickSelect={onClickSelect}
        onEditMedia={onEditMedia}
      />
    );
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column" }}>
      {topLevelRenderItems.map((item, index) => {
        const bgColor = index % 2 === 0 ? "#202024" : "#18181b";

        if (item.kind === "block") {
          return renderInputBlock(
            item.block,
            bgColor,
            getRenderableInputBlockKey(item.block),
          );
        }

        if (item.kind === "anchor") {
          return sectionAnchor(item.sectionId, item.edge);
        }

        return (
          <PanelSection
            key={`section:${item.section.id}`}
            title={item.section.title}
            bgColor={bgColor}
            defaultOpen={item.section.defaultOpen}
            keepMounted={Boolean(item.section.extension)}
          >
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {/* Anchors, one per section, so an extension can place a control
                  where the workflow's own structure says it belongs rather than
                  at whichever fixed points were thought of in advance. Emitted
                  only for ids that are already safe slot segments; see
                  `anchorSegment`. */}
              {sectionAnchor(item.section.id, "before")}
              {item.section.blocks.map((block, blockIndex) =>
                renderInputBlock(
                  block,
                  blockIndex % 2 === 0 ? "#202024" : "#18181b",
                  getRenderableInputBlockKey(block),
                ),
              )}
              {item.section.widgetGroups.map((group, groupIndex) => (
                <MemoizedWidgetGroupSection
                  key={`section-group:${item.section.id}:${group.id}`}
                  group={group}
                  widgetValues={widgetValues}
                  bypassedWidgetTargets={bypassedWidgetTargets}
                  randomizeToggles={randomizeToggles}
                  onWidgetChange={onWidgetChange}
                  onToggleRandomize={onToggleRandomize}
                  showExactAspectRatioControl={showExactAspectRatioControl}
                  resolvedExactAspectRatioWidgetKey={resolvedExactAspectRatioWidgetKey}
                  exactAspectRatio={exactAspectRatio}
                  onExactAspectRatioChange={onExactAspectRatioChange}
                  exactAspectRatioTooltip={exactAspectRatioTooltip}
                  showDivider={item.section.blocks.length > 0 || groupIndex > 0}
                  bypassedNodeIds={bypassedNodeIds}
                />
              ))}
              {item.section.extension ? (
                <GenerationPanelSectionHost
                  key={`extension-section:${workflowId ?? "none"}:${item.section.id}`}
                  placementId={item.section.id}
                  sectionId={item.section.id}
                  workflowId={workflowId}
                  extension={item.section.extension}
                />
              ) : null}
              {sectionAnchor(item.section.id, "after")}
            </Box>
          </PanelSection>
        );
      })}
    </Box>
  );
});
