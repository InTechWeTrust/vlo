import { beforeEach, describe, expect, it, vi } from "vitest";

const renderTimelineSelectionToMp4 = vi.fn();
const renderTimelineSelectionToMp4WithMask = vi.fn();

const renderTimelineSelectionToMaskOutput = vi.fn();

vi.mock("../inputSelection", () => ({
  renderTimelineSelectionToMp4: (...args: unknown[]) =>
    renderTimelineSelectionToMp4(...args),
  renderTimelineSelectionToMp4WithMask: (...args: unknown[]) =>
    renderTimelineSelectionToMp4WithMask(...args),
  renderTimelineSelectionToMaskOutput: (...args: unknown[]) =>
    renderTimelineSelectionToMaskOutput(...args),
}));

import type { ProjectData } from "../../../renderer";
import { useProjectStore } from "../../../project";
import type { ResolvedEditorSource } from "../../../miniEditor";
import type {
  AdjustmentTimelineClip,
  TimelineSelection,
  TimelineTrack,
  VideoTimelineClip,
} from "../../../../types/TimelineTypes";
import { ADJUSTMENT_RETIMING_RIPPLE } from "../../../../types/TimelineTypes";
import type { RangeMaskComponent } from "../../../../types/Components";
import {
  buildEditedTimelineSelection,
  getTimelineSelectionEditorState,
  renderSyntheticEditedOutputs,
} from "../miniEditorEdit";

function createSource(
  overrides: Partial<ResolvedEditorSource> = {},
): ResolvedEditorSource {
  return {
    sourceUrl: "blob:source",
    sourceFile: new File(["v"], "source.mp4", { type: "video/mp4" }),
    durationTicks: 10_000,
    ...overrides,
  };
}

const spec = { cropStartTicks: 0, cropEndTicks: 5_000, ranges: [] };
const dims = { width: 640, height: 480 };

function videoClip(overrides: Partial<VideoTimelineClip> = {}): VideoTimelineClip {
  return {
    id: "clip-1",
    type: "video",
    name: "Video",
    assetId: "asset-1",
    trackId: "track-1",
    start: 10_000,
    timelineDuration: 10_000,
    sourceDuration: 10_000,
    transformedDuration: 10_000,
    transformedOffset: 0,
    croppedSourceDuration: 10_000,
    offset: 0,
    transformations: [],
    ...overrides,
  };
}

function rangeComponent(overrides: Partial<RangeMaskComponent> = {}): RangeMaskComponent {
  return {
    id: "existing-range",
    type: "range_mask",
    parameters: { startSourceTicks: 0, endSourceTicks: 10_000, isActive: true },
    ...overrides,
  };
}

function clipComponents(selection: TimelineSelection, index = 0) {
  const clip = selection.clips[index];
  if (clip.type === "mask") throw new Error("Expected a standard clip");
  return clip.components;
}

