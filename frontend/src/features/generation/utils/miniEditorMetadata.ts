import type { GeneratedMiniEditorEdit } from "../../../types/Asset";
import { parseTimelineSelection } from "../../timelineSelection";
import type { EditorRangeMask } from "../../miniEditor";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate the edit instructions when reading a saved generation panel. */
export function parseMiniEditorEdit(
  value: unknown,
  projectFps = 30,
): GeneratedMiniEditorEdit | undefined {
  if (!isRecord(value) || !isRecord(value.spec)) return undefined;
  const { spec } = value;
  if (
    !isFiniteNumber(spec.cropStartTicks) || spec.cropStartTicks < 0 ||
    !isFiniteNumber(spec.cropEndTicks) || spec.cropEndTicks <= spec.cropStartTicks ||
    !Array.isArray(spec.ranges)
  ) return undefined;

  const ranges: EditorRangeMask[] = [];
  for (const range of spec.ranges) {
    if (
      !isRecord(range) || typeof range.id !== "string" ||
      !isFiniteNumber(range.startSourceTicks) ||
      !isFiniteNumber(range.endSourceTicks) || typeof range.isActive !== "boolean"
    ) return undefined;
    ranges.push({
      id: range.id,
      startSourceTicks: range.startSourceTicks,
      endSourceTicks: range.endSourceTicks,
      isActive: range.isActive,
      ...(typeof range.name === "string" ? { name: range.name } : {}),
    });
  }

  const assetId = typeof value.assetId === "string" ? value.assetId : null;
  const selection = value.timelineSelection;
  const timelineSelection = parseTimelineSelection(selection, projectFps);
  if (!assetId && !timelineSelection) return undefined;

  let render: GeneratedMiniEditorEdit["render"];
  if (value.render !== undefined) {
    if (!isRecord(value.render)) return undefined;
    const { width, height, fps } = value.render;
    if (
      !isFiniteNumber(width) || width <= 0 ||
      !isFiniteNumber(height) || height <= 0 ||
      !isFiniteNumber(fps) || fps <= 0
    ) return undefined;
    render = { width, height, fps };
  }
  return {
    assetId,
    ...(timelineSelection ? { timelineSelection } : {}),
    spec: {
      cropStartTicks: spec.cropStartTicks,
      cropEndTicks: spec.cropEndTicks,
      ranges,
    },
    ...(render ? { render } : {}),
  };
}
