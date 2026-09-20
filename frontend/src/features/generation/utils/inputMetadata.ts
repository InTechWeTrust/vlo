import { tickToMediaSeconds } from "../../renderer/utils/mediaTime";
import {
  getIncludedTracksForSelection,
  getTicksPerFrame,
  resolveSelectionFps,
  resolveSelectionFrameOffset,
  resolveSelectionFrameStep,
  selectionHasMaskClip,
  snapFrameCountToStep,
} from "../../timelineSelection";
import type { GenerationMediaInputValue, WorkflowInput } from "../types";
import type {
  ProjectConfig,
  TimelineSelectionInputMetadata,
  WorkflowInputMetadata,
  WorkflowInputMetadataMap,
} from "../pipeline/types";
import {
  buildWorkflowInputLookup,
  getWorkflowInputId,
  getWorkflowInputValue,
  resolveWorkflowInputKeys,
} from "./workflowInputs";

function buildTimelineSelectionInputMetadata(
  selection: import("../../../types/TimelineTypes").TimelineSelection,
  projectFps: number,
): TimelineSelectionInputMetadata {
  const effectiveFps = resolveSelectionFps(selection, projectFps);
  const frameStep = resolveSelectionFrameStep(selection);
  const frameOffset = resolveSelectionFrameOffset(selection);
  const ticksPerFrame = getTicksPerFrame(effectiveFps);
  const requestedEndTick = Math.max(
    selection.anchor + ticksPerFrame,
    selection.anchor + selection.durationTicks,
  );
  const rawFrameCount = Math.max(
    1,
    Math.ceil((requestedEndTick - selection.anchor) / ticksPerFrame),
  );
  const frameCount = snapFrameCountToStep(
    rawFrameCount,
    frameStep,
    "floor",
    frameOffset,
  );
  const durationTicks = frameCount * ticksPerFrame;
  const includedTrackCount = getIncludedTracksForSelection(
    selection,
    selection.region.tracks ?? [],
  ).length;

  return {
    startTick: selection.anchor,
    endTick: selection.anchor + durationTicks,
    durationTicks,
    durationSeconds: tickToMediaSeconds(durationTicks),
    effectiveFps,
    frameStep,
    frameOffset,
    frameCount,
    clipCount: selection.region.clips.length,
    trackCount: selection.region.tracks?.length ?? 0,
    includedTrackCount,
    hasMaskClip: selectionHasMaskClip(selection),
    isRange:
      !selection.isPoint && selection.durationTicks > 0,
  };
}

function buildWorkflowInputMetadata(
  workflowInput: WorkflowInput,
  value: GenerationMediaInputValue,
  projectConfig: ProjectConfig,
): WorkflowInputMetadata {
  if (value.kind === "asset") {
    return {
      sourceKind: "asset",
      inputType: workflowInput.inputType,
      mediaType:
        workflowInput.inputType === "text"
          ? undefined
          : workflowInput.inputType,
    };
  }

  if (value.kind === "frame") {
    return {
      sourceKind: "frame",
      inputType: workflowInput.inputType,
      mediaType: "image",
      ...(value.timelineSelection
        ? {
            timelineSelection: buildTimelineSelectionInputMetadata(
              value.timelineSelection,
              projectConfig.fps,
            ),
          }
        : {}),
    };
  }

  return {
    sourceKind: "timeline_selection",
    inputType: workflowInput.inputType,
    mediaType: value.mediaType,
    timelineSelection: buildTimelineSelectionInputMetadata(
      value.timelineSelection,
      projectConfig.fps,
    ),
  };
}

export function buildWorkflowInputMetadataMap(
  workflowInputs: WorkflowInput[],
  mediaInputs: Record<string, GenerationMediaInputValue | null>,
  projectConfig: ProjectConfig,
): WorkflowInputMetadataMap {
  const inputById = buildWorkflowInputLookup(workflowInputs);
  const metadata: WorkflowInputMetadataMap = {};

  for (const workflowInput of workflowInputs) {
    const value = getWorkflowInputValue(mediaInputs, workflowInput, inputById);
    if (!value) {
      continue;
    }

    const inputMetadata = buildWorkflowInputMetadata(
      workflowInput,
      value,
      projectConfig,
    );
    for (const inputKey of resolveWorkflowInputKeys(
      getWorkflowInputId(workflowInput),
      inputById,
    )) {
      metadata[inputKey] = inputMetadata;
    }
  }

  return metadata;
}
