import { describe, expect, it, vi } from "vitest";
import type { TimelineClip, TimelineTrack } from "../../../../types/TimelineTypes";
import {
  clampedClipSourceTime,
  clampedClipVisualTime,
  clipPresentationFootprint,
  clipSourceTimeToPresentation,
  convertLegacyTimelineSelection,
  createTimelinePlacementMapper,
  getTimelineTime,
  presentationToClipSourceTime,
  projectTimelineSelection,
} from "..";
import { parseTimelineSelection } from "../../../timelineSelection/utils/timelineSelection";
import { buildSelectionProjectData } from "../../../renderer/utils/buildSelectionProjectData";
import { selectionToCompositeContent, compositeContentToSelection } from "../../../timelineSelection/utils/composite";

const tracks: TimelineTrack[] = [
  { id: "track", type: "visual", label: "Video", isVisible: true, isMuted: false, isLocked: false },
];
function video(start = 32000): TimelineClip {
  return {
    id: "clip", trackId: "track", type: "video", assetId: "asset", name: "Video",
    start, timelineDuration: 480000, sourceDuration: 480000,
    croppedSourceDuration: 480000, transformedDuration: 480000,
    transformedOffset: 0, offset: 0, transformations: [],
  };
}

describe("selection replay grids", () => {
  it.each([8, 60, undefined])("uses the project grid independently of render cadence %s", (fps) => {
    const clip = video();
    const selection = parseTimelineSelection({ start: 0, end: 512000, clips: [clip], tracks, fps }, 60)!;
    expect(selection.region.gridFps).toBe(60);
    expect(selection.fps).toBe(fps);
    expect(selection.region.clips[0].start).toBe(32000);
    const detached = buildSelectionProjectData({ clips: [], tracks: [], assets: [], duration: 1, fps: 24 }, selection);
    expect(detached.fps).toBe(60);
    expect(getTimelineTime(detached).sourceAt("clip", 33600)).toBe(1600);
  });

  it("retains the captured grid across selection/composite round trips", () => {
    const clips = [video()];
    const captured = projectTimelineSelection({ start: 0, end: 512000, clips, tracks, fps: 8 }, { clips, tracks, fps: 60 });
    const content = selectionToCompositeContent(captured);
    expect(content).toMatchObject({ gridFps: 60, fps: 8 });
    expect(compositeContentToSelection(content)).toEqual(captured);
  });

  it("replays a legacy selection without end through the remaining five-second clip", () => {
    const clip = video(0);
    const converted = convertLegacyTimelineSelection({ start: 0, clips: [clip], tracks, fps: 8 }, 60);
    expect(converted).toMatchObject({ isPoint: true, durationTicks: 480000 });
    expect(converted.region.clips[0].timelineDuration).toBe(480000);
  });

  it("clears inherited point intent when projecting an explicit range", () => {
    const clips = [video(0)];
    const point = projectTimelineSelection({ start: 0, clips, tracks }, { clips, tracks, fps: 60 });
    expect(point.isPoint).toBe(true);
    const range = projectTimelineSelection({ ...point, start: 0, end: 1600, clips, tracks }, { clips, tracks, fps: 60 });
    expect(range.isPoint).toBeUndefined();
  });

  it("drops malformed saved topology without throwing", () => {
    expect(parseTimelineSelection({ start: 0, clips: [video()], tracks: [null] }, 60)).toBeUndefined();
    const clip = video();
    // A malformed speed transform passes envelope validation but cannot build
    // a presentation mapping. The parser must contain that failure too.
    const malformed = { ...clip, transformations: [{ id: "speed", type: "speed", isEnabled: true, parameters: { factor: { type: "spline", points: [null] } } }] };
    expect(() => parseTimelineSelection({ start: 64000, end: 80000, clips: [malformed], tracks }, 60)).not.toThrow();
    expect(parseTimelineSelection({ start: 64000, end: 80000, clips: [malformed], tracks }, 60)).toBeUndefined();
  });

  it("does not project or clone already-versioned selections during parsing", () => {
    const clips = [video()];
    const saved = projectTimelineSelection({ start: 0, end: 512000, clips, tracks }, { clips, tracks, fps: 60 });
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      expect(parseTimelineSelection(saved, 24)?.region.gridFps).toBe(60);
      expect(clone).not.toHaveBeenCalled();
    } finally { clone.mockRestore(); }
  });
});

describe("authoring snapshot boundaries", () => {
  it("falls back to the clip's own clock when it has left the live snapshot", () => {
    const clip = { ...video(32000), offset: 100, transformedOffset: 100 };
    const empty = getTimelineTime({ clips: [], tracks: [], fps: 60 });
    expect(presentationToClipSourceTime(empty, clip, 33600)).toBe(1700);
    expect(clipSourceTimeToPresentation(empty, clip, 1700)).toBe(33600);
    expect(clipPresentationFootprint(empty, clip)).toEqual({ start: 32000, end: 512000 });
    expect(clampedClipSourceTime(empty, clip, 0)).toBe(100);
    expect(clampedClipVisualTime(empty, clip, 0)).toBe(0);
  });

  it("reads the current mutable draft and isolates subsequent edits", () => {
    const draft = { clips: [video(32000)], tracks: structuredClone(tracks), fps: 60 };
    getTimelineTime(draft);
    draft.clips[0].start = 64000;
    const pinned = createTimelinePlacementMapper(draft);
    draft.clips[0].start = 96000;
    expect(pinned.footprint("clip")?.start).toBe(64000);
    expect(createTimelinePlacementMapper(draft).footprint("clip")?.start).toBe(96000);
  });
});
