import { beforeEach, describe, expect, it, vi } from "vitest";
import { Texture, type Renderer } from "pixi.js";
import type { Asset } from "../../../../types/Asset";
import type { BrushBuffer } from "../brushBufferRegistry";

const {
  mockEnsureAssetSourceLoaded,
  mockEnsureBrushBuffer,
  mockGetBrushBuffer,
  mockHydrateBrushBufferFromUrl,
  mockIsBrushBufferEditing,
  mockIsBrushBufferReadyForSource,
  mockSubscribeToBrushBuffer,
} = vi.hoisted(() => ({
  mockEnsureAssetSourceLoaded: vi.fn(),
  mockEnsureBrushBuffer: vi.fn(),
  mockGetBrushBuffer: vi.fn<() => BrushBuffer | null>(() => null),
  mockHydrateBrushBufferFromUrl: vi.fn(async () => undefined),
  mockIsBrushBufferEditing: vi.fn(() => false),
  mockIsBrushBufferReadyForSource: vi.fn(() => false),
  mockSubscribeToBrushBuffer: vi.fn(() => () => undefined),
}));

vi.mock("../../../userAssets", () => ({
  ensureAssetSourceLoaded: mockEnsureAssetSourceLoaded,
}));

// Only the stateful registry functions are stubbed — `hasBrushContent` is a
// pure predicate and stays real so these tests exercise the actual content gate.
vi.mock("../brushBufferRegistry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../brushBufferRegistry")>()),
  ensureBrushBuffer: mockEnsureBrushBuffer,
  getBrushBuffer: mockGetBrushBuffer,
  getBrushBufferForRenderer: mockGetBrushBuffer,
  hydrateBrushBufferFromUrl: mockHydrateBrushBufferFromUrl,
  isBrushBufferEditing: mockIsBrushBufferEditing,
  isBrushBufferReadyForSource: mockIsBrushBufferReadyForSource,
  subscribeToBrushBuffer: mockSubscribeToBrushBuffer,
}));

import { BrushBufferMaskSource } from "../BrushBufferMaskSource";

function createAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "brush-asset-1",
    type: "image",
    name: "brush.png",
    src: "assets/brush.png",
    hash: "brush-hash",
    createdAt: 0,
    ...overrides,
  };
}

function createBrushBuffer(
  overrides: Partial<BrushBuffer> = {},
): BrushBuffer {
  return {
    renderer: {} as Renderer,
    renderTexture: Texture.EMPTY as never,
    canvasSize: { width: 128, height: 72 },
    paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    dirty: false,
    revision: 0,
    sourceAssetId: null,
    ...overrides,
  };
}

