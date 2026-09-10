import { Sprite, Texture, type Renderer } from "pixi.js";
import type { Asset } from "../../../types/Asset";
import type { SourceFrameSyncRef } from "../../renderer";
import { ensureAssetSourceLoaded } from "../../userAssets";
import {
  ensureBrushBuffer,
  getBrushBuffer,
  getBrushBufferForRenderer,
  hasBrushContent,
  hydrateBrushBufferFromUrl,
  isBrushBufferEditing,
  isBrushBufferReadyForSource,
  subscribeToBrushBuffer,
} from "./brushBufferRegistry";

/**
 * Asset-mask source for brush masks. Mirrors `MaskVideoFramePlayer`'s public
 * surface (sprite, setSource, renderAt, hasFrame, dispose) so the mask
 * controller can treat brush sources interchangeably with SAM2 video sources.
 *
 * Internally the sprite's texture is the brush buffer's GPU-resident
 * `RenderTexture`. Live painting updates that texture in place, which means
 * the mask compositing pipeline sees strokes immediately — no PNG round-trip.
 *
 * `setSource` here pulls double duty:
 *   - hydrates the buffer from the persisted PNG asset on (re)load if needed,
 *   - rebinds the sprite's texture to the buffer's render texture.
 */
export class BrushBufferMaskSource {
  public readonly sprite: Sprite;

  private readonly maskClipId: string;
  private readonly renderer: Renderer;
  private readonly onFrameReady: (() => void) | undefined;
  private readonly unsubscribe: () => void;

  private currentAssetId: string | null = null;
  private hydrating: Promise<void> | null = null;
  private disposed = false;

  /**
   * Painted-bounds + canvas size used when hydrating from a saved PNG. The
   * mask interaction controller calls `setHydrationContext` before the first
   * `setSource` so the buffer can be reconstructed at the right size.
   */
  private hydrationContext: {
    canvasWidth: number;
    canvasHeight: number;
    paintedBounds:
      | { x: number; y: number; width: number; height: number }
      | null;
  } | null = null;

