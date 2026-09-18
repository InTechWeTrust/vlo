import type { WorkflowWidgetInput } from "../types";

/**
 * One row in a widget group: a lone widget, or a start/end pair drawn as a
 * single range slider because its rules declare `range`.
 */
export type WidgetGroupRow =
  | { kind: "single"; widget: WorkflowWidgetInput }
  | {
      kind: "range";
      low: WorkflowWidgetInput;
      high: WorkflowWidgetInput;
    };

function isPlainSlider(widget: WorkflowWidgetInput): boolean {
  return (
    widget.config.control === "slider" &&
    !(widget.config.resolutionLadder?.length ?? 0)
  );
}

/**
 * Folds each declared start/end pair into one row, placed where the start
 * widget sits.
 *
 * Pairing only happens inside one group and only between two plain sliders:
 * an end widget that is hidden, in another group, or rendered some other way
 * leaves both widgets as ordinary rows rather than half a range.
 */
export function pairRangeWidgets(
  widgets: readonly WorkflowWidgetInput[],
): WidgetGroupRow[] {
  const byKey = new Map(
    widgets.map((widget) => [`${widget.nodeId}:${widget.param}`, widget]),
  );
  const highFor = new Map<WorkflowWidgetInput, WorkflowWidgetInput>();
  const claimed = new Set<WorkflowWidgetInput>();

  for (const low of widgets) {
    const range = low.config.range;
    if (!range || claimed.has(low) || !isPlainSlider(low)) continue;
    const high = byKey.get(`${range.endNodeId}:${range.endParam}`);
    if (
      !high ||
      high === low ||
      claimed.has(high) ||
      highFor.has(high) ||
      !isPlainSlider(high)
    ) {
      continue;
    }
    highFor.set(low, high);
    claimed.add(low);
    claimed.add(high);
  }

  const rows: WidgetGroupRow[] = [];
  for (const widget of widgets) {
    const high = highFor.get(widget);
    if (high) {
      rows.push({ kind: "range", low: widget, high });
    } else if (!claimed.has(widget)) {
      rows.push({ kind: "single", widget });
    }
  }
  return rows;
}
