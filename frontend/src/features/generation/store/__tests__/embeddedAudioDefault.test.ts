import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAssetById } = vi.hoisted(() => ({
  mockGetAssetById: vi.fn(),
}));

vi.mock("../../../userAssets/api", () => ({ getAssetById: mockGetAssetById }));

import { resetZustandStore } from "../../../../testUtils/zustand";
import type { Asset, GeneratedCreationMetadata } from "../../../../types/Asset";
import type { WorkflowInput } from "../../types";
import { useGenerationStore } from "../../useGenerationStore";
import { restoreMediaInputsFromMetadata } from "../metadata";

/**
 * Reference videos in a batch that offers the audio switch deliver their own
 * soundtrack unless the user mutes them. Saved panels and generation metadata
 * record a mute as absence, so a restore has to write it back over the default.
 */

const BATCH_ID = "142:files";
const PLAIN_VIDEO_ID = "7:video";

const BATCH_INPUT: WorkflowInput = {
  id: BATCH_ID,
  nodeId: "142",
  classType: "vloMemoryLoadVideoBatch",
  inputType: "video",
  param: "files",
  label: "Video inputs",
  currentValue: null,
  origin: "rule",
  presentation: { repeatable: { max: 3, itemOptions: ["audio"] } },
};

const PLAIN_VIDEO_INPUT: WorkflowInput = {
  id: PLAIN_VIDEO_ID,
  nodeId: "7",
  classType: "LoadVideo",
  inputType: "video",
  param: "video",
  label: "Video",
  currentValue: null,
  origin: "rule",
};

function video(id: string, hasAudio = true): Asset {
  return {
    id,
    hash: id,
    name: `${id}.mp4`,
    type: "video",
    src: `blob:${id}`,
    createdAt: 1,
    hasAudio,
  } as Asset;
}

const slot = (index: number) =>
  index === 0 ? BATCH_ID : `${BATCH_ID}::repeat::${index}`;

function store() {
  return useGenerationStore.getState();
}

function audioAt(inputId: string): boolean | undefined {
  const value = store().mediaInputs[inputId];
  return value && "includeEmbeddedAudio" in value
    ? value.includeEmbeddedAudio
    : undefined;
}

async function restore(inputs: GeneratedCreationMetadata["inputs"]) {
  await restoreMediaInputsFromMetadata({ inputs }, store().workflowInputs, [], store(), {
    getMediaInputs: () => store().mediaInputs,
  });
}

beforeEach(() => {
  resetZustandStore(useGenerationStore);
  useGenerationStore.setState({
    workflowInputs: [BATCH_INPUT, PLAIN_VIDEO_INPUT],
    mediaInputs: {},
  });
  mockGetAssetById.mockReset();
  mockGetAssetById.mockImplementation((id: string) => video(id));
});

afterEach(() => {
  resetZustandStore(useGenerationStore);
});

describe("reference video audio default", () => {
  it("starts a new reference video with its soundtrack on", () => {
    store().setMediaInputAsset(slot(0), video("a"));

    expect(audioAt(slot(0))).toBe(true);
  });

  it("leaves the switch unset where it is not offered", () => {
    store().setMediaInputAsset(slot(0), video("silent", false));
    store().setMediaInputAsset(PLAIN_VIDEO_ID, video("b"));

    expect(audioAt(slot(0))).toBeUndefined();
    expect(audioAt(PLAIN_VIDEO_ID)).toBeUndefined();
  });

  it("keeps a mute through a preparation rewrite of the same media", () => {
    store().setMediaInputAsset(slot(0), video("a"), { isExtracting: true });
    store().setMediaInputItemOption(slot(0), "audio", false);

    store().setMediaInputAsset(slot(0), video("a"), { isExtracting: false });

    expect(audioAt(slot(0))).toBe(false);
  });

  it("restores a recorded mute over the default", async () => {
    await restore([
      { nodeId: "142", inputId: slot(0), kind: "draggedAsset", parentAssetId: "muted" },
      {
        nodeId: "142",
        inputId: slot(1),
        includeEmbeddedAudio: true,
        kind: "draggedAsset",
        parentAssetId: "loud",
      },
    ]);

    expect(audioAt(slot(0))).toBe(false);
    expect(audioAt(slot(1))).toBe(true);
  });
});
