import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProjectClosingHooks } from "../../../../core/project/projectLifecycleHooks";
import { projectPersistenceService } from "../../../project/services/ProjectPersistenceService";
import * as timelineApi from "../../../timeline/api";
import type { CompositeSessionDocument } from "../../../project";
import { TICKS_PER_SECOND } from "../../../timeline/constants";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import type {
  CompositeAsset,
  TimelineClip,
  TimelineTrack,
} from "../../../../types/TimelineTypes";
import { useCompositeLibraryStore } from "../../useCompositeLibraryStore";
import { useCompositeTimelineStore } from "../../useCompositeTimelineStore";
import { createCompositeTimelineClip } from "../../utils/createCompositeClip";
import {
  installCompositeSessionPersistence,
  restoreCompositeEditSession,
} from "../compositeSessionPersistence";

const mainTrack: TimelineTrack = {
  id: "main-track",
  label: "Track 1",
  isVisible: true,
  isMuted: false,
  isLocked: false,
};

const innerTrack: TimelineTrack = { ...mainTrack, id: "inner-track" };

const innerClip: TimelineClip = {
  id: "inner-clip",
  type: "image",
  name: "Inner Clip",
  trackId: innerTrack.id,
  start: 0,
  sourceDuration: TICKS_PER_SECOND,
  timelineDuration: TICKS_PER_SECOND,
  croppedSourceDuration: TICKS_PER_SECOND,
  offset: 0,
  transformedDuration: TICKS_PER_SECOND,
  transformedOffset: 0,
  transformations: [],
  assetId: "asset-inner",
};

const composite: CompositeAsset = {
  id: "composite-asset-1",
  name: "Composite",
  content: {
    durationTicks: TICKS_PER_SECOND,
    clips: [innerClip],
    tracks: [innerTrack],
  },
  createdAt: 1,
  updatedAt: 1,
};

const placement = createCompositeTimelineClip({
  id: "placement",
  compositeId: composite.id,
  assetId: "bake",
  durationTicks: composite.content.durationTicks,
  trackId: mainTrack.id,
  start: 0,
});

function sessionDocument(
  session: CompositeSessionDocument["session"],
): CompositeSessionDocument {
  return {
    documentType: "vlo.composite-session",
    schemaVersion: 1,
    updated_at: 0,
    session,
  };
}

function seedMainTimeline(): void {
  useTimelineStore.getState().setTimelinePersistenceSuspended(false);
  useTimelineStore.getState().replaceTimelineSnapshot({
    tracks: [mainTrack],
    clips: [placement],
    transitions: [],
  });
}

