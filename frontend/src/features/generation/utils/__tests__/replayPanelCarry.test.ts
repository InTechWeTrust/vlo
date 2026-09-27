import { describe, expect, it } from "vitest";
import { EMPTY_GENERATION_PANEL_VALUES } from "../../persistence/generationPanelSnapshot";
import type { WorkflowReplayPanelState } from "../../store/types";
import type { WorkflowWidgetInput } from "../../types";
import {
  createReplayPanelCarry,
  takeLateReplayWidgets,
  withPendingReplayCarry,
} from "../replayPanelCarry";

const length: WorkflowWidgetInput = {
  nodeId: "136",
  param: "length",
  currentValue: 124,
  config: { label: "Length", controlAfterGenerate: false, valueType: "int" },
};

const lora: WorkflowWidgetInput = {
  nodeId: "4",
  param: "lora_name",
  currentValue: "base.safetensors",
  config: {
    label: "Model",
    controlAfterGenerate: false,
    valueType: "enum",
    options: ["base.safetensors", "detail.safetensors"],
    nodeBypassOption: { value: "native:none", label: "None (bypass)" },
  },
};

const unrelated: WorkflowWidgetInput = {
  nodeId: "9",
  param: "cfg",
  currentValue: 1,
  config: { label: "CFG", controlAfterGenerate: false, valueType: "float" },
};

const state: WorkflowReplayPanelState = {
  textValues: {},
  widgetValues: {
    widget_136_length: "311",
    widget_4_lora_name: "detail.safetensors",
  },
  widgetModes: {},
  derivedWidgetValues: {},
  bypassNodeIds: ["4"],
};

describe("replay panel carry", () => {
  it("hands over each late widget the replay covers exactly once", () => {
    const carry = createReplayPanelCarry("wf.json", state, [length]);

    const first = takeLateReplayWidgets(carry, [length, lora, unrelated]);
    expect(first.widgets).toEqual([lora]);

    const second = takeLateReplayWidgets(first.carry, [length, lora, unrelated]);
    expect(second.widgets).toEqual([]);
    expect(second.carry).toBe(first.carry);
  });

  it("publishes what late widgets are still owed, under the panel's own values", () => {
    const carry = createReplayPanelCarry("wf.json", state, [length]);
    const values = withPendingReplayCarry(
      {
        ...EMPTY_GENERATION_PANEL_VALUES,
        frontendStateWidgetValues: { widget_136_length: 200 },
      },
      carry,
    );

    expect(values.frontendStateWidgetValues).toEqual({
      widget_136_length: 200,
      widget_4_lora_name: "detail.safetensors",
    });
    expect(values.bypassNodeIds).toEqual(["4"]);

    const settled = takeLateReplayWidgets(carry, [length, lora]).carry;
    const current = { ...EMPTY_GENERATION_PANEL_VALUES };
    expect(withPendingReplayCarry(current, settled)).toBe(current);
  });
});
