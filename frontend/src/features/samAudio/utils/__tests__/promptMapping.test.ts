import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND } from "../../../../core/time/constants";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type { ClipPresentationContext } from "../../../transformations";
import {
  createSamAudioPromptPayload,
  createSpanAnchorsForClip,
} from "../promptMapping";

const clip: TimelineClip = {
  id: "clip-1",
  trackId: "track-1",
  type: "audio",
  name: "Audio",
  assetId: "asset-1",
  start: 100,
  timelineDuration: 200,
  sourceDuration: 500,
  offset: 50,
  croppedSourceDuration: 200,
  transformedOffset: 50,
  transformedDuration: 200,
  transformations: [],
};

// 960 fps is 100 ticks a frame, so the fixture ticks sit on the presentation
// frame grid the overlap is measured on.
const context: ClipPresentationContext = {
  tracks: [],
  clips: [clip],
  fps: 960,
};

describe("SAM-Audio prompt mapping", () => {
  it("returns no anchors when span selection is disabled or disjoint", () => {
    expect(
      createSpanAnchorsForClip(clip, context, {
        selectionMode: false,
        selectionStartTick: 100,
        selectionEndTick: 200,
      }),
    ).toBeUndefined();
    expect(
      createSpanAnchorsForClip(clip, context, {
        selectionMode: true,
        selectionStartTick: 0,
        selectionEndTick: 50,
      }),
    ).toBeUndefined();
    expect(
      createSpanAnchorsForClip(clip, context, {
        selectionMode: true,
        selectionStartTick: 300,
        selectionEndTick: 350,
      }),
    ).toBeUndefined();
  });

  it("normalizes reversed selection and clips it to the media window", () => {
    expect(
      createSpanAnchorsForClip(clip, context, {
        selectionMode: true,
        selectionStartTick: 350,
        selectionEndTick: 150,
      }),
    ).toEqual([[["+", 0.0005208333333333333, 0.0020833333333333333]]]);
  });

  it("uses a minimum source window when persisted duration is zero", () => {
    const zeroWindow = {
      ...clip,
      croppedSourceDuration: 0,
      timelineDuration: 10,
    };
    expect(
      createSpanAnchorsForClip(zeroWindow, { ...context, clips: [zeroWindow] }, {
        selectionMode: true,
        selectionStartTick: 100,
        selectionEndTick: 110,
      }),
    ).toEqual([[["+", 0, 0.000010416666666666666]]]);
  });

  it("builds normalized text, span, and visual prompts", () => {
    const anchors: Array<Array<["+", number, number]>> = [
      [["+", 1, 2]],
    ];
    expect(
      createSamAudioPromptPayload({
        text: "  Barking DOG  ",
        anchors,
        useSpanPrompt: true,
        visualPrompt: {
          sam2SourceId: "source",
          sam2MaskId: "mask",
        },
        useVisualPrompt: true,
      }),
    ).toEqual({
      text: "barking dog",
      anchors,
      sam2SourceId: "source",
      sam2MaskId: "mask",
      rerankingCandidates: 1,
    });
  });

  it("omits blank or disabled optional prompt parts", () => {
    expect(
      createSamAudioPromptPayload({
        text: "   ",
        anchors: [[["+", 1, 2]]],
        useSpanPrompt: false,
        visualPrompt: { sam2SourceId: "source", sam2MaskId: "mask" },
        useVisualPrompt: false,
      }),
    ).toEqual({ rerankingCandidates: 1 });
    expect(
      createSamAudioPromptPayload({
        text: "sound",
        useSpanPrompt: true,
        visualPrompt: null,
        useVisualPrompt: true,
      }),
    ).toEqual({ text: "sound", rerankingCandidates: 1 });
  });

  it("measures overlap where a ripple adjustment shows the clip", () => {
    const second = TICKS_PER_SECOND;
    const track = (id: string, type: "audio" | "adjustment") => ({
      id, type, label: id, isVisible: true, isMuted: false, isLocked: false,
    });
    const ripple: TimelineClip = {
      id: "ripple",
      type: "adjustment",
      name: "Ripple",
      trackId: "track-adjustment",
      start: 0,
      timelineDuration: second,
      sourceDuration: 2 * second,
      croppedSourceDuration: 2 * second,
      transformedDuration: second,
      transformedOffset: 0,
      offset: 0,
      transformations: [
        { id: "speed", type: "speed", isEnabled: true, parameters: { factor: 2 } },
      ],
      depth: 1,
      retimingMode: "ripple",
    };
    // Stored at 2s, shown at [1s, 2s) behind the 2x ripple.
    const shifted: TimelineClip = {
      ...clip,
      trackId: "track-audio",
      start: 2 * second,
      timelineDuration: second,
      sourceDuration: second,
      croppedSourceDuration: second,
      transformedDuration: second,
      offset: 0,
      transformedOffset: 0,
    };
    const rippleContext: ClipPresentationContext = {
      tracks: [track("track-adjustment", "adjustment"), track("track-audio", "audio")],
      clips: [ripple, shifted],
      fps: 30,
    };

    expect(
      createSpanAnchorsForClip(shifted, rippleContext, {
        selectionMode: true,
        selectionStartTick: second,
        selectionEndTick: second + second / 2,
      }),
    ).toEqual([[["+", 0, 0.5]]]);
  });
});
