import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPreSaveHook,
  runPreSaveHooks,
} from "../../../core/persistence/preSaveHooks";

const calls: string[] = [];

vi.mock("../../../features/masks/api", () => ({
  flushAllBrushMaskCommits: vi.fn(async () => {
    calls.push("brush-masks");
  }),
}));

vi.mock("../../../features/timeline/api", () => ({
  flushPendingTimelinePersistence: vi.fn(async () => {
    calls.push("timeline");
  }),
  replaceTimelineSnapshot: vi.fn(),
}));

vi.mock("../../../features/composite", () => ({
  installCompositeSessionPersistence: () =>
    registerPreSaveHook(() => {
      calls.push("composite-session");
    }),
}));

vi.mock("../../../features/generation", () => ({
  installGenerationPanelPersistence: () => () => undefined,
  useGenerationStore: { getState: () => ({}) },
  canRegenerateFromAssetMetadata: () => false,
}));

vi.mock("../../../features/userAssets", () => ({
  registerAssetRegenerator: () => () => undefined,
}));

vi.mock("../../../features/modelWork", () => ({
  selectIsLocalModelWorkHoldingGpu: () => false,
  useModelWorkStore: {
    getState: () => ({ connect: () => undefined, disconnect: () => undefined }),
    subscribe: () => () => undefined,
  },
}));

vi.mock("../../../features/project", () => ({
  useProjectStore: Object.assign(() => undefined, {
    getState: () => ({
      timelineSnapshotRequest: null,
      acknowledgeTimelineSnapshotRequest: () => undefined,
    }),
    subscribe: () => () => undefined,
  }),
}));

describe("useEditorOrchestration pre-save order", () => {
  afterEach(() => {
    calls.length = 0;
    vi.resetModules();
  });

  // Painting inside a subtimeline only becomes an asset id on the mask clip
  // when the brush flush materializes it, so a session captured first would
  // save the edit as it stood before its own masks existed.
  it("captures the composite session after brush masks are materialized", async () => {
    const { useEditorOrchestration } = await import("../useEditorOrchestration");
    const { unmount } = renderHook(() => useEditorOrchestration());

    await runPreSaveHooks();

    expect(calls.indexOf("brush-masks")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("composite-session")).toBeGreaterThan(
      calls.indexOf("brush-masks"),
    );
    unmount();
  });
});
