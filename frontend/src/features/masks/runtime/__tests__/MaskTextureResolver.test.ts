import { Container, type Renderer, type Sprite } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import type {
  MaskBooleanExpression,
  MaskTimelineClip,
} from "../../../../types/TimelineTypes";
import { analyzeMaskBooleanExpression } from "../../model/maskBooleanExpression";
import type { MaskSceneNodeRegistry } from "../MaskSceneNodeRegistry";
import { MaskTextureResolver } from "../MaskTextureResolver";

function createMaskClip(
  localId: string,
  maskInverted: boolean,
): MaskTimelineClip {
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
    maskInverted,
    maskParameters: { baseWidth: 100, baseHeight: 100 },
  };
}

/**
 * Resolve `expression` over vector masks and count the coverage-invert passes
 * the pipeline issued. Leaf rendering is the only place that inverts when the
 * composite state carries no edge ops.
 */
function countInvertPasses(
  expression: MaskBooleanExpression,
  maskClips: MaskTimelineClip[],
): number {
  const renderedFilters: unknown[][] = [];
  const renderer = {
    render: vi.fn(({ container }: { container: Container }) => {
      renderedFilters.push([...((container.filters as unknown[]) ?? [])]);
    }),
  } as unknown as Renderer;
  const maskContainer = new Container();
  const registry = {
    vectorMaskNodes: new Map(
      maskClips.map((clip) => [clip.id, { root: { visible: false } }]),
    ),
    assetMaskNodes: new Map(),
    getMaskContainer: () => maskContainer,
    getAssetNode: () => null,
  } as unknown as MaskSceneNodeRegistry;
  const resolver = new MaskTextureResolver(
    renderer,
    registry,
    (_sprite: Sprite) => true,
  );

  const texture = resolver.resolveCoverageTexture({
    expression,
    expressionAnalysis: analyzeMaskBooleanExpression(expression),
    maskClipByLocalId: new Map(
      maskClips.map((clip) => [clip.id.split("::mask::")[1], clip]),
    ),
    contentSize: { width: 64, height: 64 },
    compositeState: {
      compositeInvert: false,
      growAmount: 0,
      growInvert: false,
      feather: null,
    },
  });
  expect(texture).not.toBeNull();

  const invertFilter = (
    resolver as unknown as { maskCoverageInvertFilter: unknown }
  ).maskCoverageInvertFilter;
  const count = invertFilter
    ? renderedFilters.filter((filters) => filters.includes(invertFilter))
        .length
    : 0;
  resolver.dispose();
  return count;
}

describe("MaskTextureResolver equation-level inversion", () => {
  it("inverts a plain mask referenced as inverted", () => {
    expect(
      countInvertPasses({ kind: "mask_ref", maskId: "a", inverted: true }, [
        createMaskClip("a", false),
      ]),
    ).toBe(1);
  });

  it("passes an inverted mask through untouched when the equation inverts it again", () => {
    expect(
      countInvertPasses({ kind: "mask_ref", maskId: "a", inverted: true }, [
        createMaskClip("a", true),
      ]),
    ).toBe(0);
    expect(
      countInvertPasses({ kind: "mask_ref", maskId: "a" }, [
        createMaskClip("a", true),
      ]),
    ).toBe(1);
  });

  it("renders a mask referenced both ways as two independent leaves", () => {
    expect(
      countInvertPasses(
        {
          kind: "operation",
          operator: "union",
          left: { kind: "mask_ref", maskId: "a" },
          right: { kind: "mask_ref", maskId: "a", inverted: true },
        },
        [createMaskClip("a", false)],
      ),
    ).toBe(1);
  });
});

describe("MaskTextureResolver leaf keys", () => {
  it("gives an inverted mask and a plain mask named like its variant separate leaf textures", () => {
    // A suffix-encoded key would map plain `a::inverted` and inverted `a` to
    // one pooled texture, letting the last-rendered leaf overwrite both.
    const maskClips = [
      createMaskClip("a", false),
      createMaskClip("a::inverted", false),
    ];
    const expression: MaskBooleanExpression = {
      kind: "operation",
      operator: "intersect",
      left: { kind: "mask_ref", maskId: "a", inverted: true },
      right: { kind: "mask_ref", maskId: "a::inverted" },
    };
    const maskContainer = new Container();
    const registry = {
      vectorMaskNodes: new Map(
        maskClips.map((clip) => [clip.id, { root: { visible: false } }]),
      ),
      assetMaskNodes: new Map(),
      getMaskContainer: () => maskContainer,
      getAssetNode: () => null,
    } as unknown as MaskSceneNodeRegistry;
    const resolver = new MaskTextureResolver(
      { render: vi.fn() } as unknown as Renderer,
      registry,
      () => true,
    );

    resolver.resolveCoverageTexture({
      expression,
      expressionAnalysis: analyzeMaskBooleanExpression(expression),
      maskClipByLocalId: new Map([
        ["a", maskClips[0]],
        ["a::inverted", maskClips[1]],
      ]),
      contentSize: { width: 64, height: 64 },
      compositeState: {
        compositeInvert: false,
        growAmount: 0,
        growInvert: false,
        feather: null,
      },
    });

    const pool = (
      resolver as unknown as {
        pool: { getLeafMaskRenderTextures(): ReadonlyMap<string, unknown> };
      }
    ).pool;
    expect(pool.getLeafMaskRenderTextures().size).toBe(2);
    resolver.dispose();
  });
});
