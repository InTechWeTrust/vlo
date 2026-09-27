import type { GenerationPanelValuesSnapshot } from "../persistence/generationPanelSnapshot";
import {
  buildFrontendStateDerivedWidgetKey,
  buildFrontendStateValueKey,
} from "../services/frontendRuleState";
import type { WorkflowReplayPanelState } from "../store/types";
import type { WorkflowWidgetInput } from "../types";

/**
 * What a hydrated replay state still owes widgets that were not on screen
 * when it was applied.
 *
 * Hydration happens once, against whatever widgets exist at that moment, but
 * a workflow's widgets arrive in stages: LoRA loaders need ComfyUI's object
 * info, and widgets gated on an input need that input restored. Without the
 * carry a widget arriving late starts from the workflow's own value, and the
 * saved one is lost — from the panel, and from the project on the next save.
 */
export interface ReplayPanelCarry {
  /** Node ids only mean identity within one workflow. */
  readonly workflowId: string | null;
  readonly state: WorkflowReplayPanelState;
  /** Replay value keys whose widget has been hydrated. */
  readonly settledValueKeys: ReadonlySet<string>;
  readonly settledModeKeys: ReadonlySet<string>;
  /** Nodes whose bypass choice has been hydrated. */
  readonly settledBypassNodeIds: ReadonlySet<string>;
}

function getReplayValueKey(widget: WorkflowWidgetInput): string {
  return widget.kind === "derived"
    ? buildFrontendStateDerivedWidgetKey(widget.derivedWidgetId)
    : buildFrontendStateValueKey({
        nodeId: widget.nodeId,
        widget: widget.param,
        frontendControlId: widget.frontendControlId,
      });
}

function getReplayModeKey(widget: WorkflowWidgetInput): string {
  return `widget_mode_${widget.nodeId}_${widget.param}`;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Whether the replay state says anything about this widget. */
function isCoveredByReplay(
  state: WorkflowReplayPanelState,
  widget: WorkflowWidgetInput,
): boolean {
  const valueKey = getReplayValueKey(widget);
  return (
    hasOwn(state.widgetValues, valueKey) ||
    hasOwn(state.derivedWidgetValues, valueKey) ||
    hasOwn(state.widgetModes, getReplayModeKey(widget)) ||
    (widget.config.nodeBypassOption !== undefined &&
      ((state.bypassNodeIds ?? []).includes(widget.nodeId) ||
        (state.activateNodeIds ?? []).includes(widget.nodeId)))
  );
}

function settle(
  carry: ReplayPanelCarry,
  widgets: readonly WorkflowWidgetInput[],
): ReplayPanelCarry {
  const settledValueKeys = new Set(carry.settledValueKeys);
  const settledModeKeys = new Set(carry.settledModeKeys);
  const settledBypassNodeIds = new Set(carry.settledBypassNodeIds);
  for (const widget of widgets) {
    settledValueKeys.add(getReplayValueKey(widget));
    settledModeKeys.add(getReplayModeKey(widget));
    if (widget.config.nodeBypassOption) settledBypassNodeIds.add(widget.nodeId);
  }
  return { ...carry, settledValueKeys, settledModeKeys, settledBypassNodeIds };
}

/** The carry left after hydrating `state` against the widgets on screen. */
export function createReplayPanelCarry(
  workflowId: string | null,
  state: WorkflowReplayPanelState,
  hydratedWidgets: readonly WorkflowWidgetInput[],
): ReplayPanelCarry {
  return settle(
    {
      workflowId,
      state,
      settledValueKeys: new Set(),
      settledModeKeys: new Set(),
      settledBypassNodeIds: new Set(),
    },
    hydratedWidgets,
  );
}

/**
 * Splits off the widgets that have appeared since the carry was made and
 * that the replay state has something to say about. Every widget on screen
 * counts as settled afterwards, so each is hydrated at most once and the
 * user's own edits are never overwritten by a later pass.
 */
export function takeLateReplayWidgets(
  carry: ReplayPanelCarry,
  widgetInputs: readonly WorkflowWidgetInput[],
): { carry: ReplayPanelCarry; widgets: WorkflowWidgetInput[] } {
  const late = widgetInputs.filter(
    (widget) =>
      !carry.settledValueKeys.has(getReplayValueKey(widget)) &&
      isCoveredByReplay(carry.state, widget),
  );
  const unsettled = widgetInputs.some(
    (widget) => !carry.settledValueKeys.has(getReplayValueKey(widget)),
  );
  return {
    carry: unsettled ? settle(carry, widgetInputs) : carry,
    widgets: late,
  };
}

/**
 * Adds what the carry still holds to the values the panel publishes for
 * saving. Until a widget appears, its saved value is the only copy of what
 * the user chose; publishing it keeps a save in the meantime from recording
 * the widget as though it had never been set. Values the panel holds itself
 * always win.
 */
export function withPendingReplayCarry(
  values: GenerationPanelValuesSnapshot,
  carry: ReplayPanelCarry | null,
): GenerationPanelValuesSnapshot {
  if (!carry) return values;
  const { state } = carry;

  const pendingEntries = (record: Record<string, string>, settled: ReadonlySet<string>) =>
    Object.entries(record).filter(([key]) => !settled.has(key));
  const pendingValues = pendingEntries(state.widgetValues, carry.settledValueKeys);
  const pendingDerived = pendingEntries(
    state.derivedWidgetValues,
    carry.settledValueKeys,
  );
  const pendingModes = Object.entries(state.widgetModes).filter(
    ([key]) => !carry.settledModeKeys.has(key),
  );
  const pendingBypass = (state.bypassNodeIds ?? []).filter(
    (nodeId) => !carry.settledBypassNodeIds.has(nodeId),
  );
  const pendingActivate = (state.activateNodeIds ?? []).filter(
    (nodeId) => !carry.settledBypassNodeIds.has(nodeId),
  );
  if (
    pendingValues.length === 0 &&
    pendingDerived.length === 0 &&
    pendingModes.length === 0 &&
    pendingBypass.length === 0 &&
    pendingActivate.length === 0
  ) {
    return values;
  }

  return {
    ...values,
    frontendStateWidgetValues: {
      ...Object.fromEntries(pendingValues),
      ...values.frontendStateWidgetValues,
    },
    derivedWidgetInputs: {
      ...Object.fromEntries(pendingDerived),
      ...values.derivedWidgetInputs,
    },
    widgetModes: {
      ...Object.fromEntries(pendingModes),
      ...values.widgetModes,
    },
    bypassNodeIds: [...new Set([...values.bypassNodeIds, ...pendingBypass])],
    activateNodeIds: [
      ...new Set([...values.activateNodeIds, ...pendingActivate]),
    ],
  };
}
