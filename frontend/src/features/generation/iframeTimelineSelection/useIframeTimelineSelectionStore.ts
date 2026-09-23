import { create } from "zustand";
import type {
  GeneratedCreationInput,
  GeneratedCreationMetadata,
} from "../../../types/Asset";
import { projectTemporaryFileService } from "../../project/services/ProjectTemporaryFileService";
import { tickToMediaSeconds } from "../../renderer/utils/mediaTime";
import type {
  IframeTemporaryAsset,
  IframeTemporaryAssetRole,
  ProcessedIframeTimelineFrame,
  ProcessedIframeTimelineSelection,
  StoredIframeTimelineFrame,
  StoredIframeTimelineSelection,
} from "./types";

interface IframeTimelineSelectionNodeBinding {
  nodeId: string;
  temporaryAssetId: string;
}

interface IframeTimelineSelectionState {
  assets: IframeTemporaryAsset[];
  nodeBindings: IframeTimelineSelectionNodeBinding[];
  storeProcessedSelection: (
    result: ProcessedIframeTimelineSelection,
  ) => Promise<StoredIframeTimelineSelection>;
  storeProcessedFrame: (
    result: ProcessedIframeTimelineFrame,
  ) => Promise<StoredIframeTimelineFrame>;
  bindNodeToAsset: (nodeId: string, assetId: string) => void;
  /**
   * Drops node→asset bindings without touching the temporary selection assets
   * (which are project-session-scoped and may be re-dropped into a new graph).
   * Node ids are workflow-scoped, so bindings must be cleared when the loaded
   * workflow identity changes or a later generation could adopt stale
   * provenance from a colliding node id.
   */
  clearNodeBindings: () => void;
  clearRuntime: () => void;
}

function revokeUrl(value: string | undefined): void {
  if (value?.startsWith("blob:")) {
    URL.revokeObjectURL(value);
  }
}

function clearAssetUrls(assets: readonly IframeTemporaryAsset[]): void {
  for (const entry of assets) {
    revokeUrl(entry.asset.src);
    revokeUrl(entry.asset.thumbnail);
  }
}

const TEMPORARY_ASSET_NAMES: Record<IframeTemporaryAssetRole, string> = {
  video: "Timeline selection",
  mask: "Timeline selection mask",
  image: "Timeline frame",
};

function createTemporaryAsset(
  id: string,
  role: IframeTemporaryAssetRole,
  file: File,
  sourcePath: string,
  thumbnail: File,
  timelineSelection: ProcessedIframeTimelineSelection["timelineSelection"],
  processing: Pick<
    ProcessedIframeTimelineSelection,
    "maskCropMetadata" | "aspectRatioProcessing"
  >,
): IframeTemporaryAsset {
  const isImage = role === "image";
  const durationTicks = Math.max(
    0,
    ((timelineSelection.anchor + timelineSelection.durationTicks)) - timelineSelection.anchor,
  );
  return {
    role,
    selectionId: id,
    timelineSelection: structuredClone(timelineSelection),
    maskCropMetadata: structuredClone(processing.maskCropMetadata),
    aspectRatioProcessing: processing.aspectRatioProcessing
      ? structuredClone(processing.aspectRatioProcessing)
      : null,
    asset: {
      id: `iframe-selection-${id}-${role}`,
      hash: `temporary-${id}-${role}`,
      name: `${TEMPORARY_ASSET_NAMES[role]} ${id}${isImage ? ".png" : ".mp4"}`,
      type: isImage ? "image" : "video",
      src: URL.createObjectURL(file),
      sourcePath,
      thumbnail: URL.createObjectURL(thumbnail),
      file,
      ...(isImage
        ? {}
        : {
            duration: tickToMediaSeconds(durationTicks),
            fps: timelineSelection.fps,
          }),
      createdAt: Date.now(),
      creationMetadata: {
        source: "extracted",
        timelineSelection: structuredClone(timelineSelection),
      },
    },
  };
}