describe("BrushBufferMaskSource", () => {
  const brushRenderer = {} as Renderer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBrushBuffer.mockReturnValue(null);
    mockIsBrushBufferEditing.mockReturnValue(false);
    mockIsBrushBufferReadyForSource.mockReturnValue(false);
    mockEnsureAssetSourceLoaded.mockResolvedValue(null);
  });

  it("keeps the mask composited when the buffer loses its cached bounds", () => {
    // Regression: the buffer's `paintedBounds` is a cache of the clip's
    // persisted bounds, and a hydrate or buffer rebuild can drop it. Gating
    // visibility on it alone blanked the brush mask until an unrelated timeline
    // commit forced a re-hydrate.
    const source = new BrushBufferMaskSource(
      "clip_1::mask::mask_brush",
      brushRenderer,
    );
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    });

    const renderTexture = Texture.WHITE as never;
    mockGetBrushBuffer.mockReturnValue(
      createBrushBuffer({ paintedBounds: null, renderTexture }),
    );

    source.syncToBuffer();

    expect(source.sprite.visible).toBe(true);
    expect(source.sprite.texture).toBe(renderTexture);
    expect(source.hasFrame()).toBe(true);
  });

  it("stays hidden for a brush mask that has never been painted", () => {
    const source = new BrushBufferMaskSource(
      "clip_1::mask::mask_brush",
      brushRenderer,
    );
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: null,
    });

    mockGetBrushBuffer.mockReturnValue(
      createBrushBuffer({ paintedBounds: null }),
    );

    source.syncToBuffer();

    // An all-black buffer composited as an alpha mask would blank the clip.
    expect(source.sprite.visible).toBe(false);
    expect(source.hasFrame()).toBe(false);
  });

  it("hides a cleared buffer even while the clip still has persisted bounds", () => {
    // Regression: `clearBrushBuffer` empties the buffer synchronously and fills
    // it black, but the clip keeps its persisted bounds until the async flush
    // lands. Falling back to those bounds composited the black texture as the
    // alpha mask, so the masked clip vanished instead of going unmasked — and
    // stayed that way for good if the flush failed.
    const source = new BrushBufferMaskSource(
      "clip_1::mask::mask_brush",
      brushRenderer,
    );
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    });

    mockGetBrushBuffer.mockReturnValue(
      createBrushBuffer({
        paintedBounds: null,
        dirty: true,
        sourceAssetId: null,
        renderTexture: Texture.WHITE as never,
      }),
    );

    source.syncToBuffer();

    expect(source.sprite.visible).toBe(false);
    expect(source.hasFrame()).toBe(false);
  });

  it("releases the texture when its buffer is gone", () => {
    const source = new BrushBufferMaskSource(
      "clip_1::mask::mask_brush",
      brushRenderer,
    );
    mockGetBrushBuffer.mockReturnValue(
      createBrushBuffer({ renderTexture: Texture.WHITE as never }),
    );
    source.syncToBuffer();
    expect(source.sprite.visible).toBe(true);

    // `ensureBrushBuffer` destroys the RenderTexture when it replaces a buffer,
    // so holding the reference would leave the sprite on a destroyed texture.
    mockGetBrushBuffer.mockReturnValue(null);
    source.syncToBuffer();

    expect(source.sprite.visible).toBe(false);
    expect(source.sprite.texture).toBe(Texture.EMPTY);
  });

  it("hydrates using the resolved asset source url", async () => {
    const source = new BrushBufferMaskSource(
      "clip_1::mask::mask_brush",
      brushRenderer,
    );
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    });

    mockEnsureAssetSourceLoaded.mockResolvedValue(
      createAsset({ src: "blob:hydrated-brush-url" }),
    );

    await source.setSource(createAsset());

    expect(mockEnsureAssetSourceLoaded).toHaveBeenCalledWith("brush-asset-1");
    expect(mockHydrateBrushBufferFromUrl).toHaveBeenCalledWith(
      "clip_1::mask::mask_brush",
      "blob:hydrated-brush-url",
      128,
      72,
      { x: 10, y: 12, width: 30, height: 20 },
      brushRenderer,
      "brush-asset-1",
    );
  });

  it("falls back to the passed asset when source hydration returns null", async () => {
    const source = new BrushBufferMaskSource(
      "clip_1::mask::mask_brush",
      brushRenderer,
    );
    source.setHydrationContext({
      canvasWidth: 64,
      canvasHeight: 64,
      paintedBounds: null,
    });

    await source.setSource(createAsset({ src: "blob:existing-brush-url" }));

    expect(mockHydrateBrushBufferFromUrl).toHaveBeenCalledWith(
      "clip_1::mask::mask_brush",
      "blob:existing-brush-url",
      64,
      64,
      null,
      brushRenderer,
      "brush-asset-1",
    );
  });

  it("does not hydrate over a dirty live buffer", async () => {
    const source = new BrushBufferMaskSource(
      "clip_1::mask::mask_brush",
      brushRenderer,
    );
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    });
    mockGetBrushBuffer.mockReturnValue(
      createBrushBuffer({
        dirty: true,
        sourceAssetId: null,
      }),
    );

    await source.setSource(createAsset());

    expect(mockEnsureAssetSourceLoaded).not.toHaveBeenCalled();
    expect(mockHydrateBrushBufferFromUrl).not.toHaveBeenCalled();
  });

  it("reuses a clean live buffer already committed to the same asset", async () => {
    const source = new BrushBufferMaskSource(
      "clip_1::mask::mask_brush",
      brushRenderer,
    );
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    });
    mockGetBrushBuffer.mockReturnValue(
      createBrushBuffer({
        sourceAssetId: "brush-asset-1",
      }),
    );
    mockIsBrushBufferReadyForSource.mockReturnValue(true);

    await source.setSource(createAsset());

    expect(mockEnsureAssetSourceLoaded).not.toHaveBeenCalled();
    expect(mockHydrateBrushBufferFromUrl).not.toHaveBeenCalled();
  });

  it("keeps an initialized edit-session buffer authoritative over newer asset ids", async () => {
    const source = new BrushBufferMaskSource(
      "clip_1::mask::mask_brush",
      brushRenderer,
    );
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    });
    mockIsBrushBufferEditing.mockReturnValue(true);
    mockGetBrushBuffer.mockReturnValue(
      createBrushBuffer({
        sourceAssetId: "brush-asset-1",
      }),
    );

    await source.setSource(createAsset({ id: "brush-asset-2" }));

    expect(mockEnsureAssetSourceLoaded).not.toHaveBeenCalled();
    expect(mockHydrateBrushBufferFromUrl).not.toHaveBeenCalled();
  });

  it("retries hydration when an earlier attempt left behind an empty buffer", async () => {
    const source = new BrushBufferMaskSource(
      "clip_1::mask::mask_brush",
      brushRenderer,
    );
    source.setHydrationContext({
      canvasWidth: 128,
      canvasHeight: 72,
      paintedBounds: { x: 10, y: 12, width: 30, height: 20 },
    });

    mockGetBrushBuffer
      .mockReturnValueOnce(null)
      .mockReturnValue(createBrushBuffer({
        canvasSize: { width: 128, height: 72 },
        paintedBounds: null,
        dirty: false,
      }));
    mockEnsureAssetSourceLoaded
      .mockResolvedValueOnce(createAsset({ src: "blob:first-url" }))
      .mockResolvedValueOnce(createAsset({ src: "blob:second-url" }));
    mockHydrateBrushBufferFromUrl
      .mockRejectedValueOnce(new Error("first hydration failed"))
      .mockResolvedValueOnce(undefined);

    await source.setSource(createAsset());
    await source.setSource(createAsset());

    expect(mockHydrateBrushBufferFromUrl).toHaveBeenNthCalledWith(
      1,
      "clip_1::mask::mask_brush",
      "blob:first-url",
      128,
      72,
      { x: 10, y: 12, width: 30, height: 20 },
      brushRenderer,
      "brush-asset-1",
    );
    expect(mockHydrateBrushBufferFromUrl).toHaveBeenNthCalledWith(
      2,
      "clip_1::mask::mask_brush",
      "blob:second-url",
      128,
      72,
      { x: 10, y: 12, width: 30, height: 20 },
      brushRenderer,
      "brush-asset-1",
    );
  });
});
