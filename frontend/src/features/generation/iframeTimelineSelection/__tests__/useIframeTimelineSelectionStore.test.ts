import { makeTimelineSelection } from "../../../../testUtils/timelineSelection";
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectTemporaryFileService } from "../../../project/services/ProjectTemporaryFileService";
import {
  getIframeTimelineSelectionCreationInputs,
  getIframeTimelineSelectionGenerationMetadata,
  useIframeTimelineSelectionStore,
} from "../useIframeTimelineSelectionStore";
import type { ProcessedIframeTimelineSelection } from "../types";

function createResult(withMask: boolean): ProcessedIframeTimelineSelection {
  return {
    timelineSelection: makeTimelineSelection({
      start: 96_000,
      end: 192_000,
      clips: [],
      tracks: [],
      fps: 24,
    }),
    video: new File(["video"], "video.mp4", { type: "video/mp4" }),
    mask: withMask
      ? new File(["mask"], "mask.mp4", { type: "video/mp4" })
      : null,
    thumbnail: new File(["thumb"], "thumb.png", { type: "image/png" }),
    maskThumbnail: withMask
      ? new File(["mask-thumb"], "mask-thumb.png", { type: "image/png" })
      : null,
    aspectRatioProcessing: null,
    maskCropMetadata: { mode: "full" },
    warnings: [],
  };
}

describe("useIframeTimelineSelectionStore", () => {
  beforeEach(() => {
    useIframeTimelineSelectionStore.getState().clearRuntime();
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      (file) => `blob:${(file as File).name}-${Math.random()}`,
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(
      projectTemporaryFileService,
      "writeIframeSelectionFile",
    ).mockImplementation(async (id, role, file) =>
      `.vloproject/temporary/iframe-selections/${id}-${role}-${file.name}`,
    );
  });

  it("stores source and mask assets and carries selection metadata into bound nodes", async () => {
    const stored = await useIframeTimelineSelectionStore
      .getState()
      .storeProcessedSelection(createResult(true));

    expect(useIframeTimelineSelectionStore.getState().assets).toHaveLength(2);
    useIframeTimelineSelectionStore
      .getState()
      .bindNodeToAsset("source-node", stored.videoAsset.asset.id);

    expect(getIframeTimelineSelectionCreationInputs()).toEqual([
      expect.objectContaining({
        nodeId: "source-node",
        kind: "timelineSelection",
        timelineSelection: expect.objectContaining({anchor: 96_000,durationTicks: (192_000) - (96_000)}),
      }),
    ]);
    expect(getIframeTimelineSelectionGenerationMetadata()).toMatchObject({
      maskCropMetadata: { mode: "full" },
      inputs: [
        expect.objectContaining({
          nodeId: "source-node",
          kind: "timelineSelection",
        }),
      ],
    });
  });

  it("clears node bindings on workflow switch without discarding the temporary assets", async () => {
    const stored = await useIframeTimelineSelectionStore
      .getState()
      .storeProcessedSelection(createResult(true));
    const store = useIframeTimelineSelectionStore.getState();
    store.bindNodeToAsset("source-node", stored.videoAsset.asset.id);

    expect(getIframeTimelineSelectionCreationInputs()).toHaveLength(1);

    store.clearNodeBindings();

    // Bindings are gone, but the temporary selection assets remain available to
    // re-drop into the newly loaded workflow.
    expect(getIframeTimelineSelectionCreationInputs()).toEqual([]);
    expect(useIframeTimelineSelectionStore.getState().assets).toHaveLength(2);
  });

  it("clears a stale timeline binding when a regular asset replaces the node", async () => {
    const stored = await useIframeTimelineSelectionStore
      .getState()
      .storeProcessedSelection(createResult(false));
    const store = useIframeTimelineSelectionStore.getState();
    store.bindNodeToAsset("source-node", stored.videoAsset.asset.id);
    store.bindNodeToAsset("source-node", "ordinary-asset");

    expect(getIframeTimelineSelectionCreationInputs()).toEqual([]);
  });

  it("stores a captured frame as an image asset that binds like a selection", async () => {
    const image = new File(["frame"], "frame.png", { type: "image/png" });
    const timelineSelection = makeTimelineSelection({
      start: 48_000,
      end: 48_000,
      clips: [],
      tracks: [],
      fps: 24,
    });

    const stored = await useIframeTimelineSelectionStore
      .getState()
      .storeProcessedFrame({ timelineSelection, image });

    expect(projectTemporaryFileService.writeIframeSelectionFile).toHaveBeenCalledWith(
      stored.selectionId,
      "image",
      image,
    );
    expect(stored.imageAsset.role).toBe("image");
    expect(stored.imageAsset.asset).toMatchObject({
      type: "image",
      file: image,
      name: expect.stringMatching(/\.png$/),
    });
    expect(stored.imageAsset.asset.duration).toBeUndefined();
    expect(useIframeTimelineSelectionStore.getState().assets).toEqual([
      stored.imageAsset,
    ]);

    useIframeTimelineSelectionStore
      .getState()
      .bindNodeToAsset("image-node", stored.imageAsset.asset.id);
    expect(getIframeTimelineSelectionCreationInputs()).toEqual([
      expect.objectContaining({
        nodeId: "image-node",
        kind: "timelineSelection",
        timelineSelection: expect.objectContaining({ anchor: 48_000 }),
      }),
    ]);
  });
});