function createSelectionId(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

export const useIframeTimelineSelectionStore =
  create<IframeTimelineSelectionState>((set, get) => ({
    assets: [],
    nodeBindings: [],

    storeProcessedSelection: async (result) => {
      const selectionId = createSelectionId();
      const videoPath = await projectTemporaryFileService.writeIframeSelectionFile(
        selectionId,
        "video",
        result.video,
      );
      await projectTemporaryFileService.writeIframeSelectionFile(
        selectionId,
        "thumbnail",
        result.thumbnail,
      );
      const videoAsset = createTemporaryAsset(
        selectionId,
        "video",
        result.video,
        videoPath,
        result.thumbnail,
        result.timelineSelection,
        result,
      );

      let maskAsset: IframeTemporaryAsset | null = null;
      if (result.mask) {
        const maskPath =
          await projectTemporaryFileService.writeIframeSelectionFile(
            selectionId,
            "mask",
            result.mask,
          );
        maskAsset = createTemporaryAsset(
          selectionId,
          "mask",
          result.mask,
          maskPath,
          result.maskThumbnail ?? result.thumbnail,
          result.timelineSelection,
          result,
        );
      }

      set((state) => ({
        assets: [videoAsset, ...(maskAsset ? [maskAsset] : []), ...state.assets],
      }));
      return { selectionId, videoAsset, maskAsset };
    },

    storeProcessedFrame: async (result) => {
      const selectionId = createSelectionId();
      const imagePath =
        await projectTemporaryFileService.writeIframeSelectionFile(
          selectionId,
          "image",
          result.image,
        );
      // The frame is its own thumbnail; nothing is cropped or resized.
      const imageAsset = createTemporaryAsset(
        selectionId,
        "image",
        result.image,
        imagePath,
        result.image,
        result.timelineSelection,
        { maskCropMetadata: { mode: "full" }, aspectRatioProcessing: null },
      );
      set((state) => ({ assets: [imageAsset, ...state.assets] }));
      return { selectionId, imageAsset };
    },

    bindNodeToAsset: (nodeId, assetId) => {
      const isTemporaryAsset = get().assets.some(
        (entry) => entry.asset.id === assetId,
      );
      set((state) => ({
        nodeBindings: [
          ...state.nodeBindings.filter((binding) => binding.nodeId !== nodeId),
          ...(isTemporaryAsset
            ? [{ nodeId, temporaryAssetId: assetId }]
            : []),
        ],
      }));
    },

    clearNodeBindings: () => set({ nodeBindings: [] }),

    clearRuntime: () =>
      set((state) => {
        clearAssetUrls(state.assets);
        return { assets: [], nodeBindings: [] };
      }),
  }));

projectTemporaryFileService.onClear(() => {
  useIframeTimelineSelectionStore.getState().clearRuntime();
});

export function getIframeTimelineSelectionCreationInputs(): GeneratedCreationInput[] {
  const { assets, nodeBindings } = useIframeTimelineSelectionStore.getState();
  const assetById = new Map(assets.map((entry) => [entry.asset.id, entry]));

  return nodeBindings.flatMap((binding) => {
    const entry = assetById.get(binding.temporaryAssetId);
    if (!entry) return [];
    return [
      {
        nodeId: binding.nodeId,
        kind: "timelineSelection" as const,
        timelineSelection: structuredClone(entry.timelineSelection),
      },
    ];
  });
}

export function getIframeTimelineSelectionGenerationMetadata(): Pick<
  GeneratedCreationMetadata,
  "inputs" | "maskCropMetadata" | "targetResolution"
> {
  const state = useIframeTimelineSelectionStore.getState();
  const boundAssetIds = new Set(
    state.nodeBindings.map((binding) => binding.temporaryAssetId),
  );
  const primaryEntry =
    state.assets.find(
      (entry) => entry.role === "video" && boundAssetIds.has(entry.asset.id),
    ) ?? state.assets.find((entry) => boundAssetIds.has(entry.asset.id));

  return {
    inputs: getIframeTimelineSelectionCreationInputs(),
    ...(primaryEntry
      ? { maskCropMetadata: structuredClone(primaryEntry.maskCropMetadata) }
      : {}),
    ...(primaryEntry?.aspectRatioProcessing
      ? {
          targetResolution:
            primaryEntry.aspectRatioProcessing.requested.resolution,
        }
      : {}),
  };
}
