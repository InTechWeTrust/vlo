import { describe, expect, it } from "vitest";
import type { WorkflowWidgetInput } from "../../types";
import { applyDynamicWidgetBounds } from "../dynamicWidgetBounds";

const steps: WorkflowWidgetInput = {
  nodeId: "28",
  param: "steps",
  currentValue: 20,
  config: {
    label: "Steps",
    controlAfterGenerate: false,
    valueType: "int",
    control: "slider",
    min: 1,
    max: 60,
    step: 1,
  },
};

const startStep: WorkflowWidgetInput = {
  nodeId: "26",
  param: "start_step",
  currentValue: 1,
  config: {
    label: "Motion lock-in",
    controlAfterGenerate: false,
    valueType: "int",
    control: "slider",
    min: 0,
    max: 60,
    step: 1,
    maxFrom: { nodeId: "28", param: "steps", offset: -1 },
  },
};

const endStep: WorkflowWidgetInput = {
  nodeId: "26",
  param: "end_step",
  currentValue: 2,
  config: {
    ...startStep.config,
    label: "Motion hold",
    maxFrom: { nodeId: "28", param: "steps", offset: 0 },
  },
};

function boundsOf(
  widgetInputs: readonly WorkflowWidgetInput[],
  param: string,
): { min?: number; max?: number } {
  const widget = widgetInputs.find((candidate) => candidate.param === param);
  return { min: widget?.config.min, max: widget?.config.max };
}

describe("dynamic widget bounds", () => {
  it("follows the referenced widget's authored value", () => {
    const result = applyDynamicWidgetBounds({
      widgetInputs: [steps, startStep, endStep],
      widgetValues: {},
    });

    expect(boundsOf(result.widgetInputs, "start_step")).toEqual({
      min: 0,
      max: 19,
    });
    expect(boundsOf(result.widgetInputs, "end_step")).toEqual({
      min: 0,
      max: 20,
    });
    expect(result.clamped).toEqual([]);
  });

  it("follows the panel's edit rather than the workflow value", () => {
    const result = applyDynamicWidgetBounds({
      widgetInputs: [steps, startStep, endStep],
      widgetValues: { "28": { steps: 40 } },
    });

    expect(boundsOf(result.widgetInputs, "start_step").max).toBe(39);
    expect(boundsOf(result.widgetInputs, "end_step").max).toBe(40);
  });

  it("pulls values back in when the bound drops below them", () => {
    const result = applyDynamicWidgetBounds({
      widgetInputs: [steps, startStep, endStep],
      widgetValues: { "28": { steps: 4 }, "26": { start_step: 12, end_step: 15 } },
    });

    expect(boundsOf(result.widgetInputs, "start_step").max).toBe(3);
    expect(result.clamped).toEqual([
      { nodeId: "26", param: "start_step", value: 3 },
      { nodeId: "26", param: "end_step", value: 4 },
    ]);
  });

  it("keeps the authored bound when the referenced widget is absent", () => {
    const result = applyDynamicWidgetBounds({
      widgetInputs: [startStep],
      widgetValues: {},
    });

    expect(boundsOf(result.widgetInputs, "start_step")).toEqual({
      min: 0,
      max: 60,
    });
  });

  it("never inverts a slider whose ceiling falls under its floor", () => {
    const result = applyDynamicWidgetBounds({
      widgetInputs: [{ ...steps, currentValue: 1 }, startStep],
      widgetValues: {},
    });

    expect(boundsOf(result.widgetInputs, "start_step")).toEqual({
      min: 0,
      max: 0,
    });
  });

  it("returns the inputs untouched when no rule declares a bound", () => {
    const widgetInputs = [steps];
    const result = applyDynamicWidgetBounds({ widgetInputs, widgetValues: {} });

    expect(result.widgetInputs).toBe(widgetInputs);
    expect(result.clamped).toEqual([]);
  });
});