describe("compositeSessionPersistence", () => {
  let uninstall: (() => void) | null = null;
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    write = vi
      .spyOn(projectPersistenceService, "writeCompositeSession")
      .mockResolvedValue(undefined as never);
    vi.spyOn(
      projectPersistenceService,
      "readCompositeSession",
    ).mockResolvedValue(sessionDocument(null));

    useCompositeTimelineStore.setState({
      stack: [],
      isBusy: false,
      lastError: null,
    });
    useCompositeLibraryStore.setState({ composites: [composite] });
    seedMainTimeline();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    useCompositeTimelineStore.setState({
      stack: [],
      isBusy: false,
      lastError: null,
    });
    useTimelineStore.getState().setTimelinePersistenceSuspended(false);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("saves the open subtimeline once edits settle", async () => {
    uninstall = installCompositeSessionPersistence();

    expect(
      useCompositeTimelineStore.getState().openCompositeClip(placement.id),
    ).toBe(true);
    useTimelineStore
      .getState()
      .addClip({ ...innerClip, id: "added", start: TICKS_PER_SECOND });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(write).toHaveBeenCalledTimes(1);
    const [session] = write.mock.calls.at(-1) as [
      NonNullable<CompositeSessionDocument["session"]>,
    ];
    expect(session.current.clips.map((clip) => clip.id)).toEqual([
      innerClip.id,
      "added",
    ]);
    expect(session.stack).toHaveLength(1);
    expect(session.stack[0].ownerCompositeAssetId).toBe(composite.id);
    expect(session.stack[0].ownerClipId).toBe(placement.id);
    // The main timeline travels with the session: it is only held in memory
    // while the subtimeline is open.
    expect(session.stack[0].previousSnapshot.clips.map((clip) => clip.id)).toEqual(
      [placement.id],
    );
  });

  it("keeps an untouched blank scene out of the document", async () => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: [mainTrack],
      clips: [],
      transitions: [],
    });
    uninstall = installCompositeSessionPersistence();

    expect(useCompositeTimelineStore.getState().startBlankSubtimeline()).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(write).not.toHaveBeenCalled();
  });

  it("clears the document when the edit returns to the main timeline", async () => {
    const updateCompositeAssetContent = vi.fn().mockResolvedValue(composite);
    useCompositeLibraryStore.setState({ updateCompositeAssetContent });
    uninstall = installCompositeSessionPersistence();

    useCompositeTimelineStore.getState().openCompositeClip(placement.id);
    useTimelineStore
      .getState()
      .addClip({ ...innerClip, id: "added", start: TICKS_PER_SECOND });
    await vi.advanceTimersByTimeAsync(1_000);
    write.mockClear();

    await useCompositeTimelineStore.getState().exitToMainTimeline();
    await vi.advanceTimersByTimeAsync(1_000);

    // Only the clear: the half-exited stack sitting over the restored parent
    // timeline is never recorded as an open edit.
    expect(write.mock.calls).toEqual([[null]]);
  });

  it("leaves the edit on disk and returns the editor to the parent when the project closes", async () => {
    uninstall = installCompositeSessionPersistence();

    useCompositeTimelineStore.getState().openCompositeClip(placement.id);
    useTimelineStore
      .getState()
      .addClip({ ...innerClip, id: "added", start: TICKS_PER_SECOND });

    await runProjectClosingHooks();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).not.toBeNull();
    expect(useCompositeTimelineStore.getState().stack).toEqual([]);
    expect(useTimelineStore.getState().clips.map((clip) => clip.id)).toEqual([
      placement.id,
    ]);

    // A stack carried into the next project would leave its timeline
    // unsaveable, so the suspension lifts with it.
    useTimelineStore.getState().addClip({ ...innerClip, id: "after-close" });
    expect(useTimelineStore.getState().clips).toHaveLength(2);
  });

  // Exiting restores the parent timeline before it awaits publication, so a
  // failed publish leaves the stack describing the composite while the store
  // holds its parent. Recording that would replace a recoverable edit with a
  // subtimeline whose content is its own parent timeline.
  it("keeps the recoverable edit when an exit fails to publish", async () => {
    const updateCompositeAssetContent = vi
      .fn()
      .mockRejectedValue(new Error("disk full"));
    useCompositeLibraryStore.setState({ updateCompositeAssetContent });
    uninstall = installCompositeSessionPersistence();

    useCompositeTimelineStore.getState().openCompositeClip(placement.id);
    useTimelineStore
      .getState()
      .addClip({ ...innerClip, id: "added", start: TICKS_PER_SECOND });
    await vi.advanceTimersByTimeAsync(1_000);
    const saved = write.mock.calls.at(-1)?.[0] as NonNullable<
      CompositeSessionDocument["session"]
    >;
    expect(saved.current.clips.map((clip) => clip.id)).toEqual([
      innerClip.id,
      "added",
    ]);
    write.mockClear();

    await expect(
      useCompositeTimelineStore.getState().exitToMainTimeline(),
    ).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    // The editor is still inside the subtimeline, showing the edit...
    expect(useCompositeTimelineStore.getState().stack).toHaveLength(1);
    expect(useTimelineStore.getState().clips.map((clip) => clip.id)).toEqual([
      innerClip.id,
      "added",
    ]);
    // ...and anything written still describes that edit, never the parent.
    for (const [session] of write.mock.calls as Array<
      [CompositeSessionDocument["session"]]
    >) {
      expect(session?.current.clips.map((clip) => clip.id)).toEqual([
        innerClip.id,
        "added",
      ]);
    }
  });

  // Publishing rewrites the placement through the timeline store, which has a
  // persist debounce of its own. Clearing recovery first would leave a crash in
  // that window pointing the placement at pre-edit content.
  it("clears recovery only once the parent timeline is durable", async () => {
    const updateCompositeAssetContent = vi.fn().mockResolvedValue(composite);
    useCompositeLibraryStore.setState({ updateCompositeAssetContent });
    const order: string[] = [];
    const flush = vi
      .spyOn(timelineApi, "flushPendingTimelinePersistence")
      .mockImplementation(async () => {
        order.push("timeline");
      });
    write.mockImplementation(async () => {
      order.push("session");
      return undefined as never;
    });
    uninstall = installCompositeSessionPersistence();

    useCompositeTimelineStore.getState().openCompositeClip(placement.id);
    useTimelineStore
      .getState()
      .addClip({ ...innerClip, id: "added", start: TICKS_PER_SECOND });
    await vi.advanceTimersByTimeAsync(1_000);
    order.length = 0;

    await useCompositeTimelineStore.getState().exitToMainTimeline();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(write).toHaveBeenLastCalledWith(null);
    expect(order).toEqual(["timeline", "session"]);
    flush.mockRestore();
  });

  it("reopens a saved edit when the project loads", async () => {
    vi.spyOn(
      projectPersistenceService,
      "readCompositeSession",
    ).mockResolvedValue(
      sessionDocument({
        stack: [
          {
            previousSnapshot: {
              tracks: [mainTrack],
              clips: [placement],
              transitions: [],
            },
            ownerCompositeAssetId: composite.id,
            ownerClipId: placement.id,
            name: composite.name,
          },
        ],
        current: {
          tracks: [innerTrack],
          clips: [innerClip, { ...innerClip, id: "unsaved-edit" }],
          transitions: [],
        },
      }),
    );

    await expect(restoreCompositeEditSession()).resolves.toBe(true);

    expect(useCompositeTimelineStore.getState().stack).toHaveLength(1);
    expect(useTimelineStore.getState().clips.map((clip) => clip.id)).toEqual([
      innerClip.id,
      "unsaved-edit",
    ]);
  });

  it("discards a saved edit whose composite is gone", async () => {
    useCompositeLibraryStore.setState({ composites: [] });
    vi.spyOn(
      projectPersistenceService,
      "readCompositeSession",
    ).mockResolvedValue(
      sessionDocument({
        stack: [
          {
            previousSnapshot: {
              tracks: [mainTrack],
              clips: [placement],
              transitions: [],
            },
            ownerCompositeAssetId: composite.id,
            name: composite.name,
          },
        ],
        current: { tracks: [innerTrack], clips: [innerClip], transitions: [] },
      }),
    );

    await expect(restoreCompositeEditSession()).resolves.toBe(false);

    expect(useCompositeTimelineStore.getState().stack).toEqual([]);
    expect(useTimelineStore.getState().clips.map((clip) => clip.id)).toEqual([
      placement.id,
    ]);
    expect(write).toHaveBeenCalledWith(null);
  });
});