  constructor(
    maskClipId: string,
    renderer: Renderer,
    onFrameReady?: () => void,
  ) {
    this.maskClipId = maskClipId;
    this.renderer = renderer;
    this.onFrameReady = onFrameReady;
    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5);
    this.sprite.visible = false;
    this.unsubscribe = subscribeToBrushBuffer(maskClipId, () => {
      this.syncToBuffer();
    });
    this.syncToBuffer();
  }

  public setHydrationContext(context: {
    canvasWidth: number;
    canvasHeight: number;
    paintedBounds:
      | { x: number; y: number; width: number; height: number }
      | null;
  }): void {
    this.hydrationContext = context;
  }

  public async setSource(asset: Asset): Promise<void> {
    if (this.disposed) return;
    const ctx = this.hydrationContext;
    const existingBuffer = getBrushBufferForRenderer(
      this.maskClipId,
      this.renderer,
    );
    const liveBufferIsAuthoritative =
      !!existingBuffer &&
      (existingBuffer.dirty ||
        (isBrushBufferEditing(this.maskClipId) &&
          (existingBuffer.paintedBounds !== null ||
            existingBuffer.sourceAssetId !== null)));
    if (liveBufferIsAuthoritative) {
      this.syncToBuffer();
      return;
    }

    if (
      ctx &&
      isBrushBufferReadyForSource(
        this.maskClipId,
        asset.id,
        ctx.canvasWidth,
        ctx.canvasHeight,
        ctx.paintedBounds,
      )
    ) {
      this.currentAssetId = asset.id;
      this.syncToBuffer();
      return;
    }

    if (
      this.currentAssetId === asset.id &&
      this.isBufferReadyForContext(existingBuffer, ctx)
    ) {
      this.syncToBuffer();
      return;
    }

    this.currentAssetId = asset.id;
    if (!ctx) {
      this.syncToBuffer();
      return;
    }

    if (this.hydrating) {
      await this.hydrating;
    }

    const hydratedAsset = await ensureAssetSourceLoaded(asset.id);
    if (this.disposed || this.currentAssetId !== asset.id) {
      return;
    }

    const resolvedAsset = hydratedAsset ?? asset;
    const url = resolvedAsset.src;
    if (!url) {
      ensureBrushBuffer(
        this.maskClipId,
        ctx.canvasWidth,
        ctx.canvasHeight,
        this.renderer,
      );
      this.syncToBuffer();
      return;
    }

    const hydration = hydrateBrushBufferFromUrl(
      this.maskClipId,
      url,
      ctx.canvasWidth,
      ctx.canvasHeight,
      ctx.paintedBounds,
      this.renderer,
      asset.id,
    )
      .then(() => {
        if (this.disposed) return;
        this.syncToBuffer();
        this.onFrameReady?.();
      })
      .catch((error) => {
        console.warn("Brush buffer hydration failed", error);
      })
      .finally(() => {
        this.hydrating = null;
      });
    this.hydrating = hydration;
    await hydration;
  }

  // Brush masks are not time-varying — present for symmetry with the video
  // player so the mask controller can call uniformly.
  public async renderAt(
    sourceFrame: SourceFrameSyncRef,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    void sourceFrame;
    void options;
    return;
  }

  public hasFrame(): boolean {
    const buffer = getBrushBufferForRenderer(
      this.maskClipId,
      this.renderer,
    );
    return hasBrushContent(buffer, this.hydrationContext?.paintedBounds);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    if (!this.sprite.destroyed) {
      this.sprite.destroy();
    }
  }

  /**
   * Rebind the sprite to the current state of the brush buffer.
   *
   * Safe to call every frame, and the mask controller does: nothing else
   * re-runs this on the render path, so a buffer that was momentarily missing
   * (or missing its bounds) used to stay hidden until a timeline commit
   * happened to re-run the hook that re-hydrates it.
   */
  public syncToBuffer(): void {
    if (this.disposed || this.sprite.destroyed) return;
    const buffer = getBrushBufferForRenderer(
      this.maskClipId,
      this.renderer,
    );
    if (!buffer) {
      // The buffer took its RenderTexture with it. Drop our reference so the
      // sprite can never be left holding a destroyed texture.
      this.sprite.texture = Texture.EMPTY;
      this.sprite.visible = false;
      return;
    }

    // The sprite renders the *entire* brush buffer (canvas-sized). Pixels
    // outside the painted region are black, so the red-channel threshold
    // filter ([maskBinaryThresholdFilter.ts]) masks them out automatically —
    // only painted pixels contribute to the alpha mask. Using the full
    // canvas keeps a 1:1 mapping between brush-canvas coords and the
    // mask's clip-content coordinate frame, which makes the layout
    // transforms behave the same as for SAM2.
    if (this.sprite.texture !== buffer.renderTexture) {
      this.sprite.texture = buffer.renderTexture;
    }
    this.sprite.width = buffer.canvasSize.width;
    this.sprite.height = buffer.canvasSize.height;
    this.sprite.visible = hasBrushContent(
      buffer,
      this.hydrationContext?.paintedBounds,
    );
  }

  private isBufferReadyForContext(
    buffer: ReturnType<typeof getBrushBuffer>,
    context: BrushBufferMaskSource["hydrationContext"],
  ): boolean {
    if (!buffer) {
      return false;
    }

    if (buffer.dirty) {
      return false;
    }

    if (!context) {
      return true;
    }

    if (
      buffer.canvasSize.width !== context.canvasWidth ||
      buffer.canvasSize.height !== context.canvasHeight
    ) {
      return false;
    }

    if (!context.paintedBounds) {
      return true;
    }

    const bounds = buffer.paintedBounds;
    return (
      !!bounds &&
      bounds.x === context.paintedBounds.x &&
      bounds.y === context.paintedBounds.y &&
      bounds.width === context.paintedBounds.width &&
      bounds.height === context.paintedBounds.height
    );
  }
}
