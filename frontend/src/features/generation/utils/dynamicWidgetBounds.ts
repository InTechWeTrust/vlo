import type { WidgetBoundReference, WorkflowWidgetInput } from "../types";
import type { WidgetValueMap } from "./widgetValueReconciliation";

/**
 * Bounds that follow another widget instead of a constant.
 *
 * A sampling window authored against the step count it runs inside — the
 * time-to-move lock-in/hold sliders against "Steps" — cannot state its ceiling
 * as a number in the rules: the user moves that ceiling. Rules declare
 * `min_from`/`max_from` pointing at the widget the bound tracks, and this
 * resolves them against what the panel currently holds.
 *
 * Out-of-range values are pulled back in as the bound moves, so lowering the
 * step count cannot leave a window pointing past the last step the sampler
 * runs. The clamps are reported rather than applied here: the panel owns the
 * widget values.
 */

export interface ClampedWidgetValue {
  nodeId: string;
  param: string;
  value: number;
}

export interface DynamicWidgetBoundsResult {
  /** The inputs with resolved bounds, or the input array itself when none moved. */
  widgetInputs: readonly WorkflowWidgetInput[];
  clamped: ClampedWidgetValue[];
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function widgetKey(nodeId: string, param: string): string {
  return `${nodeId}:${param}`;
}

function resolveBound(
  bound: WidgetBoundReference | undefined,
  staticBound: number | undefined,
  values: ReadonlyMap<string, number>,
): number | undefined {
  if (!bound) return staticBound;
  const base = values.get(widgetKey(bound.nodeId, bound.param));
  // A bound whose widget is not on the panel (hidden, bypassed, or driven by a
  // link) falls back to the authored constant rather than vanishing.
  if (base === undefined) return staticBound;
  return base + bound.offset;
}

export function applyDynamicWidgetBounds(options: {
  widgetInputs: readonly WorkflowWidgetInput[];
  widgetValues: WidgetValueMap;
}): DynamicWidgetBoundsResult {
  const { widgetInputs, widgetValues } = options;
  if (
    !widgetInputs.some(
      (widget) => widget.config.minFrom || widget.config.maxFrom,
    )
  ) {
    return { widgetInputs, clamped: [] };
  }

  const values = new Map<string, number>();
  for (const widget of widgetInputs) {
    const raw =
      widgetValues[widget.nodeId]?.[widget.param] ?? widget.currentValue;
    const numeric = toFiniteNumber(raw);
    if (numeric !== null) {
      values.set(widgetKey(widget.nodeId, widget.param), numeric);
    }
  }

  const clamped: ClampedWidgetValue[] = [];
  let changed = false;
  const resolved = widgetInputs.map((widget) => {
    const { minFrom, maxFrom } = widget.config;
    if (!minFrom && !maxFrom) return widget;

    const min = resolveBound(minFrom, widget.config.min, values);
    let max = resolveBound(maxFrom, widget.config.max, values);
    // A collapsed range (steps low enough that the ceiling falls under the
    // floor) renders as a single legal value rather than an inverted slider.
    if (min !== undefined && max !== undefined && max < min) {
      max = min;
    }
    if (min === widget.config.min && max === widget.config.max) {
      return widget;
    }

    changed = true;
    const current = values.get(widgetKey(widget.nodeId, widget.param));
    if (current !== undefined) {
      const bounded = Math.min(
        max ?? current,
        Math.max(min ?? current, current),
      );
      if (bounded !== current) {
        clamped.push({
          nodeId: widget.nodeId,
          param: widget.param,
          value: bounded,
        });
      }
    }

    return { ...widget, config: { ...widget.config, min, max } };
  });

  return { widgetInputs: changed ? resolved : widgetInputs, clamped };
}