describe("timeline selection mini editor round trips", () => {
  const crop = { cropStartTicks: 0, cropEndTicks: 10_000 };

  // Clip placement resolves on the project frame grid; 96 fps is 1000 ticks a
  // frame, so every fixture tick below sits on a frame boundary.
  beforeEach(() => {
    useProjectStore.setState((state) => ({
      config: { ...state.config, fps: 96 },
    }));
  });

  it("restores a full-length mask and replaces it with the smaller edited range", () => {
    const source: TimelineSelection = {
      start: 10_000, end: 20_000, clips: [videoClip()],
    };
    const full = buildEditedTimelineSelection(source, {
      ...crop,
      ranges: [{ id: "full", startSourceTicks: 0, endSourceTicks: 10_000, isActive: true }],
    });
    const reopened = getTimelineSelectionEditorState(full);
    expect(reopened.ranges).toHaveLength(1);
    expect(reopened.ranges[0]).toMatchObject({
      startSourceTicks: 0, endSourceTicks: 10_000, isActive: true,
    });
    expect(clipComponents(reopened.previewSelection)).toEqual([]);

    const smaller = buildEditedTimelineSelection(full, {
      ...crop,
      ranges: [{ ...reopened.ranges[0], startSourceTicks: 2_000, endSourceTicks: 4_000 }],
    });
    expect(clipComponents(smaller)).toHaveLength(1);
    expect(clipComponents(smaller)?.[0].parameters).toMatchObject({
      startSourceTicks: 2_000, endSourceTicks: 4_000,
    });
    const again = getTimelineSelectionEditorState(smaller);
    expect(again.ranges[0]).toMatchObject({ startSourceTicks: 2_000, endSourceTicks: 4_000 });
    const unchanged = buildEditedTimelineSelection(smaller, { ...crop, ranges: again.ranges });
    expect(clipComponents(unchanged)).toHaveLength(1);
    expect(clipComponents(source)).toBeUndefined();
    expect(clipComponents(full)?.[0].parameters).toMatchObject({ endSourceTicks: 10_000 });
  });

  it("deletes existing masks without touching other components or the source snapshot", () => {
    const mask = rangeComponent();
    const spatialMask = { id: "spatial", type: "mask_ref" as const, parameters: { maskClipId: "mask-1" } };
    const source: TimelineSelection = {
      start: 10_000, end: 20_000,
      clips: [videoClip({ components: [mask, spatialMask] })],
    };
    const edited = buildEditedTimelineSelection(source, { ...crop, ranges: [] });
    expect(clipComponents(edited)).toEqual([spatialMask]);
    expect(clipComponents(getTimelineSelectionEditorState(source).previewSelection))
      .toEqual([spatialMask]);
    expect(getTimelineSelectionEditorState(edited).ranges).toEqual([]);
    expect(clipComponents(source)).toEqual([mask, spatialMask]);
  });

  it("keeps disabled ranges editable across saves", () => {
    const source: TimelineSelection = {
      start: 10_000, end: 20_000,
      clips: [videoClip({ components: [rangeComponent({ isEnabled: false })] })],
    };
    const initial = getTimelineSelectionEditorState(source);
    expect(initial.ranges[0].isActive).toBe(false);
    const disabled = buildEditedTimelineSelection(source, { ...crop, ranges: initial.ranges });
    const reopened = getTimelineSelectionEditorState(disabled);
    expect(reopened.ranges).toHaveLength(1);
    expect(reopened.ranges[0].isActive).toBe(false);
    const enabled = buildEditedTimelineSelection(disabled, {
      ...crop, ranges: [{ ...reopened.ranges[0], isActive: true }],
    });
    expect(getTimelineSelectionEditorState(enabled).ranges[0].isActive).toBe(true);
  });

  it("keeps existing masks on their original clip when clips overlap", () => {
    const source: TimelineSelection = {
      start: 10_000, end: 20_000,
      clips: [
        videoClip({ components: [rangeComponent()] }),
        videoClip({ id: "clip-2", components: [rangeComponent()] }),
      ],
    };
    const { ranges } = getTimelineSelectionEditorState(source);
    expect(new Set(ranges.map((range) => range.id)).size).toBe(2);
    const edited = buildEditedTimelineSelection(source, {
      ...crop, ranges: [{ ...ranges[0], endSourceTicks: 3_000 }],
    });
    expect(clipComponents(edited)).toHaveLength(1);
    expect(clipComponents(edited, 1)).toEqual([]);
  });

  it("splits a new range across neighboring clips and restores both portions", () => {
    const source: TimelineSelection = {
      start: 10_000,
      end: 30_000,
      clips: [videoClip(), videoClip({ id: "clip-2", start: 20_000 })],
    };
    const edited = buildEditedTimelineSelection(source, {
      cropStartTicks: 0,
      cropEndTicks: 20_000,
      ranges: [{
        id: "spanning",
        startSourceTicks: 5_000,
        endSourceTicks: 15_000,
        isActive: true,
      }],
    });
    expect(getTimelineSelectionEditorState(edited).ranges).toMatchObject([
      { startSourceTicks: 5_000, endSourceTicks: 10_000 },
      { startSourceTicks: 10_000, endSourceTicks: 15_000 },
    ]);
    const cleared = buildEditedTimelineSelection(edited, {
      cropStartTicks: 0, cropEndTicks: 20_000, ranges: [],
    });
    expect(clipComponents(cleared)).toEqual([]);
    expect(clipComponents(cleared, 1)).toEqual([]);
  });

  it.each([2, -2])("round-trips source timing at speed %s after cropping", (factor) => {
    const source: TimelineSelection = {
      start: 12_000, end: 18_000,
      clips: [videoClip({
        transformedOffset: factor < 0 ? -10_000 : 2_000,
        transformations: [{ id: "speed", type: "speed", isEnabled: true, parameters: { factor } }],
        components: [rangeComponent({
          parameters: { startSourceTicks: 10_000, endSourceTicks: 14_000, isActive: true },
        })],
      })],
    };
    const { ranges } = getTimelineSelectionEditorState(source);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ startSourceTicks: 1_000, endSourceTicks: 3_000 });
    const edited = buildEditedTimelineSelection(source, {
      cropStartTicks: 0, cropEndTicks: 6_000, ranges,
    });
    expect(clipComponents(edited)?.[0].parameters).toMatchObject({
      startSourceTicks: 10_000, endSourceTicks: 14_000,
    });
  });

  it("rebases masks when reopening a cropped selection and leaves out-of-view masks intact", () => {
    const outside = rangeComponent({
      id: "outside", parameters: { startSourceTicks: 8_000, endSourceTicks: 9_000, isActive: true },
    });
    const source: TimelineSelection = {
      start: 10_000, end: 20_000,
      clips: [videoClip({ components: [rangeComponent(), outside] })],
    };
    const cropped = { ...source, start: 12_000, end: 16_000 };
    const { ranges, previewSelection } = getTimelineSelectionEditorState(cropped);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ startSourceTicks: 0, endSourceTicks: 4_000 });
    expect(clipComponents(previewSelection)).toEqual([outside]);
    const edited = buildEditedTimelineSelection(cropped, {
      cropStartTicks: 0, cropEndTicks: 4_000, ranges: [],
    });
    expect(clipComponents(edited)).toEqual([outside]);
  });

  it("maps ranges through a ripple adjustment that shifts the clip", () => {
    // A 2x ripple adjustment over [0, 10k) pulls the clip stored at 30k back
    // to presentation 20k; the selection is taken where the clip is shown.
    const track = (id: string, type: TimelineTrack["type"]): TimelineTrack => ({
      id, type, label: id, isVisible: true, isMuted: false, isLocked: false,
    });
    const tracks = [track("adjustment", "adjustment"), track("track-1", "visual")];
    const ripple: AdjustmentTimelineClip = {
      id: "ripple",
      type: "adjustment",
      name: "Ripple",
      trackId: "adjustment",
      start: 0,
      timelineDuration: 10_000,
      sourceDuration: 20_000,
      croppedSourceDuration: 20_000,
      transformedDuration: 10_000,
      transformedOffset: 0,
      offset: 0,
      transformations: [
        { id: "speed", type: "speed", isEnabled: true, parameters: { factor: 2 } },
      ],
      depth: 1,
      retimingMode: ADJUSTMENT_RETIMING_RIPPLE,
    };
    const source: TimelineSelection = {
      start: 20_000,
      end: 30_000,
      tracks,
      clips: [
        ripple,
        videoClip({
          start: 30_000,
          components: [rangeComponent({
            parameters: { startSourceTicks: 2_000, endSourceTicks: 4_000, isActive: true },
          })],
        }),
      ],
    };

    const { ranges } = getTimelineSelectionEditorState(source);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ startSourceTicks: 2_000, endSourceTicks: 4_000 });

    const edited = buildEditedTimelineSelection(source, {
      ...crop,
      ranges: [{ ...ranges[0], startSourceTicks: 5_000, endSourceTicks: 7_000 }],
    });
    expect(clipComponents(edited, 1)?.[0].parameters).toMatchObject({
      startSourceTicks: 5_000,
      endSourceTicks: 7_000,
    });
  });
});

