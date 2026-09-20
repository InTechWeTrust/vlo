import { makeTimelineSelection } from "../../../../testUtils/timelineSelection";
import { describe, expect, it } from "vitest";
import { mediaInputThumbnail } from "../mediaInputThumbnail";
import { buildGenerationMediaItems } from "../generationMediaSnapshot";
import { toSlotValue } from "../../components/generationInputFieldValues";
import { toExtensionAssetSnapshot } from "../../../userAssets/api";
import type { GenerationMediaInputValue, WorkflowInput } from "../../types";
import type { Asset } from "../../../../types/Asset";

const asset: Asset = { id: "video", name: "video.mp4", hash: "hash", type: "video", src: "blob:video", thumbnail: "blob:video-thumb", createdAt: 0 };
const file = new File(["image"], "frame.png", { type: "image/png" });
const values: GenerationMediaInputValue[] = [
  { kind: "asset", asset },
  { kind: "frame", file, previewUrl: "blob:frame" },
  { kind: "timelineSelection", mediaType: "video", timelineSelection: makeTimelineSelection({ start: 0, end: 96_000, clips: [] }), thumbnailFile: file, thumbnailUrl: "blob:range", isExtracting: false, extractionRequestId: 1, extractionError: null, preparedVideoFile: null, preparedMaskFile: null },
];

describe("shared media previews", () => {
  it.each(values)("uses the same $kind preview in native slots and snapshots", (value) => {
    const input: WorkflowInput = { id: "1:file", nodeId: "1", param: "file", classType: "LoadVideo", inputType: value.kind === "frame" ? "image" : "video", label: "Reference", origin: "rule", currentValue: null };
    const items = buildGenerationMediaItems(input, { [input.id!]: value }, new Map([[input.id!, input]]), new Set());
    const thumbnail = mediaInputThumbnail(value, input.inputType);
    expect(thumbnail).toBeTruthy();
    expect(toSlotValue(value, input.inputType)?.thumbnail).toBe(thumbnail);
    expect(items[0].thumbnail).toBe(thumbnail);
  });

  it("publishes the library preview as a detached optional SDK field", () => {
    const snapshot = toExtensionAssetSnapshot(asset);
    expect(snapshot.thumbnail).toBe(asset.thumbnail);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(toExtensionAssetSnapshot({ ...asset, thumbnail: undefined })).not.toHaveProperty("thumbnail");
  });

  it("does not use a video URL as an image or preview unfinished media", () => {
    expect(mediaInputThumbnail({ kind: "asset", asset: { ...asset, thumbnail: undefined } }, "video")).toBeUndefined();
    expect(mediaInputThumbnail({ kind: "asset", asset, isExtracting: true }, "video")).toBeUndefined();
    expect(mediaInputThumbnail({ kind: "asset", asset }, "audio")).toBeUndefined();
  });
});
