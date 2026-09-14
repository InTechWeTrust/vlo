import { beforeEach, describe, expect, it, vi } from "vitest";

import { mediaSecondsToTick } from "../../../../core/time";
import { useMiniEditorStore } from "../../../miniEditor";
import { openDroppedVideoFrameExtraction } from "../droppedVideoFrameExtraction";
import { buildGeneratedCreationInputs, restoreMediaInputsFromMetadata } from "../../store/metadata";
import type { GenerationMediaInputValue, WorkflowInput } from "../../types";

const captureVideoFrameFile = vi.fn();
const addLocalAsset = vi.fn();
const resolveExistingAssetForExternalDrop = vi.fn();
const savedFrame = {
  id: "saved-frame",
  hash: "frame-hash",
  name: "frame.png",
  type: "image" as const,
  src: "frame.png",
  createdAt: 0,
};

vi.mock("../../../userAssets/api", () => ({
  addLocalAsset: (...args: unknown[]) => addLocalAsset(...args),
  getAssets: () => [savedFrame],
  getAssetById: (id: string) => id === savedFrame.id ? savedFrame : undefined,
}));
vi.mock("../externalDropAsset", () => ({
  resolveExistingAssetForExternalDrop: (...args: unknown[]) =>
    resolveExistingAssetForExternalDrop(...args),
}));

vi.mock("../../../../core/media", () => ({
  captureVideoFrameFile: (...args: unknown[]) => captureVideoFrameFile(...args),
}));

