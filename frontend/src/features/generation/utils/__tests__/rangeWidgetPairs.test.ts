import { describe, expect, it } from "vitest";
import type { WorkflowWidgetInput } from "../../types";
import { pairRangeWidgets } from "../rangeWidgetPairs";

function slider(
  param: string,
  extra: Partial<WorkflowWidgetInput["config"]> = {},
): WorkflowWidgetInput {
  return {
    nodeId: "26",
    param,
    currentValue: 1,
    config: {
      label: param,
      controlAfterGenerate: false,
      control: "slider",
      min: 0,
      max: 20,
      step: 1,
      ...extra,
    },
  };
}

const pairing = { endNodeId: "26", endParam: "end_step", minDistance: 0 };

describe("pairRangeWidgets", () => {
  it("folds a declared pair into one row where the start sits", () => {
    const seed = slider("seed");
    const start = slider("start_step", { range: pairing });
    const end = slider("end_step");

    expect(pairRangeWidgets([seed, end, start])).toEqual([
      { kind: "single", widget: seed },
      { kind: "range", low: start, high: end },
    ]);
  });

  it("leaves the start alone when its end is not in the group", () => {
    const start = slider("start_step", { range: pairing });

    expect(pairRangeWidgets([start])).toEqual([
      { kind: "single", widget: start },
    ]);
  });

  it("only pairs two plain sliders", () => {
    const start = slider("start_step", { range: pairing });
    const end = slider("end_step", { control: undefined });

    expect(pairRangeWidgets([start, end])).toEqual([
      { kind: "single", widget: start },
      { kind: "single", widget: end },
    ]);
  });

  it("never pairs a widget with itself or claims an end twice", () => {
    const self = slider("end_step", { range: pairing });
    const other = slider("start_step", { range: pairing });

    // `end_step` points at itself, so only `start_step` can claim it.
    expect(pairRangeWidgets([self, other])).toEqual([
      { kind: "range", low: other, high: self },
    ]);
  });
});
