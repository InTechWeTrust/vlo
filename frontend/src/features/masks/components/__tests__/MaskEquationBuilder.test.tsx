import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  MaskBooleanExpression,
  MaskTimelineClip,
} from "../../../../types/TimelineTypes";
import { MaskEquationBuilder } from "../MaskEquationBuilder";

function createMaskClip(localId: string): MaskTimelineClip {
  return {
    id: `clip_1::mask::${localId}`,
    trackId: "track_1",
    type: "mask",
    name: `Mask ${localId}`,
    sourceDuration: 100,
    start: 0,
    timelineDuration: 100,
    offset: 0,
    transformedDuration: 100,
    transformedOffset: 0,
    croppedSourceDuration: 100,
    transformations: [],
    parentClipId: "clip_1",
    maskType: "rectangle",
    maskMode: "apply",
    maskInverted: false,
    maskParameters: { baseWidth: 100, baseHeight: 100 },
  };
}

function renderBuilder(expression: MaskBooleanExpression) {
  const onExpressionChange = vi.fn();
  render(
    <MaskEquationBuilder
      masks={[createMaskClip("a"), createMaskClip("b")]}
      expression={expression}
      onExpressionChange={onExpressionChange}
      expressionEnabled
      onExpressionEnabledChange={vi.fn()}
    />,
  );
  return onExpressionChange;
}

describe("MaskEquationBuilder inversion", () => {
  const union: MaskBooleanExpression = {
    kind: "operation",
    operator: "union",
    left: { kind: "mask_ref", maskId: "a" },
    right: { kind: "mask_ref", maskId: "b" },
  };

  it("inverts a reference on right-click", () => {
    const onExpressionChange = renderBuilder(union);

    const chip = screen.getByTestId("mask-equation-mask-right");
    expect(chip).toHaveAttribute("data-inverted", "false");
    const notPrevented = fireEvent.contextMenu(chip);

    expect(notPrevented).toBe(false);
    expect(onExpressionChange).toHaveBeenCalledWith({
      ...union,
      right: { kind: "mask_ref", maskId: "b", inverted: true },
    });
  });

  it("marks an inverted reference and restores it on right-click", () => {
    const onExpressionChange = renderBuilder({
      ...union,
      left: { kind: "mask_ref", maskId: "a", inverted: true },
    });

    const chip = screen.getByTestId("mask-equation-mask-left");
    expect(chip).toHaveAttribute("data-inverted", "true");
    expect(chip).toHaveAccessibleName("Inverse of Mask 1");
    fireEvent.contextMenu(chip);

    expect(onExpressionChange).toHaveBeenCalledWith(union);
  });
});
