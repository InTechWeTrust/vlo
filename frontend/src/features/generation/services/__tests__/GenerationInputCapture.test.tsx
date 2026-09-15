import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerationPanel } from "../../hooks/useGenerationPanel";
import { createGenerationInputsDraft } from "../../draft/generationInputsDraftController";
import { captureGenerationDraftInput } from "../GenerationInputCapture";
import { useGenerationStore } from "../../useGenerationStore";
import { useAssetStore } from "../../../userAssets";
import { useExtractStore } from "../../../../core/extract/useExtractStore";
import { useTimelineSelectionStore } from "../../../timelineSelection";
import { mountGenerationSession } from "../../../../testUtils/generationSession";
import { resetZustandStore } from "../../../../testUtils/zustand";
import type { GenerationCapturedMedia } from "../../utils/capturedMedia";
import type { WorkflowInput } from "../../types";

const mocks = vi.hoisted(() => ({ frame: vi.fn(), video: vi.fn(), derived: vi.fn(), audio: vi.fn() }));
vi.mock("../../utils/inputSelection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../utils/inputSelection")>(),
  captureFramePngAtTick: mocks.frame,
  renderTimelineSelectionToMp4: mocks.video,
  renderTimelineSelectionToMp4WithDerivedMasks: mocks.derived,
}));
vi.mock("../../utils/manualSlotMedia", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../utils/manualSlotMedia")>(),
  extractAudioFromSelection: mocks.audio,
}));

beforeEach(() => {
  resetZustandStore(useGenerationStore);
  vi.spyOn(useGenerationStore.getState(), "connect").mockImplementation(() => { });
  resetZustandStore(useExtractStore);
  resetZustandStore(useTimelineSelectionStore);
  mocks.frame.mockResolvedValue(new File(["frame"], "frame.png"));
  mocks.video.mockResolvedValue(new File(["video"], "video.mp4"));
  mocks.audio.mockResolvedValue(new File(["audio"], "audio.wav"));
  mocks.derived.mockResolvedValue({
    video: new File(["video"], "video.mp4"),
    masks: { video_binary: new File(["mask"], "mask.mp4") },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetZustandStore(useGenerationStore);
  resetZustandStore(useExtractStore);
  resetZustandStore(useTimelineSelectionStore);
});

describe("mounted panel draft extraction", () => {
  it.each(["image", "video", "audio"] as const)("captures %s with native selection settings and prepared files", async (inputType) => {
    const input: WorkflowInput & { id: string } = {
      id: "10:media", nodeId: "10", param: "media", label: "Reference", inputType,
      classType: "VloBatchMemoryLoader", currentValue: null, origin: "rule",
      dispatch: { kind: "node", selectionConfig: { exportFps: 24, includeTracks: true } },
      presentation: { repeatable: { max: 3, itemOptions: ["audio"] } },
    };
    useGenerationStore.setState({
      workflowInputs: [input], derivedMaskMappings: [{
        sourceInputId: input.id, sourceNodeId: "10", maskNodeId: "11", maskParam: "mask", maskType: "binary",
      }]
    });
    const mounted = mountGenerationSession({
      inputs: [{
        id: input.id, nodeId: input.nodeId, param: input.param, label: input.label, inputType,
        media: [], repeatable: { max: 3, optionIds: inputType === "video" ? ["audio"] : [] },
      }]
    });
    const hook = renderHook(() => useGenerationPanel());
    const draft = createGenerationInputsDraft({ inputIds: [input.id] });
    const stage = vi.spyOn(draft, "stageCapture");
    const ingest = vi.spyOn(useAssetStore.getState(), "addLocalAsset");
    const done = vi.fn();
    let cancel = () => { };
    act(() => { cancel = captureGenerationDraftInput(draft, input.id, 0, done); });
    expect(inputType === "image" ? useExtractStore.getState().frameSelectionMode : useTimelineSelectionStore.getState().selectionMode).toBe(true);
    act(() => useExtractStore.getState().onConfirmSelection?.());
    await waitFor(() => expect(done).toHaveBeenCalledWith(null));
    const capture = stage.mock.calls[0][2] as GenerationCapturedMedia;
    expect(capture.timelineSelection).toBeDefined();
    expect(ingest).not.toHaveBeenCalled();
    expect(useGenerationStore.getState().mediaInputs).toEqual({});
    expect(draft.getSnapshot().inputs[0].media![0].assetId).toBeUndefined();
    if (inputType === "image") {
      expect(capture.kind).toBe("frame");
      expect(mocks.frame).toHaveBeenCalled();
    } else {
      expect(capture.kind).toBe("timelineSelection");
      if (capture.kind !== "timelineSelection") throw new Error("Expected range capture");
      expect(capture.timelineSelection).toMatchObject({ fps: 24 });
      expect(capture.options).toMatchObject({ mediaType: inputType, isExtracting: false });
      if (inputType === "video") {
        expect(mocks.derived).toHaveBeenCalled();
        expect(capture.options?.preparedVideoFile?.name).toBe("video.mp4");
        expect(capture.options?.preparedMaskFile?.name).toBe("mask.mp4");
        expect(capture.options?.preparedDerivedMaskSignature).toBeTruthy();
      } else {
        expect(capture.options?.preparedAudioFile?.name).toBe("audio.wav");
      }
    }
    cancel();
    draft.dispose();
    hook.unmount();
    mounted.unmount();
  });
});