describe("openDroppedVideoFrameExtraction", () => {
  beforeEach(() => {
    useMiniEditorStore.getState().close();
    captureVideoFrameFile.mockReset();
    addLocalAsset.mockReset().mockResolvedValue(savedFrame);
    resolveExistingAssetForExternalDrop.mockReset().mockResolvedValue(savedFrame);
  });

  it("opens directly in frame mode and closing leaves the slot unchanged", async () => {
    const setMediaInputAsset = vi.fn();
    const sourceFile = new File(["video"], "clip.mp4", { type: "video/mp4" });

    await openDroppedVideoFrameExtraction({
      inputId: "image-input",
      title: "clip.mp4",
      prepare: async () => ({
        sourceUrl: "blob:clip",
        sourceFile,
        durationTicks: mediaSecondsToTick(4),
      }),
      setMediaInputAsset,
    });

    expect(useMiniEditorStore.getState()).toMatchObject({
      isOpen: true,
      title: "Extract frame: clip.mp4",
      extractionMode: "frame",
      _internal: expect.objectContaining({ closeOnExtractionCancel: true }),
    });

    useMiniEditorStore.getState().close();
    expect(setMediaInputAsset).not.toHaveBeenCalled();
  });

  it("commits the extracted frame and closes the editor on confirmation", async () => {
    const frame = new File(["frame"], "frame.png", { type: "image/png" });
    const setMediaInputAsset = vi.fn();
    captureVideoFrameFile.mockResolvedValue(frame);

    await openDroppedVideoFrameExtraction({
      inputId: "image-input",
      title: "clip.mp4",
      prepare: async () => ({
        sourceUrl: "blob:clip",
        sourceFile: new File(["video"], "clip.mp4", { type: "video/mp4" }),
        durationTicks: mediaSecondsToTick(4),
      }),
      setMediaInputAsset,
    });
    useMiniEditorStore.getState().setPlayhead(mediaSecondsToTick(1.5));

    await useMiniEditorStore.getState().extractFrame();

    expect(captureVideoFrameFile).toHaveBeenCalledWith(
      "blob:clip",
      1.5,
      expect.stringMatching(/^generation-frame-\d+\.png$/),
    );
    expect(addLocalAsset).toHaveBeenCalledWith(frame, { source: "uploaded" });
    expect(setMediaInputAsset).toHaveBeenCalledWith("image-input", savedFrame);
    expect(useMiniEditorStore.getState().isOpen).toBe(false);
  });

  it("persists a library video frame's provenance and replays its saved batch slot", async () => {
    const frame = new File(["frame"], "frame.png", { type: "image/png" });
    captureVideoFrameFile.mockResolvedValue(frame);
    const mediaInputs: Record<string, GenerationMediaInputValue> = {};
    const workflowInputs: WorkflowInput[] = [{
      id: "83:images",
      nodeId: "83",
      classType: "vloMemoryLoadImageBatch",
      inputType: "image",
      param: "images",
      label: "Image inputs",
      currentValue: null,
      origin: "rule",
      presentation: { repeatable: { max: 9 } },
    }];
    const inputId = "83:images::repeat::1";
    await openDroppedVideoFrameExtraction({
      inputId,
      title: "clip.mp4",
      prepare: async () => ({
        assetId: "source-video",
        sourceUrl: "blob:clip",
        sourceFile: new File(["video"], "clip.mp4", { type: "video/mp4" }),
        durationTicks: mediaSecondsToTick(4),
      }),
      setMediaInputAsset: (slotId, asset) => {
        mediaInputs[slotId] = { kind: "asset", asset };
      },
    });
    const playhead = mediaSecondsToTick(1.5);
    useMiniEditorStore.getState().setPlayhead(playhead);
    await useMiniEditorStore.getState().extractFrame();

    expect(addLocalAsset).toHaveBeenCalledWith(frame, {
      source: "asset_excerpt",
      parentAssetId: "source-video",
      kind: "frame",
      startTicks: playhead,
      endTicks: playhead,
    });
    const inputs = buildGeneratedCreationInputs(workflowInputs, mediaInputs);
    expect(inputs).toEqual([{
      nodeId: "83", inputId, kind: "draggedAsset", parentAssetId: savedFrame.id,
    }]);
    const setMediaInputAsset = vi.fn();
    await restoreMediaInputsFromMetadata(
      JSON.parse(JSON.stringify({ inputs })),
      workflowInputs,
      [],
      {
        setMediaInputAsset,
        setMediaInputFrameWithSelection: vi.fn(),
        setMediaInputTimelineSelection: vi.fn(),
        setMediaInputItemOption: vi.fn(),
        setMediaInputItemId: vi.fn(),
      },
    );
    expect(setMediaInputAsset).toHaveBeenCalledWith(inputId, savedFrame);
  });

  it("reuses an already ingested frame", async () => {
    addLocalAsset.mockResolvedValue(null);
    captureVideoFrameFile.mockResolvedValue(new File(["frame"], "frame.png"));
    const setMediaInputAsset = vi.fn();
    await openDroppedVideoFrameExtraction({
      inputId: "image-input",
      title: "clip.mp4",
      prepare: async () => ({
        sourceUrl: "blob:clip",
        sourceFile: new File(["video"], "clip.mp4"),
        durationTicks: mediaSecondsToTick(4),
      }),
      setMediaInputAsset,
    });
    await useMiniEditorStore.getState().extractFrame();
    expect(resolveExistingAssetForExternalDrop).toHaveBeenCalled();
    expect(setMediaInputAsset).toHaveBeenCalledWith("image-input", savedFrame);
  });

  it("does not fill the slot if the editor is closed while the frame is saving", async () => {
    let finishSaving: (asset: typeof savedFrame) => void = () => {};
    addLocalAsset.mockReturnValue(new Promise<typeof savedFrame>((resolve) => {
      finishSaving = resolve;
    }));
    captureVideoFrameFile.mockResolvedValue(new File(["frame"], "frame.png"));
    const setMediaInputAsset = vi.fn();
    await openDroppedVideoFrameExtraction({
      inputId: "image-input",
      title: "clip.mp4",
      prepare: async () => ({
        sourceUrl: "blob:clip",
        sourceFile: new File(["video"], "clip.mp4"),
        durationTicks: mediaSecondsToTick(4),
      }),
      setMediaInputAsset,
    });
    const extraction = useMiniEditorStore.getState().extractFrame();
    await vi.waitFor(() => expect(addLocalAsset).toHaveBeenCalled());
    useMiniEditorStore.getState().close();
    finishSaving(savedFrame);
    await extraction;
    expect(setMediaInputAsset).not.toHaveBeenCalled();
  });
});
