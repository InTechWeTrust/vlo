import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineClip, TimelineTrack } from "../../../../types/TimelineTypes";
import { useTimelineStore } from "../../useTimelineStore";
import { useProjectStore } from "../../../project";
import { playbackClock } from "../../../../core/playback/PlaybackClock";
import { useTransformationController } from "../../../transformations/hooks/useTransformationController";
import { useGroupKeyframeManager } from "../../../transformations/hooks/useGroupKeyframeManager";

const track = (id: string, type: TimelineTrack["type"]): TimelineTrack => ({ id, type, label: id, isVisible: true, isLocked: false, isMuted: false });
function load() {
  const base = { name: "Clip", start: 0, offset: 0, timelineDuration: 100, sourceDuration: 100, croppedSourceDuration: 100, transformedDuration: 100, transformedOffset: 0 };
  const clips: TimelineClip[] = [
    { ...base, id: "adj", trackId: "adj", type: "adjustment", depth: 1, retimingMode: "ripple", timelineDuration: 50, transformedDuration: 50, transformations: [{ id: "speed", type: "speed", isEnabled: true, parameters: { factor: 2 } }] },
    { ...base, id: "clip", trackId: "visual", type: "video", assetId: "asset", start: 100, transformations: [{ id: "position", type: "position", isEnabled: true, keyframeTimes: [0, 100], parameters: { x: { type: "spline", points: [{ time: 0, value: 0 }, { time: 100, value: 100 }] }, y: 0 } }] },
  ];
  useProjectStore.setState((state) => ({ config: { ...state.config, fps: 96000 } }));
  useTimelineStore.setState({ clips, tracks: [track("adj", "adjustment"), track("visual", "visual")], selectedClipIds: ["clip"] });
  playbackClock.setTime(75);
}
function times() { return useTimelineStore.getState().clips.find((clip) => clip.id === "clip")!.transformations[0].keyframeTimes; }

describe("ripple keyframe authoring", () => {
  beforeEach(load);
  it.each([false, true])("commits at source tick 25 through the panel (batch: %s)", (batch) => {
    const { result } = renderHook(() => useTransformationController());
    act(() => {
      if (batch) result.current.handleCommitMany("position", { x: 42 }, "position");
      else result.current.handleCommit("position", "x", 42, "position");
    });
    expect(times()).toEqual([0, 25, 100]);
  });
  it("toggles the keyframe on the displayed source frame", () => {
    const clip = useTimelineStore.getState().clips[1];
    const { result } = renderHook(() => useGroupKeyframeManager({
      clipId: clip.id, transform: clip.transformations[0],
      group: { id: "position", title: "Position", controls: [{ name: "x", label: "X", type: "number", supportsSpline: true }] },
    }));
    act(() => result.current.toggleKeyframe());
    expect(times()).toEqual([0, 25, 100]);
  });
});