function renderedProjectData(mock: ReturnType<typeof vi.fn>): ProjectData {
  const options = mock.mock.calls[0].at(-1) as {
    renderInputs: { projectData: ProjectData };
  };
  return options.renderInputs.projectData;
}

describe("renderSyntheticEditedOutputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderTimelineSelectionToMp4.mockResolvedValue(new File(["v"], "video.mp4"));
    renderTimelineSelectionToMp4WithMask.mockResolvedValue({
      video: new File(["v"], "video.mp4"),
      mask: new File(["m"], "mask.mp4"),
      maskHasVisibleContent: true,
    });
    renderTimelineSelectionToMaskOutput.mockResolvedValue({
      file: new File(["s"], "soft-mask.mp4"),
      hasVisibleContent: false,
    });
  });

  // The export renderer resolves clip audio through the asset store by id, so
  // a fabricated id would bake the edit without its soundtrack.
  it("bakes against the library asset's own id so audio resolves", async () => {
    await renderSyntheticEditedOutputs(spec, createSource({ assetId: "asset-1" }), dims);

    const projectData = renderedProjectData(renderTimelineSelectionToMp4);
    expect(projectData.assets[0].id).toBe("asset-1");
    expect(
      (projectData.clips[0] as { assetId?: string }).assetId,
    ).toBe("asset-1");
  });

  it("falls back to a synthetic id when the source has no asset", async () => {
    await renderSyntheticEditedOutputs(spec, createSource(), dims);

    const projectData = renderedProjectData(renderTimelineSelectionToMp4);
    expect(projectData.assets[0].id).toMatch(/^mini_editor_source_/);
  });

  // A workflow with a derived-mask input must receive a matte on every
  // submission; the bake is this input's only render.
  it("renders the requested matte even when no range is active", async () => {
    const result = await renderSyntheticEditedOutputs(spec, createSource(), dims, {
      maskRequests: [{ key: "video_soft", maskType: "soft" }],
    });

    expect(renderTimelineSelectionToMp4).not.toHaveBeenCalled();
    expect(renderTimelineSelectionToMp4WithMask.mock.calls[0][1]).toBe("soft");
    expect(result.masks.video_soft).toBeDefined();
    expect(result.maskContentByKey.video_soft).toBe(true);
  });

  it("carries the mapping's source video treatment into the pair render", async () => {
    await renderSyntheticEditedOutputs(spec, createSource(), dims, {
      maskRequests: [
        {
          key: "video_binary",
          maskType: "binary",
          sourceVideoTreatment: "preserve_transparency",
        },
      ],
    });

    expect(renderTimelineSelectionToMp4WithMask.mock.calls[0][2]).toMatchObject({
      sourceVideoTreatment: "preserve_transparency",
    });
  });

  // Binary and soft mappings on one source are two different mattes.
  it("renders one matte per distinct render key", async () => {
    const result = await renderSyntheticEditedOutputs(spec, createSource(), dims, {
      maskRequests: [
        { key: "video_binary", maskType: "binary" },
        { key: "video_soft", maskType: "soft" },
        { key: "video_binary", maskType: "binary" },
      ],
    });

    expect(renderTimelineSelectionToMp4WithMask).toHaveBeenCalledOnce();
    expect(renderTimelineSelectionToMaskOutput).toHaveBeenCalledOnce();
    expect(result.masks.video_binary?.name).toBe("mask.mp4");
    expect(result.masks.video_soft?.name).toBe("soft-mask.mp4");
    expect(result.maskContentByKey).toEqual({
      video_binary: true,
      video_soft: false,
    });
  });

  it("rejects mappings that disagree on the source video treatment", async () => {
    await expect(
      renderSyntheticEditedOutputs(spec, createSource(), dims, {
        maskRequests: [
          { key: "video_binary", maskType: "binary" },
          {
            key: "video_soft",
            maskType: "soft",
            sourceVideoTreatment: "preserve_transparency",
          },
        ],
      }),
    ).rejects.toThrow(/conflicting source video treatments/);
  });

  it("bakes the ranges into the video when nothing asks for a matte", async () => {
    const result = await renderSyntheticEditedOutputs(spec, createSource(), dims);

    expect(renderTimelineSelectionToMp4WithMask).not.toHaveBeenCalled();
    expect(result.masks).toEqual({});
  });
});
