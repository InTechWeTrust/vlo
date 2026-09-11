import { tickToMediaSeconds } from "../../../core/time";
import { captureVideoFrameFile } from "../../../core/media";
import type { Asset } from "../../../types/Asset";
import { addLocalAsset, getAssets } from "../../userAssets/api";
import { resolveExistingAssetForExternalDrop } from "./externalDropAsset";
import {
  useMiniEditorStore,
  type ResolvedEditorSource,
} from "../../miniEditor";

interface DroppedVideoFrameExtractionOptions {
  inputId: string;
  title: string;
  prepare: () => Promise<ResolvedEditorSource>;
  setMediaInputAsset: (inputId: string, asset: Asset) => void;
}

/**
 * Opens a dropped video as a pending image-slot transaction. Nothing is
 * committed until frame extraction succeeds, so closing the editor is a no-op.
 */
export async function openDroppedVideoFrameExtraction({
  inputId,
  title,
  prepare,
  setMediaInputAsset,
}: DroppedVideoFrameExtractionOptions): Promise<void> {
  const openerId = `generation-image-drop:${inputId}`;
  const onExtractFrame = async (
    playheadTicks: number,
    source: ResolvedEditorSource,
  ): Promise<void> => {
    const frame = await captureVideoFrameFile(
      source.sourceUrl,
      tickToMediaSeconds(playheadTicks),
      `generation-frame-${Date.now()}.png`,
    );
    const current = useMiniEditorStore.getState();
    if (
      current._internal.openerId !== openerId ||
      current._internal.onExtractFrame !== onExtractFrame
    ) {
      return;
    }
    // A bare frame File has no replay identity. Persist the captured pixels
    // through normal asset ingestion before making the slot ready to submit.
    const ingestedAsset = await addLocalAsset(
      frame,
      source.assetId
        ? {
            source: "asset_excerpt",
            parentAssetId: source.assetId,
            kind: "frame",
            startTicks: playheadTicks,
            endTicks: playheadTicks,
          }
        : { source: "uploaded" },
    );
    const asset =
      ingestedAsset ??
      (await resolveExistingAssetForExternalDrop(frame, getAssets()));
    if (!asset) {
      throw new Error("Could not save the extracted frame for regeneration.");
    }
    const latest = useMiniEditorStore.getState();
    if (
      latest._internal.openerId !== openerId ||
      latest._internal.onExtractFrame !== onExtractFrame
    ) {
      return;
    }
    setMediaInputAsset(inputId, asset);
    latest.close();
  };

  await useMiniEditorStore.getState().open({
    openerId,
    title: `Extract frame: ${title}`,
    prepare,
    onExtractFrame,
    closeOnExtractionCancel: true,
  });

  // Preparation may have been cancelled while it was in flight. The store
  // guards this transition, so this becomes a no-op after close/escape.
  const current = useMiniEditorStore.getState();
  if (
    current._internal.openerId === openerId &&
    current._internal.onExtractFrame === onExtractFrame
  ) {
    current.beginFrameExtraction();
  }
}
