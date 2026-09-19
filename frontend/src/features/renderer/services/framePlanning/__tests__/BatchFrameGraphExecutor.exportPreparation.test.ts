import { describe, expect, it, vi } from "vitest";
import type { Asset } from "../../../../../types/Asset";
import type { TimelineClip } from "../../../../../types/TimelineTypes";
import type { TrackRenderEngine } from "../../TrackRenderEngine";
import { BatchFrameGraphExecutor } from "../BatchFrameGraphExecutor";
import type { FrameJobResolutionResult } from "../FrameJobResolver";
import { buildFrameResolutionGraph } from "../FrameResolutionGraph";
import type { ResolvedClipFrameJob } from "../framePlanningTypes";

const CLIP = {
  id: "clip-1",
  trackId: "track",
  type: "video",
  assetId: "asset-1",
  transformations: [],
} as unknown as TimelineClip;

function videoJob(): ResolvedClipFrameJob {
  return {
    id: "1:track:clip-1",
    trackId: "track",
    activeClip: CLIP,
    effectiveTrackTick: 0,
    rawClipTick: 0,
    sourceFrame: {
      key: "clip-1:0",
      decodeKey: null,
      generation: 1,
      sourceTimeTicks: 0,
    } as ResolvedClipFrameJob["sourceFrame"],
    maskClips: [],
    logicalDimensions: { width: 1920, height: 1080 },
    contentSize: { width: 1920, height: 1080 },
    fps: 30,
  } as unknown as ResolvedClipFrameJob;
}

function resolution(
  job: ResolvedClipFrameJob,
  assets: Asset[],
  engineOverrides: Partial<TrackRenderEngine>,
): FrameJobResolutionResult {
  const engine = {
    presentResolvedFrameJob: vi.fn(async () => true),
    decodeResolvedSourceFrame: vi.fn(async () => null),
    ...engineOverrides,
  } as unknown as TrackRenderEngine;
  return {
    jobs: [job],
    assetsById: new Map(assets.map((asset) => [asset.id, asset])),
    engineByJobId: new Map([[job.id, engine]]),
    trackInputByJobId: new Map([
      [job.id, { trackId: "track", trackClips: [CLIP] }],
    ]),
  } as unknown as FrameJobResolutionResult;
}

describe("BatchFrameGraphExecutor export preparation", () => {
  it("fails the export when project data omits a clip's asset", async () => {
    const job = videoJob();
    const awaitPreparation = vi.fn(async () => {});
    const executor = new BatchFrameGraphExecutor({});

    await expect(
      executor.execute(
        buildFrameResolutionGraph(1, [job]),
        resolution(job, [], {
          prepareResolvedFrameJob: vi.fn(() => false),
          awaitResolvedFrameJobPreparation: awaitPreparation,
        }),
        { mode: "export" },
      ),
    ).rejects.toThrow(
      "Export project data is missing asset 'asset-1' required by clip 'clip-1'",
    );
    // Preparing cannot succeed without the asset, so it is never attempted.
    expect(awaitPreparation).not.toHaveBeenCalled();
    executor.dispose();
  });

  it("awaits preparation when the asset is present but not yet prepared", async () => {
    const job = videoJob();
    const awaitPreparation = vi.fn(async () => {});
    const executor = new BatchFrameGraphExecutor({});

    await executor.execute(
      buildFrameResolutionGraph(1, [job]),
      resolution(job, [{ id: "asset-1", type: "video" } as Asset], {
        prepareResolvedFrameJob: vi.fn(() => false),
        awaitResolvedFrameJobPreparation: awaitPreparation,
      }),
      { mode: "export" },
    );

    expect(awaitPreparation).toHaveBeenCalledOnce();
    executor.dispose();
  });
});
