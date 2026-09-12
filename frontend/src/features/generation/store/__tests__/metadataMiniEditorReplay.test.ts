import { act, renderHook } from "@testing-library/react";
import { useGenerationPanel } from "../../hooks/useGenerationPanel";
import { useMiniEditorStore } from "../../../miniEditor";
import type { MiniEditorOpenArgs } from "../../../miniEditor";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, GeneratedCreationInput, GeneratedMiniEditorEdit } from "../../../../types/Asset";
import type { TimelineSelection, VideoTimelineClip } from "../../../../types/TimelineTypes";
import type { WorkflowInput } from "../../types";
import type { DerivedMaskMapping } from "../../pipeline/types";
import { useAssetStore } from "../../../userAssets/useAssetStore";
import { useProjectStore } from "../../../project";
import { useGenerationStore } from "../../useGenerationStore";
import { buildGeneratedCreationInputs, restoreMediaInputsFromMetadata } from "../metadata";
import { buildEditedTimelineSelection } from "../../utils/miniEditorEdit";
import { bakeMiniEditorVideo } from "../../services/miniEditorReplay";
import { parseGenerationPanelSnapshot } from "../../persistence/generationPanelSnapshot";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(), render: vi.fn(), pair: vi.fn(), mask: vi.fn(), derived: vi.fn(), audio: vi.fn(),
}));
vi.mock("../../utils/inputSelection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../utils/inputSelection")>(),
  captureFramePngAtTick: mocks.capture,
  renderTimelineSelectionToMp4: mocks.render,
  renderTimelineSelectionToMp4WithMask: mocks.pair,
  renderTimelineSelectionToMaskOutput: mocks.mask,
  renderTimelineSelectionToMp4WithDerivedMasks: mocks.derived,
}));
vi.mock("../../../../core/media", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/media")>(),
  captureVideoFrameFile: mocks.capture,
  extractAudioTrackToWav: mocks.audio,
}));

const input: WorkflowInput = {
  id: "53:file", nodeId: "53", classType: "vloMemoryLoadVideo",
  inputType: "video", param: "file", label: "Source", origin: "rule", currentValue: null,
};
const sourceFile = new File(["original"], "source.mp4", { type: "video/mp4" });
const video = new File(["rendered"], "edited.mp4", { type: "video/mp4" });
const thumbnail = new File(["thumb"], "thumb.png", { type: "image/png" });
const mask = new File(["mask"], "mask.mp4", { type: "video/mp4" });
const source: Asset = {
  id: "original-asset", name: "source.mp4", hash: "hash", type: "video",
  src: "blob:original", file: sourceFile, duration: 10, fps: 24, createdAt: 1,
};
const edit: GeneratedMiniEditorEdit = {
  assetId: source.id,
  spec: {
    cropStartTicks: 96_000, cropEndTicks: 480_000,
    ranges: [{ id: "mask-range", startSourceTicks: 192_000, endSourceTicks: 288_000, isActive: true, name: "Face" }],
  },
  render: { width: 1280, height: 720, fps: 24 },
};
const baked: TimelineSelection = { start: 0, end: 384_000, clips: [], bakedSource: true };
const mappings: DerivedMaskMapping[] = [
  { sourceNodeId: "53", sourceInputId: "53:file", maskNodeId: "1", maskParam: "file", maskType: "binary" },
  { sourceNodeId: "53", sourceInputId: "53:file", maskNodeId: "2", maskParam: "file", maskType: "soft" },
];

function current() {
  const value = useGenerationStore.getState().mediaInputs["53:file"];
  if (value?.kind !== "timelineSelection") throw new Error("Expected a selection input");
  return value;
}

async function restore(inputs: GeneratedCreationInput[], masks: DerivedMaskMapping[] = []) {
  const state = useGenerationStore.getState();
  await restoreMediaInputsFromMetadata({ inputs }, state.workflowInputs, masks, state, {
    getMediaInputs: () => useGenerationStore.getState().mediaInputs,
  });
}

