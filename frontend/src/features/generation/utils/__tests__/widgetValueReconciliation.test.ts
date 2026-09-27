import { describe, expect, it } from "vitest";
import type { RawWorkflowWidgetInput } from "../../types";
import {
  reconcileWidgetValues,
  type WidgetCurrentValueMap,
  type WidgetValueMap,
} from "../widgetValueReconciliation";

function makeWidget(
  currentValue: unknown,
  overrides: Partial<RawWorkflowWidgetInput> = {},
): RawWorkflowWidgetInput {
  return {
    nodeId: "12",
    param: "strength",
    currentValue,
    config: {
      label: "Strength",
      controlAfterGenerate: false,
    },
    ...overrides,
  };
}

function reconcile(
  widgetInputs: RawWorkflowWidgetInput[],
  previousValues: WidgetValueMap = {},
  previousCurrentValues: WidgetCurrentValueMap = {},
) {
  return reconcileWidgetValues({
    widgetInputs,
    previousValues,
    previousCurrentValues,
  });
}

describe("reconcileWidgetValues", () => {
  it("initializes newly added widgets from their current value", () => {
    const result = reconcile([makeWidget(0.4)]);

    expect(result.values).toEqual({
      "12": {
        strength: 0.4,
      },
    });
    expect(result.currentValues).toEqual({
      "12:strength": 0.4,
    });
    expect(result.valuesChanged).toBe(true);
    expect(result.currentValuesChanged).toBe(true);
  });

  it("preserves externally applied values during harmless widget refreshes", () => {
    const result = reconcile(
      [makeWidget(0.4)],
      {
        "12": {
          strength: 0.73,
        },
      },
      {
        "12:strength": 0.4,
      },
    );

    expect(result.values).toEqual({
      "12": {
        strength: 0.73,
      },
    });
    expect(result.valuesChanged).toBe(false);
  });

  it("preserves user-edited values during harmless widget refreshes", () => {
    const result = reconcile(
      [makeWidget(0.4)],
      {
        "12": {
          strength: 0.55,
        },
      },
      {
        "12:strength": 0.4,
      },
    );

    expect(result.values).toEqual({
      "12": {
        strength: 0.55,
      },
    });
    expect(result.valuesChanged).toBe(false);
  });

  it("updates untouched widgets when their backing current value changes", () => {
    const result = reconcile(
      [makeWidget(0.8)],
      {
        "12": {
          strength: 0.4,
        },
      },
      {
        "12:strength": 0.4,
      },
    );

    expect(result.values).toEqual({
      "12": {
        strength: 0.8,
      },
    });
    expect(result.currentValues).toEqual({
      "12:strength": 0.8,
    });
    expect(result.valuesChanged).toBe(true);
  });

  it("updates user-edited widgets when their backing value really changes", () => {
    const result = reconcile(
      [makeWidget(0.8)],
      {
        "12": {
          strength: 0.55,
        },
      },
      {
        "12:strength": 0.4,
      },
    );

    expect(result.values).toEqual({
      "12": {
        strength: 0.8,
      },
    });
    expect(result.currentValues).toEqual({
      "12:strength": 0.8,
    });
    expect(result.valuesChanged).toBe(true);
  });

  it("drops values and current-value tracking for widgets that disappeared", () => {
    const result = reconcile(
      [],
      {
        "12": {
          strength: 0.55,
        },
      },
      {
        "12:strength": 0.4,
      },
    );

    expect(result.values).toEqual({});
    expect(result.currentValues).toEqual({});
    expect(result.valuesChanged).toBe(true);
    expect(result.currentValuesChanged).toBe(true);
  });

  it("keeps values for absent widgets when asked to preserve them", () => {
    const result = reconcileWidgetValues({
      widgetInputs: [],
      previousValues: { "12": { strength: 0.9 } },
      previousCurrentValues: { "12:strength": 0.4 },
      preserveMissing: true,
    });
    expect(result.valuesChanged).toBe(false);
    expect(result.currentValuesChanged).toBe(false);

    // Back with an unchanged backing value, the widget keeps its own.
    const returned = reconcile(
      [makeWidget(0.4)],
      result.values,
      result.currentValues,
    );
    expect(returned.values).toEqual({ "12": { strength: 0.9 } });
  });
});
