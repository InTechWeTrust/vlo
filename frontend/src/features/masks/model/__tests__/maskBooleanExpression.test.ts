import { describe, expect, it } from "vitest";
import type {
  MaskBooleanExpression,
  MaskTimelineClip,
  StandardTimelineClip,
} from "../../../../types/TimelineTypes";
import {
  collectMaskBooleanLeafVariants,
  collectUnionMaskIds,
  getMaskBooleanLeafKey,
  sanitizeMaskBooleanExpression,
  toggleMaskBooleanExpressionInversionAtPath,
  resolveEditableMaskBooleanExpression,
  resolveMaskBooleanExpression,
  resolveRenderableMaskBooleanExpression,
} from "../maskBooleanExpression";

function createMaskClip(
  parentClipId: string,
  localId: string,
  mode: MaskTimelineClip["maskMode"] = "apply",
): MaskTimelineClip {
  return {
    id: `${parentClipId}::mask::${localId}`,
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
    parentClipId,
    maskType: "rectangle",
    maskMode: mode,
    maskInverted: false,
    maskParameters: {
      baseWidth: 100,
      baseHeight: 100,
    },
  };
}

describe("maskBooleanExpression helpers", () => {
  it("renderable expression matches the resolved editor expression", () => {
    const parent: Pick<StandardTimelineClip, "components"> = {
      components: [
        {
          id: "mask_composition_1",
          type: "mask_composition",
          parameters: {
            expression: {
              kind: "operation",
              operator: "intersect",
              left: {
                kind: "mask_ref",
                maskId: "mask_a",
              },
              right: {
                kind: "mask_ref",
                maskId: "mask_b",
              },
            },
            compositeTransformations: [],
          },
        },
      ],
    };
    const maskA = createMaskClip("clip_1", "mask_a", "apply");
    const maskB = createMaskClip("clip_1", "mask_b", "preview");

    const expected = {
      kind: "operation",
      operator: "intersect",
      left: {
        kind: "mask_ref",
        maskId: "mask_a",
      },
      right: {
        kind: "mask_ref",
        maskId: "mask_b",
      },
    };

    expect(resolveMaskBooleanExpression(parent, [maskA, maskB])).toEqual(expected);
    expect(resolveRenderableMaskBooleanExpression(parent, [maskA, maskB])).toEqual(
      expected,
    );
  });

  it("keeps the editable equation available when evaluation is disabled", () => {
    const parent: Pick<StandardTimelineClip, "components"> = {
      components: [
        {
          id: "mask_composition_1",
          type: "mask_composition",
          parameters: {
            expressionEnabled: false,
            compositeTransformations: [],
          },
        },
      ],
    };
    const maskA = createMaskClip("clip_1", "mask_a", "apply");

    const expected = {
      kind: "mask_ref",
      maskId: "mask_a",
    };

    expect(resolveMaskBooleanExpression(parent, [maskA])).toBeNull();
    expect(resolveRenderableMaskBooleanExpression(parent, [maskA])).toBeNull();
    expect(resolveEditableMaskBooleanExpression(parent, [maskA])).toEqual(
      expected,
    );
  });
});

describe("mask reference inversion", () => {
  const union: MaskBooleanExpression = {
    kind: "operation",
    operator: "union",
    left: { kind: "mask_ref", maskId: "a" },
    right: { kind: "mask_ref", maskId: "b" },
  };

  it("toggles the inversion of the reference at a path and back", () => {
    const inverted = toggleMaskBooleanExpressionInversionAtPath(union, [
      "right",
    ]);
    expect(inverted).toEqual({
      ...union,
      right: { kind: "mask_ref", maskId: "b", inverted: true },
    });

    // Restoring drops the flag entirely rather than persisting `false`.
    expect(
      toggleMaskBooleanExpressionInversionAtPath(inverted, ["right"]),
    ).toEqual(union);
  });

  it("leaves operation nodes untouched", () => {
    expect(toggleMaskBooleanExpressionInversionAtPath(union, [])).toEqual(
      union,
    );
  });

  it("collects distinct (mask, inversion) leaf variants", () => {
    const expression: MaskBooleanExpression = {
      kind: "operation",
      operator: "subtract",
      left: {
        kind: "operation",
        operator: "union",
        left: { kind: "mask_ref", maskId: "a" },
        right: { kind: "mask_ref", maskId: "a", inverted: true },
      },
      right: { kind: "mask_ref", maskId: "a" },
    };
    expect(collectMaskBooleanLeafVariants(expression)).toEqual([
      { maskId: "a", inverted: false },
      { maskId: "a", inverted: true },
    ]);
    expect(getMaskBooleanLeafKey("a", false)).not.toBe(
      getMaskBooleanLeafKey("a", true),
    );
  });

  it("keeps leaf keys distinct for mask IDs that look like encoded variants", () => {
    const keys = [
      getMaskBooleanLeafKey("a", true),
      getMaskBooleanLeafKey("a::inverted", false),
      getMaskBooleanLeafKey("a::inverted", true),
      getMaskBooleanLeafKey('["a",true]', false),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not treat a union containing an inverted reference as a simple union", () => {
    expect(collectUnionMaskIds(union)).toEqual(["a", "b"]);
    expect(
      collectUnionMaskIds(
        toggleMaskBooleanExpressionInversionAtPath(union, ["left"]),
      ),
    ).toBeNull();
  });

  it("keeps the inversion flag when sanitizing", () => {
    const inverted = toggleMaskBooleanExpressionInversionAtPath(union, [
      "left",
    ]);
    expect(sanitizeMaskBooleanExpression(inverted, ["a"])).toEqual({
      kind: "mask_ref",
      maskId: "a",
      inverted: true,
    });
  });
});