function serializeEdit(selection = baked, recipe = edit): GeneratedCreationInput[] {
  useGenerationStore.getState().setMediaInputTimelineSelection("53:file", selection, thumbnail, {
    mediaType: "video", preparedVideoFile: video, bakedEdit: recipe, includeEmbeddedAudio: true,
  });
  const serialized = JSON.parse(JSON.stringify(buildGeneratedCreationInputs(
    [input], useGenerationStore.getState().mediaInputs,
  ))) as GeneratedCreationInput[];
  useGenerationStore.getState().clearMediaInput("53:file");
  return serialized;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(URL, "revokeObjectURL");
  mocks.capture.mockResolvedValue(thumbnail);
  mocks.render.mockResolvedValue(video);
  mocks.pair.mockResolvedValue({ video, mask, maskHasVisibleContent: true });
  mocks.mask.mockResolvedValue({ file: mask, hasVisibleContent: false });
  mocks.derived.mockResolvedValue({ video, masks: { video_binary: mask } });
  mocks.audio.mockResolvedValue(new File(["wav"], "audio.wav", { type: "audio/wav" }));
  useAssetStore.setState({ assets: [source] });
  useGenerationStore.setState({ workflowInputs: [input], mediaInputs: {} });
});

describe("mini editor metadata round trip", () => {
  it("records a mini editor Save and restores its full source and crop on reopening", async () => {
    let opened: MiniEditorOpenArgs | undefined;
    vi.spyOn(useMiniEditorStore.getState(), "open").mockImplementation(async (args) => { opened = args; });
    useMiniEditorStore.setState({ sourceWidth: 1280, sourceHeight: 720 });
    useGenerationStore.getState().setMediaInputAsset("53:file", source);
    const hook = renderHook(() => useGenerationPanel());
    act(() => hook.result.current.handleEditMedia("53:file", "video"));
    expect(opened?.onSave).toBeDefined();
    const resolved = await opened!.prepare();
    await act(async () => { await opened!.onSave!(edit.spec, resolved); });
    const inputs = buildGeneratedCreationInputs([input], useGenerationStore.getState().mediaInputs);
    expect(inputs[0]).toMatchObject({ miniEditorEdit: { assetId: source.id, spec: edit.spec, render: { width: 1280, height: 720 } } });
    act(() => hook.result.current.handleEditMedia("53:file", "video"));
    expect(opened?.initial).toEqual(edit.spec);
    const reopenedSource = await opened!.prepare();
    expect(reopenedSource.sourceFile).toBe(sourceFile);
    expect(reopenedSource.durationTicks).toBe(960_000);
    URL.revokeObjectURL(resolved.sourceUrl);
    URL.revokeObjectURL(reopenedSource.sourceUrl);
    hook.unmount();
  });

  it("replays the same video/matte bake as Save, pinning geometry and fps", async () => {
    const saved = await bakeMiniEditorVideo(edit.spec, {
      assetId: source.id, sourceUrl: source.src, sourceFile, durationTicks: 960_000,
    }, edit.render!, mappings);
    const serialized = serializeEdit();
    expect(serialized[0]).toMatchObject({ miniEditorEdit: edit });
    useProjectStore.setState((state) => ({ config: { ...state.config, fps: 60 } }));
    await restore(serialized, mappings);
    await vi.waitFor(() => expect(current().isExtracting).toBe(false));
    expect(current()).toMatchObject({ ...saved, bakedEdit: edit, includeEmbeddedAudio: true });
    const replayProject = mocks.pair.mock.lastCall?.[2].renderInputs;
    expect(replayProject.projectData.fps).toBe(24);
    expect(replayProject.exportConfig).toMatchObject({ logicalWidth: 1280, logicalHeight: 720 });
    expect(replayProject.projectData.clips[0]).toMatchObject({ assetId: source.id, offset: 96_000, timelineDuration: 384_000 });
    expect(mocks.mask).toHaveBeenCalledTimes(2);
  });

  it.each(["audio", "video"] as const)("restores an audio crop from a %s asset", async (type) => {
    useAssetStore.setState({ assets: [{ ...source, type }] });
    useGenerationStore.setState({ workflowInputs: [{ ...input, inputType: "audio" }] });
    await restore([{ nodeId: "53", kind: "timelineSelection", timelineSelection: baked, miniEditorEdit: edit }]);
    await vi.waitFor(() => expect(current().isExtracting).toBe(false));
    expect(current()).toMatchObject({ mediaType: "audio", bakedEdit: edit, extractionError: null });
    expect(mocks.audio).toHaveBeenCalledTimes(type === "video" ? 2 : 1);
    expect(mocks.audio).toHaveBeenLastCalledWith(
      type === "video" ? await mocks.audio.mock.results[0].value : sourceFile,
      expect.objectContaining({ trim: { start: 1, end: 5 } }),
    );
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("retains and re-applies a detached subtimeline selection before rendering", async () => {
    const clip: VideoTimelineClip = {
      id: "inner-clip", assetId: source.id, trackId: "inner-track", type: "video", name: "Inner",
      start: 0, offset: 0, timelineDuration: 960_000, sourceDuration: 960_000,
      transformedDuration: 960_000, transformedOffset: 0, croppedSourceDuration: 960_000, transformations: [],
    };
    const original: TimelineSelection = {
      start: 0, end: 960_000, clips: [clip], fps: 24, resolution: 720,
      tracks: [{ id: "inner-track", type: "visual", label: "Subtimeline", isVisible: true, isMuted: false, isLocked: false }],
    };
    const recipe = { assetId: null, timelineSelection: original, spec: edit.spec };
    const edited = buildEditedTimelineSelection(original, edit.spec);
    await restore(serializeEdit(edited, recipe));
    await vi.waitFor(() => expect(current().isExtracting).toBe(false));
    expect(mocks.render).toHaveBeenCalledWith(current().timelineSelection);
    expect(current()).toMatchObject({
      timelineSelection: { start: 96_000, end: 480_000, fps: 24, tracks: original.tracks,
        clips: [expect.objectContaining({ assetId: source.id, components: [expect.objectContaining({
          type: "range_mask", parameters: { startSourceTicks: 192_000, endSourceTicks: 288_000, isActive: true, name: "Face" },
        })] })],
      }, bakedEdit: recipe, preparedVideoFile: video,
    });
    expect(current().bakedEdit?.timelineSelection?.end).toBe(960_000);
    expect(current().timelineSelection.end).toBe(480_000);
    expect(original.clips[0]).not.toHaveProperty("components");
    let opened: MiniEditorOpenArgs | undefined;
    vi.spyOn(useMiniEditorStore.getState(), "open").mockImplementation(async (args) => { opened = args; });
    const hook = renderHook(() => useGenerationPanel());
    act(() => hook.result.current.handleEditMedia("53:file", "video"));
    expect(opened?.initial).toEqual(edit.spec);
    const resolved = await opened!.prepare();
    expect(resolved.durationTicks).toBe(960_000);
    await act(async () => {
      await opened!.onSave!({ ...edit.spec, cropEndTicks: 576_000 }, resolved);
    });
    expect(current().timelineSelection).toMatchObject({ start: 96_000, end: 576_000 });
    expect(current().bakedEdit?.timelineSelection).toEqual(original);
    URL.revokeObjectURL(resolved.sourceUrl);
    hook.unmount();
  });

  it("keeps the source and named ranges through project panel JSON parsing", () => {
    const inputs = serializeEdit();
    const snapshot = parseGenerationPanelSnapshot({ version: 1, workflowId: "wf.json", inputs });
    expect(snapshot?.inputs).toEqual(inputs);
  });

  it("reports old baked metadata without trying to render an empty selection", async () => {
    await restore([{ nodeId: "53", kind: "timelineSelection", timelineSelection: baked }]);
    expect(current()).toMatchObject({ isExtracting: false, extractionError: expect.stringContaining("no mini editor source/edit metadata") });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("reports a missing source asset in the input", async () => {
    const inputs = serializeEdit();
    useAssetStore.setState({ assets: [] });
    await restore(inputs);
    await vi.waitFor(() => expect(current().extractionError).toContain("source asset is missing"));
    expect(current().isExtracting).toBe(false);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("does not overwrite an input replaced while its replay was baking", async () => {
    let finish: (file: File) => void = () => {};
    mocks.render.mockReturnValue(new Promise<File>((resolve) => { finish = resolve; }));
    await restore(serializeEdit());
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalled());
    useGenerationStore.getState().setMediaInputAsset("53:file", source);
    const temporaryUrl = mocks.capture.mock.lastCall?.[0];
    vi.mocked(URL.revokeObjectURL).mockClear();
    finish(video);
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith(temporaryUrl));
    expect(useGenerationStore.getState().mediaInputs["53:file"]).toMatchObject({ kind: "asset", asset: source });
  });

  it("releases the temporary source URL after a failed render", async () => {
    mocks.render.mockRejectedValue(new Error("render failed"));
    await restore(serializeEdit());
    await vi.waitFor(() => expect(current().extractionError).toBe("render failed"));
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});
