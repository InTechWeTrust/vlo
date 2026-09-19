import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { playbackClock } from "../../../../core/playback/PlaybackClock";
import { useExtractStore } from "../../../../core/extract/useExtractStore";
import type {
  MaskTimelineClip,
  MaskActiveRange,
  StandardTimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import type { RangeMaskComponent } from "../../../../types/Components";
import { useProjectStore } from "../../../project";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { useTimelineSelectionStore } from "../../../timelineSelection";
import { useRangeMaskSelection } from "../useRangeMaskSelection";

const track: TimelineTrack = {
  id: "track-1",
  label: "Track",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

function range(
  id: string,
  startSourceTicks = 10,
  endSourceTicks = 20,
  isActive = true,
): RangeMaskComponent {
  return {
    id,
    type: "range_mask",
    parameters: { startSourceTicks, endSourceTicks, isActive },
  };
}

function clip(components: RangeMaskComponent[] = []): StandardTimelineClip {
  return {
    id: "clip-1",
    type: "video",
    name: "Clip",
    assetId: "asset-1",
    trackId: track.id,
    start: 100,
    sourceDuration: 300000,
    timelineDuration: 200000,
    croppedSourceDuration: 200000,
    offset: 0,
    transformedDuration: 200000,
    transformedOffset: 0,
    transformations: [],
    components,
  } as StandardTimelineClip;
}

function mask(activeRange?: { startSourceTicks: number; endSourceTicks: number }) {
  return {
    id: "mask-1",
    type: "mask",
    parentClipId: "clip-1",
    trackId: track.id,
    start: 100,
    timelineDuration: 200000,
    activeRange,
  } as MaskTimelineClip;
}

describe("useRangeMaskSelection", () => {
  beforeEach(() => {
    // Seeds resolve against the clip's presentation footprint, which sits on
    // the project frame grid; 960 fps (100 ticks a frame) keeps the fixture's
    // tick-100 clip start on it.
    useProjectStore.setState((state) => ({
      config: { ...state.config, fps: 960 },
    }));
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [track],
      clips: [clip()],
    });
    useTimelineSelectionStore.getState().exitSelectionMode();
    useTimelineSelectionStore.getState().clearSelectionRecommendations();
    useExtractStore.setState({ onConfirmSelection: null });
    playbackClock.setTime(50000);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  function renderSelectionHook(options: {
    standardSelectedClip?: StandardTimelineClip | null;
    selectedClipId?: string | null;
    selectedMaskId?: string | null;
    selectedMask?: MaskTimelineClip | null;
    updateClipMask?: Mock<
      (
        clipId: string,
        maskId: string,
        updates: { activeRange?: MaskActiveRange | null },
      ) => void
    >;
  } = {}) {
    const updateClipMask =
      options.updateClipMask ??
      vi.fn<
        (
          clipId: string,
          maskId: string,
          updates: { activeRange?: MaskActiveRange | null },
        ) => void
      >();
    const view = renderHook(() =>
      useRangeMaskSelection({
        selectedClipId:
          options.selectedClipId === undefined ? "clip-1" : options.selectedClipId,
        standardSelectedClip:
          options.standardSelectedClip === undefined
            ? (useTimelineStore.getState().clips[0] as StandardTimelineClip)
            : options.standardSelectedClip,
        selectedMaskId: options.selectedMaskId ?? null,
        selectedMask: options.selectedMask ?? null,
        updateClipMask,
      }),
    );
    return { ...view, updateClipMask };
  }

  it("filters range-mask components from the selected clip", () => {
    const selected = clip([range("range-1")]);
    selected.components = [
      ...selected.components!,
      { id: "other", type: "markers", parameters: { markers: [] } },
    ];
    const { result } = renderSelectionHook({
      standardSelectedClip: selected,
    });
    expect(result.current.rangeMaskComponents).toEqual([range("range-1")]);
    expect(result.current.selectedMaskActiveRange).toBeNull();
  });

  it("does nothing without a selected standard clip", () => {
    const { result } = renderSelectionHook({
      selectedClipId: null,
      standardSelectedClip: null,
    });
    act(() => {
      result.current.startAddRangeMask();
      result.current.startEditRangeMask("range");
      result.current.removeRangeMask("range");
      result.current.toggleRangeMaskActive("range");
      result.current.startSetSelectedMaskActiveRange();
      result.current.clearSelectedMaskActiveRange();
    });
    expect(useExtractStore.getState().onConfirmSelection).toBeNull();
  });

  it("starts and commits a new range-mask selection", () => {
    const selected = clip();
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [track],
      clips: [selected],
    });
    const { result } = renderSelectionHook({
      standardSelectedClip: selected,
    });
    act(() => result.current.startAddRangeMask());
    expect(useTimelineSelectionStore.getState()).toMatchObject({
      selectionMode: true,
      selectionStartTick: 50000,
      selectionEndTick: 146000,
    });

    useTimelineSelectionStore.setState({
      selectionStartTick: 1000,
      selectionEndTick: 500,
    });
    act(() => {
      useExtractStore.getState().onConfirmSelection?.();
    });
    const updated = useTimelineStore.getState().clips[0] as StandardTimelineClip;
    expect(updated.components).toContainEqual({
      id: "range_00000000-0000-4000-8000-000000000001",
      type: "range_mask",
      parameters: {
        startSourceTicks: 400,
        endSourceTicks: 900,
        isActive: true,
      },
    });
    expect(useTimelineSelectionStore.getState().selectionMode).toBe(false);
    expect(useExtractStore.getState().onConfirmSelection).toBeNull();
  });

  it("edits, toggles, and removes an existing range mask", () => {
    const selected = clip([range("range-1", 1000, 2000, true)]);
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [track],
      clips: [selected],
    });
    const { result } = renderSelectionHook({
      standardSelectedClip: selected,
    });

    act(() => result.current.startEditRangeMask("missing"));
    expect(useExtractStore.getState().onConfirmSelection).toBeNull();
    act(() => result.current.startEditRangeMask("range-1"));
    expect(useTimelineSelectionStore.getState()).toMatchObject({
      selectionStartTick: 1100,
      selectionEndTick: 2100,
    });
    useTimelineSelectionStore.setState({
      selectionStartTick: 3000,
      selectionEndTick: 5000,
    });
    act(() => useExtractStore.getState().onConfirmSelection?.());
    let updated = useTimelineStore.getState().clips[0] as StandardTimelineClip;
    expect(updated.components?.[0]).toMatchObject({
      parameters: { startSourceTicks: 2900, endSourceTicks: 4900 },
    });

    act(() => result.current.toggleRangeMaskActive("range-1"));
    updated = useTimelineStore.getState().clips[0] as StandardTimelineClip;
    expect(
      (updated.components?.[0] as RangeMaskComponent).parameters.isActive,
    ).toBe(false);
    act(() => result.current.removeRangeMask("range-1"));
    expect(
      (useTimelineStore.getState().clips[0] as StandardTimelineClip).components,
    ).toBeUndefined();
  });

  it("seeds an existing range where a ripple adjustment shows the clip, and keeps it on confirm", () => {
    // A 2x ripple over [0, 1000) pulls the clip stored at 2000 back to 1000.
    const adjustmentTrack: TimelineTrack = {
      id: "track-adjustment",
      type: "adjustment",
      label: "Adjustment",
      isVisible: true,
      isMuted: false,
      isLocked: false,
    };
    const visualTrack: TimelineTrack = { ...track, type: "visual" };
    const ripple = {
      id: "ripple",
      type: "adjustment",
      name: "Ripple",
      trackId: adjustmentTrack.id,
      start: 0,
      timelineDuration: 1000,
      sourceDuration: 2000,
      croppedSourceDuration: 2000,
      transformedDuration: 1000,
      transformedOffset: 0,
      offset: 0,
      transformations: [
        { id: "speed", type: "speed", isEnabled: true, parameters: { factor: 2 } },
      ],
      depth: 1,
      retimingMode: "ripple",
    } as unknown as StandardTimelineClip;
    const selected = {
      ...clip([range("range-1", 500, 700, true)]),
      start: 2000,
    } as StandardTimelineClip;
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [adjustmentTrack, visualTrack],
      clips: [ripple, selected],
    });
    const { result } = renderSelectionHook({ standardSelectedClip: selected });

    act(() => result.current.startEditRangeMask("range-1"));
    expect(useTimelineSelectionStore.getState()).toMatchObject({
      selectionStartTick: 1500,
      selectionEndTick: 1700,
    });
    // Confirming the seeded range unchanged must not move the mask.
    act(() => useExtractStore.getState().onConfirmSelection?.());
    const updated = useTimelineStore
      .getState()
      .clips.find((candidate) => candidate.id === selected.id) as StandardTimelineClip;
    expect(updated.components?.[0]).toMatchObject({
      parameters: { startSourceTicks: 500, endSourceTicks: 700 },
    });
  });

  it("sets and clears an existing selected mask active range", () => {
    const selected = clip();
    const selectedMask = mask({
      startSourceTicks: 1000,
      endSourceTicks: 2000,
    });
    const updateClipMask = vi.fn();
    const { result } = renderSelectionHook({
      standardSelectedClip: selected,
      selectedMaskId: selectedMask.id,
      selectedMask,
      updateClipMask,
    });
    expect(result.current.selectedMaskActiveRange).toEqual(
      selectedMask.activeRange,
    );

    act(() => result.current.startSetSelectedMaskActiveRange());
    useTimelineSelectionStore.setState({
      selectionStartTick: 4000,
      selectionEndTick: 6000,
    });
    act(() => useExtractStore.getState().onConfirmSelection?.());
    expect(updateClipMask).toHaveBeenCalledWith(
      "clip-1",
      "mask-1",
      {
        activeRange: {
          startSourceTicks: 3900,
          endSourceTicks: 5900,
        },
      },
    );
    act(() => result.current.clearSelectedMaskActiveRange());
    expect(updateClipMask).toHaveBeenLastCalledWith(
      "clip-1",
      "mask-1",
      { activeRange: null },
    );
  });

  it("seeds a new selected-mask range from the playhead", () => {
    const selected = clip();
    const selectedMask = mask();
    const { result } = renderSelectionHook({
      standardSelectedClip: selected,
      selectedMaskId: selectedMask.id,
      selectedMask,
    });
    playbackClock.setTime(999999);
    act(() => result.current.startSetSelectedMaskActiveRange());
    expect(useTimelineSelectionStore.getState()).toMatchObject({
      selectionStartTick: 200100,
      selectionEndTick: 200100,
    });
  });
});
